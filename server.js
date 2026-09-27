const express = require('express');
const bodyParser = require('body-parser');
const { exec, spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');
const http = require('http');
const https = require('https');
const forge = require('node-forge');
const jwt = require('jsonwebtoken');
const db = require('./database');
const open = require('open');
const Updater = require('./Updater');
const axios = require('axios');
const app = express();
const PORT = 3000;
const FORCED_PROXY_TARGET = 'hshm.malakor.online';

const httpsAgent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 10000,
    maxSockets: 64,
    maxFreeSockets: 16,
    timeout: 30000
});
axios.defaults.timeout = 15000;
axios.defaults.httpsAgent = httpsAgent;
axios.defaults.retry = { retries: 2, retryDelay: 500 };

let userDataPath; // This will be set by initializeServer
let _bootChecksInProgress = true;
let _updateCheckInProgress = false;

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/assests', express.static(path.join(__dirname, 'assests')));

// Helper: Check if process is running (Windows) - reliable EXE match + cached
let _processCache = null;
let _processCacheAt = 0;
const PROCESS_CACHE_MS = 2200;

// Status endpoint caches (reduce alloc + network churn on every poll)
let _cachedDiscordUser = null;       // { token, data, at }
const DISCORD_USER_CACHE_MS = 45000;
let _cachedServerOnline = null;      // { url, value, at }
const SERVER_HEALTH_CACHE_MS = 15000;
let _cachedStatusSnapshot = null;    // { value, at, quickSig }
const STATUS_SNAPSHOT_CACHE_MS = 650; // sub-second share for burst / concurrent tabs
let _cachedLogsSnapshot = null;      // { value, at, count }
const LOGS_SNAPSHOT_CACHE_MS = 1800;
const isProcessRunning = (processName) => {
    return new Promise((resolve, reject) => {
        if (!processName) return resolve(false);
        const now = Date.now();
        if (_processCache && (now - _processCacheAt) < PROCESS_CACHE_MS) {
            const exeName = path.basename(processName, path.extname(processName)).toLowerCase();
            return resolve(_processCache.has(exeName));
        }
        const exeName = path.basename(processName, path.extname(processName));
        const exeFull = exeName + (processName.toLowerCase().endsWith('.exe') ? '' : '.exe');
        const cmd = `tasklist /FI "IMAGENAME eq ${exeFull}" /FO CSV /NH 2>nul`;
        exec(cmd, { shell: 'cmd.exe', timeout: 3000 }, (err, stdout, stderr) => {
            if (err) {
                const fallbackCmd = `tasklist /FI "IMAGENAME eq ${exeName}" /FO CSV /NH 2>nul`;
                exec(fallbackCmd, { shell: 'cmd.exe', timeout: 3000 }, (e2, out2) => {
                    resolve(out2 && out2.trim().length > 0 && !out2.toLowerCase().includes('no tasks are running'));
                });
                return;
            }
            const trimmed = (stdout || '').trim();
            const found = trimmed.length > 0 && !trimmed.toLowerCase().includes('no tasks are running') && !trimmed.toLowerCase().includes('information:');
            resolve(found);
        });
    });
};

// Optimized bulk process refresh (for /api/status or polling)
const refreshProcessCache = () => new Promise((resolve) => {
    const now = Date.now();
    if (_processCache && (now - _processCacheAt) < PROCESS_CACHE_MS) return resolve();
    exec(`tasklist /FO CSV /NH 2>nul`, { shell: 'cmd.exe', timeout: 3500, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
        const names = new Set();
        if (!err && stdout) {
            const rows = stdout.split(/\r?\n/);
            for (const row of rows) {
                if (!row) continue;
                const parts = row.split('","');
                if (parts.length < 1) continue;
                let name = parts[0].replace(/^"/, '').toLowerCase();
                const dot = name.lastIndexOf('.exe');
                if (dot > 0) name = name.slice(0, dot);
                if (name) names.add(name);
            }
        }
        _processCache = names;
        _processCacheAt = Date.now();
        resolve();
    });
});

// Multi-check Steam running status - 4-layer fallback pipeline
// Short-TTL result cache: exec() spawns are extremely expensive; avoid them on every poll
let _steamCheckCache = { value: false, at: 0 };
const STEAM_CHECK_TTL_MS = 5500;

const checkSteamRunning = () => new Promise((resolve) => {
    if (process.platform !== 'win32') {
        exec('pgrep -x "steam" 2>/dev/null || true', { timeout: 2500 }, (err, stdout) => {
            resolve(!!(stdout && stdout.trim().length > 0));
        });
        return;
    }

    const now = Date.now();
    if (now - _steamCheckCache.at < STEAM_CHECK_TTL_MS) {
        return resolve(_steamCheckCache.value);
    }

    const steamKeywords = ['steam', 'steamwebhelper', 'steamservice', 'steamerrorreporter', 'steamclient', 'steamcmd', 'steamlauncher', 'steamui', 'steamwebhelper.exe', 'steam.exe'];
    let found = false;
    let checksDone = 0;
    const TOTAL_CHECKS = 4;

    const finalize = () => {
        checksDone++;
        if (found) {
            _steamCheckCache = { value: true, at: Date.now() };
            return resolve(true);
        }
        if (checksDone >= TOTAL_CHECKS) {
            _steamCheckCache = { value: false, at: Date.now() };
            return resolve(false);
        }
    };

    // Layer 1: Fast path - check in _processCache first (no extra exec() if already populated)
    if (_processCache && _processCache.size > 0) {
        for (const procName of _processCache) {
            const lower = String(procName).toLowerCase();
            if (steamKeywords.some(k => lower === k || lower.startsWith(k) || lower.includes(k))) {
                found = true;
                break;
            }
        }
        if (found) {
            _steamCheckCache = { value: true, at: Date.now() };
            return resolve(true);
        }
    }

    // Layer 2: Registry check (most reliable - Steam writes ActiveProcess\pid while running)
    exec('reg query "HKCU\\Software\\Valve\\Steam\\ActiveProcess" /v pid 2>nul', { shell: 'cmd.exe', timeout: 2500 }, (err, stdout) => {
        if (!found && stdout) {
            const outLower = stdout.toLowerCase();
            if (outLower.includes('reg_sz') || outLower.includes('reg_dword')) {
                const match = stdout.match(/pid\s+(reg_sz|reg_dword)\s+([^\r\n]+)/i);
                if (match) {
                    const pidRaw = match[2].trim();
                    let pidNum = 0;
                    if (pidRaw.startsWith('0x')) {
                        pidNum = parseInt(pidRaw, 16);
                    } else {
                        pidNum = parseInt(pidRaw, 10);
                    }
                    if (pidNum && pidNum > 0) found = true;
                } else if (outLower.includes('0x0000') && !outLower.includes('0x00000000')) {
                    found = true;
                }
            }
        }
        finalize();
    });

    // Layer 3: Use _processCache if fresh; otherwise re-run full tasklist
    if (_processCache && (now - _processCacheAt) < PROCESS_CACHE_MS) {
        // cache already checked in Layer 1: just skip re-scan
        finalize();
    } else {
        exec('tasklist /FO CSV /NH 2>nul', { shell: 'cmd.exe', timeout: 3500, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
            if (!found && stdout) {
                const lower = stdout.toLowerCase();
                if (steamKeywords.some(k => lower.includes(`${k}.exe`) || lower.includes(`"${k}.exe"`))) {
                    found = true;
                }
            }
            finalize();
        });
    }

    // Layer 4: Explicit steam.exe filter with multiple case variants + fallback
    exec(`tasklist /FI "IMAGENAME eq steam.exe" /FO CSV /NH 2>nul & tasklist /FI "IMAGENAME eq Steam.exe" /FO CSV /NH 2>nul`, { shell: 'cmd.exe', timeout: 3000 }, (err, stdout) => {
        if (!found && stdout) {
            const trimmed = stdout.trim().toLowerCase();
            if (trimmed.includes('steam.exe') && !trimmed.includes('no tasks are running')) {
                found = true;
            }
        }
        finalize();
    });
});

// Helper: Kill process (Windows)
const killProcess = (processName) => {
    return new Promise((resolve, reject) => {
        if (!processName) return resolve();
        const exeFull = processName.toLowerCase().endsWith('.exe') ? processName : `${processName}.exe`;
        const cmd = `taskkill /F /IM "${exeFull}" /T`;
        exec(cmd, { timeout: 8000 }, (err, stdout, stderr) => {
            _processCache = null;
            resolve();
        });
    });
};

const HOSTS_FILE = process.platform === 'win32' 
    ? 'C:\\Windows\\System32\\drivers\\etc\\hosts' 
    : '/etc/hosts';
const TARGET_DOMAINS = [
    'api.homesweethomegame.com',
    'hshsapi.homesweethomegame.com',
    'logapi.homesweethomegame.com',
    'boatltpk'
];

// Hosts status cache state (declared early so modifyHostsFile can invalidate)
let _cachedHostsStatus = null;
let _cachedHostsStatusAt = 0;
let _cachedHostsStatusSig = '';
const HOSTS_STATUS_TTL_MS = 20000;
const invalidateHostsStatusCache = () => { _cachedHostsStatus = null; _cachedHostsStatusAt = 0; };
const KNOWN_ENDPOINTS = [
    "/live/player/authen",
    "/live/player/inventory/getAll",
    "/live/player/gameplay/checkversion",
    "/live/player/curserelic/get",
    "/live/player/characterslot/edit",
    "/live/player/characterslot/get",
    "/live/player/playerstat/get",
    "/live/player/getban",
    "/live/player/profile/edit",
    "/live/player/sticker/edit",
    "/live/player/gameplay/endgameresult",
    "/live/player/gameplay/authenstatus",
    "/live/player/gameplay/callback",
    "/live/player/gameplay/endgamestatus",
    "/live/productlisting/list",
    "/live/item/listall",
    "/live/store/list",
    "/live/store/productlisting/list/tag",
    "/live/immortal/player/get",
    "/live/immortal/player/getmatch",
    "/live/immortal/get",
    "/live/bonus/api/get_bonus_data",
    "/live/mailbox/get",
    "/live/gacha/static/api/banner",
    "/live/treasure/api/progress/get",
    "/logapi/v1/check/penalty",
    "/logapi/v1/add/matchlog",
    "/logapi/v1/add/ingame",
    "/logapi/v1/add/errorlog",
    "/logapi/v1/check/serverdetect"
];
const SECRET_KEY = "malakor-secret-key-123"; // Use a strong key in production

let proxyServer = null;       // HTTPS :443
let httpProxyServer = null;   // HTTP  :80  (for boatltpk HTTP fallback)
let _proxyClosingPromise = null;
let _httpProxyClosingPromise = null;
let _lastGamePid = 0;
let _gameMonitorTimer = null;
const _LAUNCH_MUTEX = { running: false };
let proxyLogs = [];

// Helper: Add Log (Declared BEFORE setupHttpsOptions to avoid ReferenceError)
const LOG_MAX = 30;
let _lastProxyLogMsg = '';
let _lastProxyLogCount = 0;
const addProxyLog = (message) => {
    const ts = new Date().toLocaleTimeString();
    const trimmedMsg = String(message || '').slice(0, 320);
    const log = `[${ts}] ${trimmedMsg}`;
    const isSame = (trimmedMsg === _lastProxyLogMsg);
    if (isSame) {
        _lastProxyLogCount++;
        if (_lastProxyLogCount < 2) console.log(log);
        const lastIdx = proxyLogs.length - 1;
        if (lastIdx >= 0 && proxyLogs[lastIdx].startsWith(`[${ts}] ` + _lastProxyLogMsg)) {
            proxyLogs[lastIdx] = `[${ts}] ${trimmedMsg}` + (_lastProxyLogCount > 1 ? ` (x${_lastProxyLogCount})` : '');
        } else {
            proxyLogs.push(log + (_lastProxyLogCount > 1 ? ` (x${_lastProxyLogCount})` : ''));
        }
        if (proxyLogs.length > LOG_MAX) proxyLogs.splice(0, proxyLogs.length - LOG_MAX);
        return;
    }
    _lastProxyLogMsg = trimmedMsg;
    _lastProxyLogCount = 1;
    console.log(log);
    proxyLogs.push(log);
    if (proxyLogs.length > LOG_MAX) proxyLogs.splice(0, proxyLogs.length - LOG_MAX);
};

// --- HTTPS Options (Will be set by PFX or Generated) ---
let httpsOptions = null;

const setupHttpsOptions = () => {
    return new Promise((resolve, reject) => {
        try {
            const pfxPath = path.resolve(userDataPath, 'game_cert.pfx');
            if (fs.existsSync(pfxPath)) {
                console.log("Using MANUAL PFX Certificate from Dropbox...");
                httpsOptions = {
                    pfx: fs.readFileSync(pfxPath),
                    passphrase: '' // As per user instruction (No password)
                };
                addProxyLog("HTTPS Server using Manual PFX Certificate.");
                return resolve(true);
            }
            
            // Fallback to generated cert if PFX doesn't exist
            console.log("PFX not found, using fallback generated cert...");
            resolve(false);
        } catch (e) {
            console.error("Error setting up HTTPS options:", e);
            reject(e);
        }
    });
};

const generateAndInstallCertificate = (forceManual = false, cleanOld = false) => {
    const CA_KEY_PATH = path.resolve(userDataPath, 'root-ca.key');
    const CA_CERT_PATH = path.resolve(userDataPath, 'root-ca.crt');
    
    return new Promise(async (resolve, reject) => {
        try {
            addProxyLog(`[Cert] Starting generation. Force manual: ${forceManual}, Clean old: ${cleanOld}`);

            // 1. Clean up old certificates if requested
            if (cleanOld && process.platform === 'win32') {
                addProxyLog("[Cert] Cleaning up old 'Malakor Proxy' and 'Fiddler' certificates...");
                try {
                    const { execSync } = require('child_process');
                    const psCleanup = `
                        $stores = "Cert:\\CurrentUser\\Root", "Cert:\\LocalMachine\\Root", "Cert:\\CurrentUser\\My", "Cert:\\LocalMachine\\My", "Cert:\\CurrentUser\\AuthRoot", "Cert:\\LocalMachine\\AuthRoot"
                        foreach ($store in $stores) {
                            if (Test-Path $store) {
                                Get-ChildItem $store | Where-Object { 
                                    $_.Subject -like '*Malakor Proxy*' -or 
                                    $_.Issuer -like '*Malakor Proxy*' -or 
                                    $_.Subject -like '*DO_NOT_TRUST_FiddlerRoot*' -or
                                    $_.Issuer -like '*DO_NOT_TRUST_FiddlerRoot*'
                                } | ForEach-Object {
                                    Remove-Item $_.PSPath -Force -ErrorAction SilentlyContinue
                                }
                            }
                        }
                    `;
                    // Use a safer way to run multi-line PS command
                    const b64Command = Buffer.from(psCleanup, 'utf16le').toString('base64');
                    execSync(`powershell -ExecutionPolicy Bypass -EncodedCommand ${b64Command}`, { stdio: 'ignore' });
                    
                    const targets = ["Malakor Proxy", "Malakor Proxy Root CA", "DO_NOT_TRUST_FiddlerRoot"];
                    targets.forEach(t => {
                        try { execSync(`certutil -delstore -user Root "${t}"`, { stdio: 'ignore' }); } catch(e){}
                        try { execSync(`certutil -delstore Root "${t}"`, { stdio: 'ignore' }); } catch(e){}
                    });
                    
                    addProxyLog("[Cert] Old certificates cleanup completed.");
                } catch (e) { 
                    addProxyLog(`[Cert] WARN: Cleanup failed. ${e.message}`);
                }
            }

            // 2. Check for manual PFX
            const hasPfx = await setupHttpsOptions().catch(() => false);
            const pfxPath = path.resolve(userDataPath, 'game_cert.pfx');

            if (hasPfx && cleanOld && process.platform === 'win32') {
                addProxyLog("[Cert] PFX file found. Attempting to auto-install...");
                try {
                    const { execSync } = require('child_process');
                    execSync(`certutil -importpfx -f -user Root "${pfxPath}" ""`, { stdio: 'ignore' });
                    addProxyLog("[Cert] PFX certificate auto-installed successfully.");
                    return resolve({ success: true, manual: false, message: "PFX Auto-Installed" });
                } catch (e) {
                    addProxyLog(`[Cert] WARN: PFX auto-install failed. ${e.message}`);
                    await open(pfxPath);
                    return resolve({ success: true, manual: true, message: "Please install the opened PFX (No password)." });
                }
            }

            if (hasPfx && !cleanOld) {
                addProxyLog("[Cert] Using existing PFX file.");
                return resolve({ success: true, manual: false, message: "Using manual PFX" });
            }

            // 3. Generate or load Root CA
            let caKey, caCert;
            let needsNewCA = cleanOld;
            
            if (fs.existsSync(CA_KEY_PATH) && fs.existsSync(CA_CERT_PATH) && !cleanOld) {
                try {
                    caKey = forge.pki.privateKeyFromPem(fs.readFileSync(CA_KEY_PATH, 'utf8'));
                    caCert = forge.pki.certificateFromPem(fs.readFileSync(CA_CERT_PATH, 'utf8'));
                    
                    // CRITICAL: Check if the existing CA has the necessary AKI/SKI extensions
                    // If it's the old version without these, we MUST regenerate it to fix Error Code 3.
                    const aki = caCert.getExtension('authorityKeyIdentifier');
                    if (!aki) {
                        addProxyLog("[Cert] Existing CA is missing AKI extension. Forcing regeneration...");
                        needsNewCA = true;
                    } else {
                        addProxyLog("[Cert] Using existing Root CA files (Validated).");
                    }
                } catch (e) {
                    addProxyLog(`[Cert] Failed to load existing CA: ${e.message}. Regenerating...`);
                    needsNewCA = true;
                }
            } else {
                needsNewCA = true;
            }

            if (needsNewCA) {
                addProxyLog("[Cert] Generating new Root CA...");
                const caKeys = forge.pki.rsa.generateKeyPair(2048);
                caCert = forge.pki.createCertificate();
                caCert.publicKey = caKeys.publicKey;
                // Serial number should be hex string
                caCert.serialNumber = forge.util.bytesToHex(forge.random.getBytesSync(16));
                caCert.validity.notBefore = new Date();
                caCert.validity.notBefore.setDate(caCert.validity.notBefore.getDate() - 1);
                caCert.validity.notAfter = new Date();
                caCert.validity.notAfter.setFullYear(caCert.validity.notBefore.getFullYear() + 10);

                const caAttrs = [
                    { name: 'commonName', value: 'Malakor Proxy Root CA' },
                    { name: 'organizationName', value: 'Malakor Proxy' },
                    { name: 'organizationalUnitName', value: 'Root CA' },
                    { name: 'countryName', value: 'TH' }
                ];
                caCert.setSubject(caAttrs);
                caCert.setIssuer(caAttrs);
                const caSKI = caCert.generateSubjectKeyIdentifier().data;
                caCert.setExtensions([
                    { name: 'basicConstraints', cA: true, critical: true },
                    { name: 'keyUsage', keyCertSign: true, digitalSignature: true, cRLSign: true, critical: true },
                    { name: 'subjectKeyIdentifier', subjectKeyIdentifier: caSKI },
                    { name: 'authorityKeyIdentifier', keyIdentifier: caSKI }
                ]);
                caCert.sign(caKeys.privateKey, forge.md.sha256.create());

                fs.writeFileSync(CA_KEY_PATH, forge.pki.privateKeyToPem(caKeys.privateKey));
                fs.writeFileSync(CA_CERT_PATH, forge.pki.certificateToPem(caCert));
                caKey = caKeys.privateKey;
                addProxyLog("[Cert] New Root CA generated.");
            }

            // 4. Generate Site Certificate
            addProxyLog("[Cert] Generating site certificate...");
            const siteKeys = forge.pki.rsa.generateKeyPair(2048);
            const siteCert = forge.pki.createCertificate();
            siteCert.publicKey = siteKeys.publicKey;
            siteCert.serialNumber = forge.util.bytesToHex(forge.random.getBytesSync(16));
            siteCert.validity.notBefore = new Date();
            siteCert.validity.notBefore.setDate(siteCert.validity.notBefore.getDate() - 1);
            siteCert.validity.notAfter = new Date();
            siteCert.validity.notAfter.setFullYear(siteCert.validity.notBefore.getFullYear() + 2);

            const siteAttrs = [
                { name: 'commonName', value: TARGET_DOMAINS[0] },
                { name: 'organizationName', value: 'Malakor Proxy' },
                { name: 'organizationalUnitName', value: 'SSL Terminal' }
            ];
            siteCert.setSubject(siteAttrs);
            siteCert.setIssuer(caCert.subject.attributes);
            
            const caSKI_for_site = caCert.generateSubjectKeyIdentifier().data;
            
            siteCert.setExtensions([
                { 
                    name: 'subjectAltName', 
                    altNames: [
                        ...TARGET_DOMAINS.map(domain => ({ type: 2, value: domain })),
                        { type: 7, ip: '127.0.0.1' }
                    ]
                },
                { name: 'basicConstraints', cA: false, critical: true },
                { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, dataEncipherment: true, critical: true },
                { name: 'extKeyUsage', serverAuth: true, clientAuth: true },
                { name: 'authorityKeyIdentifier', keyIdentifier: caSKI_for_site },
                { name: 'subjectKeyIdentifier', subjectKeyIdentifier: siteCert.generateSubjectKeyIdentifier().data }
            ]);
            siteCert.sign(caKey, forge.md.sha256.create());

            httpsOptions = {
                key: forge.pki.privateKeyToPem(siteKeys.privateKey),
                cert: forge.pki.certificateToPem(siteCert)
            };
            addProxyLog("[Cert] Site certificate generated.");

            // 5. Install Root CA on Windows
            if (process.platform === 'win32') {
                let installed = false;
                try {
                    const { execSync } = require('child_process');
                    const checkCert = execSync(`certutil -verifystore -user Root "Malakor Proxy Root CA"`, { encoding: 'utf8', stdio: 'pipe' });
                    if (checkCert.includes("Certificate is valid")) {
                        addProxyLog("[Cert] Root CA is already installed in User store.");
                        installed = true;
                    }
                } catch (e) { /* Not installed */ }

                if (!installed || forceManual || cleanOld) {
                    addProxyLog("[Cert] Attempting to auto-install Root CA...");
                    try {
                        execSync(`certutil -addstore -f -user Root "${CA_CERT_PATH}"`, { stdio: 'ignore' });
                        addProxyLog("[Cert] Root CA installed to User store.");
                        try {
                            execSync(`certutil -addstore -f Root "${CA_CERT_PATH}"`, { stdio: 'ignore' });
                            addProxyLog("[Cert] Root CA installed to Machine store.");
                        } catch (e) { 
                            addProxyLog("[Cert] WARN: Could not install to Machine Store (requires elevated admin), but User Store should suffice.");
                        }
                        installed = true;
                    } catch (e) {
                        addProxyLog(`[Cert] ERROR: Auto-installation failed. ${e.message}`);
                    }
                }

                if (!installed || forceManual) {
                    addProxyLog("[Cert] Auto-install failed or was forced. Opening certificate for manual installation.");
                    await open(CA_CERT_PATH);
                    resolve({ 
                        success: true, 
                        manual: true,
                        message: "Could not auto-install. Please install the opened Root CA to 'Trusted Root Certification Authorities'." 
                    });
                } else {
                    addProxyLog("[Cert] Certificate setup completed successfully.");
                    resolve({ success: true, manual: false });
                }
            } else {
                addProxyLog("[Cert] Skipping Windows-specific installation on non-Windows OS.");
                resolve({ success: true }); 
            }
        } catch (e) {
            addProxyLog(`[Cert] CRITICAL: Failed to generate certificate: ${e.message}`);
            console.error("Failed to generate certificate:", e);
            reject(e);
        }
    });
};

// Initial generation (Auto)
async function initializeServer(newUserDataPath) {
    userDataPath = newUserDataPath;
    addProxyLog("[System] Initializing server and checking CA...");

    const certSetup = async () => {
        try {
            const hasPfx = await setupHttpsOptions().catch(() => false);
            if (!hasPfx) {
                const result = await generateAndInstallCertificate(false);
                if (result.manual) {
                    addProxyLog("[System] Auto-CA: Manual installation required. Please check the opened certificate window.");
                } else {
                    addProxyLog("[System] Auto-CA: Certificate is ready and installed.");
                }
            } else {
                addProxyLog("[System] Auto-CA: Using manual PFX certificate.");
            }
        } catch (e) {
            addProxyLog(`[System] Auto-CA: Setup failed: ${e.message}`);
            console.error("Initial cert setup failed:", e);
        }
    };
    const certTimeoutMs = 15000;
    const timeoutP = new Promise((resolve) => {
        setTimeout(() => {
            addProxyLog(`[System] Auto-CA: Timed out after ${Math.round(certTimeoutMs/1000)}s. Continuing server startup without waiting for cert.`);
            resolve();
        }, certTimeoutMs);
    });
    await Promise.race([certSetup(), timeoutP]);

    // Ensure Firewall Rule Exists (Windows)
    if (process.platform === 'win32') {
        const ruleName = "MalakorProxyHTTPS";
        exec(`netsh advfirewall firewall show rule name="${ruleName}"`, (err, stdout) => {
            if (err || !stdout.includes(ruleName)) {
                addProxyLog("[System] Firewall: Adding rule for Port 443...");
                const addRuleCmd = `netsh advfirewall firewall add rule name="${ruleName}" dir=in action=allow protocol=TCP localport=443 profile=any`;
                exec(addRuleCmd, (addErr) => {
                    if (addErr) addProxyLog(`[System] Firewall Error: ${addErr.message}`);
                    else addProxyLog("[System] Firewall: Rule added successfully.");
                });
            }
        });
    }

    app.listen(PORT, () => {
        console.log(`Server running at http://localhost:${PORT}`);
        setTimeout(() => {
            _bootChecksInProgress = false;
        }, 2000);
    });
}

// Helper: Resolve IP for a given domain (per-domain override: boatltpk uses custom IP)
const getDomainIp = async (domain) => {
    if (domain === 'boatltpk') {
        const custom = await db.getSetting('boatltpk_custom_ip');
        return custom && custom.trim() ? custom.trim() : '127.0.0.1';
    }
    return '127.0.0.1';
};

// Helper: Modify Hosts File (supports per-domain IP overrides)
const modifyHostsFile = async (shouldRedirect) => {
    const action = shouldRedirect ? 'Redirecting' : 'Clearing';
    addProxyLog(`[System] Host File: ${action} domains...`);
    try {
        const hostsPath = HOSTS_FILE;

        if (!fs.existsSync(hostsPath)) {
            addProxyLog(`[ERROR] Host File not found at ${hostsPath}`);
            return;
        }

        let hostsContent = fs.readFileSync(hostsPath, 'utf8');
        const lines = hostsContent.split(/\r?\n/).filter(line => {
            const trimmed = line.trim();
            if (!trimmed) return false;
            return !TARGET_DOMAINS.some(domain =>
                trimmed === domain ||
                trimmed.endsWith(` ${domain}`) ||
                trimmed.endsWith(`\t${domain}`)
            );
        });

        if (shouldRedirect) {
            const boatltpkIp = await getDomainIp('boatltpk');
            addProxyLog(`[System] Host File: Redirecting ${TARGET_DOMAINS.length} domains (boatltpk -> ${boatltpkIp}, others -> 127.0.0.1)...`);
            for (const domain of TARGET_DOMAINS) {
                const ip = domain === 'boatltpk' ? boatltpkIp : '127.0.0.1';
                lines.push(`${ip} ${domain}`);
            }
        }

        const lineEnding = process.platform === 'win32' ? '\r\n' : '\n';
        fs.writeFileSync(hostsPath, lines.join(lineEnding) + lineEnding);
        addProxyLog(`[System] Host File: Modification successful.`);
        invalidateHostsStatusCache();
    } catch (e) {
        addProxyLog(`[ERROR] Host File: Failed to modify. Please ensure app is run as Admin.`);
        console.error("Hosts file modification error:", e);
        throw e;
    }
};

const buildProxyApp = (protocolLabel) => {
    const forcedTarget = FORCED_PROXY_TARGET;
    const proxyApp = express();

    proxyApp.use((req, res, next) => {
        const urlPath = req.url.split('?')[0];
        const isKnown = KNOWN_ENDPOINTS.includes(urlPath);
        addProxyLog(`[Proxy|${protocolLabel}] ${req.method} ${req.url} ${isKnown ? '(Known API)' : ''}`);
        next();
    });

    proxyApp.all('*', (req, res) => {
        const hostHeader = req.headers.host || '';
        const isSteamRequest = hostHeader.includes('steam') || hostHeader.includes('steampowered');
        const targetHost = isSteamRequest ? hostHeader : forcedTarget;
        const targetPort = isSteamRequest ? (protocolLabel === 'HTTPS' ? 443 : 80) : 443;
        const outboundModule = protocolLabel === 'HTTPS' ? https : http;
        const upstreamModule = targetPort === 443 ? https : http;

        if (isSteamRequest) {
            addProxyLog(`[Proxy|${protocolLabel}] Bypassing Steam request: ${req.method} ${req.url} (Host: ${hostHeader})`);
        }

        const options = {
            hostname: targetHost,
            port: targetPort,
            path: req.url,
            method: req.method,
            headers: {
                ...req.headers,
                host: targetHost,
                connection: 'close'
            },
            rejectUnauthorized: false,
            timeout: 30000
        };

        const proxyReq = upstreamModule.request(options, (proxyRes) => {
            if (!isSteamRequest) {
                addProxyLog(`[Proxy Response] ${protocolLabel} ${req.url} -> Status: ${proxyRes.statusCode}`);
            }
            res.writeHead(proxyRes.statusCode, proxyRes.headers);
            proxyRes.pipe(res, { end: true });
        });

        proxyReq.on('error', (e) => {
            addProxyLog(`[Proxy Error|${protocolLabel}] ${e.message} (Target: ${targetHost}:${targetPort})`);
            if (!res.headersSent) {
                res.status(502).json({ error: "Bad Gateway", message: e.message });
            }
        });

        proxyReq.on('timeout', () => {
            addProxyLog(`[Proxy Timeout|${protocolLabel}] Target: ${targetHost}:${targetPort}`);
            proxyReq.destroy();
            if (!res.headersSent) {
                res.status(504).json({ error: "Gateway Timeout" });
            }
        });

        req.pipe(proxyReq, { end: true });
    });

    return proxyApp;
};

// Start both HTTPS (443) and HTTP (80) fallback proxy servers
const startMockServer = (targetHost, targetPort = 443) => {
    if (proxyServer && httpProxyServer) return;
    if (!httpsOptions) {
        addProxyLog("Cannot start Proxy: Certificate generation failed.");
        return;
    }

    addProxyLog(`--- [Proxy Session Started] ---`);
    const forcedTarget = FORCED_PROXY_TARGET;
    addProxyLog(`Starting Proxy (Forced -> ${forcedTarget}) for domains: ${TARGET_DOMAINS.join(', ')}...`);

    // --- HTTPS :443 ---
    if (!proxyServer) {
        const httpsApp = buildProxyApp('HTTPS');
        proxyServer = https.createServer(httpsOptions, httpsApp);
        proxyServer.listen(443, '0.0.0.0', () => {
            addProxyLog(`HTTPS Proxy listening on 0.0.0.0:443`);
        });
        proxyServer.on('error', (err) => {
            addProxyLog(`HTTPS Proxy error: ${err.message}`);
            if (err.code === 'EADDRINUSE') {
                addProxyLog('[WARN] Port 443 is already in use by another process. HTTPS proxy failed to start.');
                proxyServer = null;
            }
        });
    }

    // --- HTTP :80 (HTTP fallback for boatltpk HTTP requests) ---
    if (!httpProxyServer) {
        const httpApp = buildProxyApp('HTTP');
        httpProxyServer = http.createServer(httpApp);
        httpProxyServer.listen(80, '0.0.0.0', () => {
            addProxyLog(`HTTP Proxy listening on 0.0.0.0:80 (HTTP fallback for boatltpk)`);
        });
        httpProxyServer.on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                addProxyLog('[WARN] Port 80 is in use (IIS/Skype/etc). HTTP fallback unavailable — HTTP-only clients may fail.');
            } else {
                addProxyLog(`HTTP Proxy error: ${err.message}`);
            }
            httpProxyServer = null;
        });
    }
};

/* 
// OLD PROXY IMPLEMENTATION (Replaced by Mock Server)
// Helper: Start TCP Proxy
const startProxy = (targetHost, targetPort = 443) => {
    ...
};
*/
const startProxy = startMockServer; // Alias for compatibility with existing code

const stopOneServer = (label, serverRef, promiseKey) => {
    const sv = serverRef();
    if (!sv) { globalThis[promiseKey] = null; return Promise.resolve(); }
    if (globalThis[promiseKey]) return globalThis[promiseKey];
    globalThis[promiseKey] = new Promise((resolve) => {
        let settled = false;
        const done = () => {
            if (settled) return;
            settled = true;
            clearTimeout(closeTimeout);
            if (label === 'HTTPS') proxyServer = null;
            if (label === 'HTTP') httpProxyServer = null;
            globalThis[promiseKey] = null;
            addProxyLog(`${label} Proxy stopped`);
            resolve();
        };
        const closeTimeout = setTimeout(() => {
            try { if (sv.closeAllConnections) sv.closeAllConnections(); } catch(_) {}
            setTimeout(done, 200);
        }, 1500);
        try {
            sv.close(done);
        } catch (_) {
            done();
        }
    });
    return globalThis[promiseKey];
};

// Stop both HTTPS (443) and HTTP (80) proxy servers
const stopProxy = () => {
    return Promise.all([
        stopOneServer('HTTPS', () => proxyServer, '____httpsP'),
        stopOneServer('HTTP',  () => httpProxyServer, '____httpP')
    ]).then(() => undefined);
};

// Game exit monitor: when detached game dies, revert hosts + stop proxy (polite cleanup)
const _startGameMonitor = (pid, onExit) => {
    if (_gameMonitorTimer) { clearInterval(_gameMonitorTimer); _gameMonitorTimer = null; }
    _lastGamePid = pid || 0;
    if (!_lastGamePid) return;
    _gameMonitorTimer = setInterval(() => {
        if (!_lastGamePid) { clearInterval(_gameMonitorTimer); _gameMonitorTimer = null; return; }
        try { process.kill(_lastGamePid, 0); } catch (e) {
            clearInterval(_gameMonitorTimer); _gameMonitorTimer = null;
            const endedPid = _lastGamePid; _lastGamePid = 0;
            addProxyLog(`[Game Monitor] PID ${endedPid} exited, performing cleanup.`);
            onExit && onExit(endedPid);
        }
    }, 2500);
};

// Clean up on exit (sync fallback for hosts revert so it actually runs on abrupt exit)
const _revertHostsSync = () => {
    try {
        const hostsPath = HOSTS_FILE;
        if (!fs.existsSync(hostsPath)) return;
        const hostsContent = fs.readFileSync(hostsPath, 'utf8');
        const lines = hostsContent.split(/\r?\n/).filter(line => {
            const trimmed = line.trim();
            if (!trimmed) return false;
            return !TARGET_DOMAINS.some(domain =>
                trimmed === domain ||
                trimmed.endsWith(` ${domain}`) ||
                trimmed.endsWith(`\t${domain}`)
            );
        });
        const lineEnding = process.platform === 'win32' ? '\r\n' : '\n';
        fs.writeFileSync(hostsPath, lines.join(lineEnding) + lineEnding);
    } catch (_) {}
};
process.on('exit', () => { try { stopProxy(); } catch(_){} _revertHostsSync(); });
process.on('SIGINT', () => { try { stopProxy(); } catch(_){} _revertHostsSync(); process.exit(); });

// --- CENTRAL SERVER LOGIC (When running on Cloud) ---
// Simple in-memory storage for demo. Use database for production.
let centralConfig = {
    targetDomain: "game.example.com", // Default
    motd: "Welcome to Malakor Launcher"
};

let onlineClients = {}; // Store client status: { clientId: { status, lastSeen } }

// API to get Global Config (Called by Launcher)
app.get('/api/central/config', (req, res) => {
    res.json(centralConfig);
});

// API to update Global Config (Called by Admin - unsecured for demo)
app.post('/api/central/config', (req, res) => {
    const { targetDomain, motd } = req.body;
    if (targetDomain) centralConfig.targetDomain = targetDomain;
    if (motd) centralConfig.motd = motd;
    res.json({ success: true, config: centralConfig });
});

// API to report status (Called by Launcher)
app.post('/api/central/heartbeat', (req, res) => {
    const { clientId, status } = req.body;
    onlineClients[clientId] = {
        status,
        lastSeen: new Date()
    };
    res.json({ success: true });
});

// --- LOCAL LAUNCHER LOGIC (When running on Desktop) ---

// Get current status
app.get('/api/status', async (req, res) => {
    const quick = (req.query && req.query.quick === '1') || false;
    if (quick && _cachedStatusSnapshot && (Date.now() - _cachedStatusSnapshot.at) < STATUS_SNAPSHOT_CACHE_MS) {
        return res.json(_cachedStatusSnapshot.value);
    }
    try {
        const settings = await db.getAllSettings();
        const gamePath = settings.game_path || '';
        const serverAddress = settings.server_address || '';
        const isInstalled = settings.is_installed;
        const centralServerUrlRaw = settings.central_server_url;
        const boatltpkIpCustom = settings.boatltpk_custom_ip;
        const discordAccessToken = settings.discord_access_token;

        const centralServerUrl = centralServerUrlRaw || `https://${FORCED_PROXY_TARGET}`;
        const boatltpkIp = (boatltpkIpCustom && boatltpkIpCustom.trim()) ? boatltpkIpCustom.trim() : '127.0.0.1';
        const proxyRunning = !!(proxyServer && typeof proxyServer.address === 'function' && proxyServer.address());

        let isRunning = false;
        let steamRunning = false;
        if (quick) {
            if (gamePath) {
                const exeName = path.basename(gamePath, path.extname(gamePath)).toLowerCase();
                if (_processCache && (Date.now() - _processCacheAt) < PROCESS_CACHE_MS) {
                    isRunning = _processCache.has(exeName);
                } else {
                    await refreshProcessCache();
                    isRunning = _processCache ? _processCache.has(exeName) : await isProcessRunning(gamePath);
                }
            }
            steamRunning = await checkSteamRunning();
        } else {
            await refreshProcessCache();
            if (gamePath) {
                const exeName = path.basename(gamePath, path.extname(gamePath)).toLowerCase();
                isRunning = _processCache ? _processCache.has(exeName) : await isProcessRunning(gamePath);
            }
            steamRunning = await checkSteamRunning();
        }

        let serverOnline = false;
        const now = Date.now();
        if (quick) {
            if (_cachedServerOnline && _cachedServerOnline.url === centralServerUrl && (now - _cachedServerOnline.at) < SERVER_HEALTH_CACHE_MS) {
                serverOnline = _cachedServerOnline.value;
            } else {
                serverOnline = true;
            }
        } else {
            if (_cachedServerOnline && _cachedServerOnline.url === centralServerUrl && (now - _cachedServerOnline.at) < SERVER_HEALTH_CACHE_MS) {
                serverOnline = _cachedServerOnline.value;
            } else {
                try {
                    const healthCheck = await axios.get(centralServerUrl, { 
                        timeout: 4000,
                        validateStatus: () => true,
                    });
                    serverOnline = healthCheck.status >= 100 && healthCheck.status < 500;
                    _cachedServerOnline = { url: centralServerUrl, value: serverOnline, at: now };
                } catch (e) {
                    if (e.response) { serverOnline = true; _cachedServerOnline = { url: centralServerUrl, value: true, at: now }; }
                    else console.error("[Server Health Check Failed]:", e.message);
                }
            }
        }

        let discordUser = null;
        if (!quick && discordAccessToken) {
            if (_cachedDiscordUser && _cachedDiscordUser.token === discordAccessToken && (now - _cachedDiscordUser.at) < DISCORD_USER_CACHE_MS) {
                discordUser = _cachedDiscordUser.data;
            } else {
                try {
                    const { data } = await axios.get('https://discord.com/api/v10/users/@me', {
                        headers: { Authorization: `Bearer ${discordAccessToken}` },
                        timeout: 3500,
                    });
                    discordUser = { id: data.id, username: data.username, discriminator: data.discriminator, avatar: data.avatar };
                    _cachedDiscordUser = { token: discordAccessToken, data: discordUser, at: now };
                } catch (e) {
                    _cachedDiscordUser = null;
                    discordAccessToken && await db.setSetting('discord_access_token', '').catch(() => {});
                }
            }
        } else if (quick && discordAccessToken) {
            if (_cachedDiscordUser && _cachedDiscordUser.token === discordAccessToken && (now - _cachedDiscordUser.at) < DISCORD_USER_CACHE_MS) {
                discordUser = _cachedDiscordUser.data;
            }
        }

        const payload = {
            gamePath,
            serverAddress,
            centralServerUrl,
            customTargetHost: FORCED_PROXY_TARGET,
            forcedProxyTarget: FORCED_PROXY_TARGET,
            isInstalled: isInstalled === 'true',
            isRunning,
            steamRunning,
            serverOnline,
            proxyRunning,
            boatltpkIp,
            boatltpkIpCustom: boatltpkIpCustom || '',
            discord: discordUser,
            bootChecksInProgress: _bootChecksInProgress,
            updateCheckInProgress: _updateCheckInProgress,
            autoSearchInProgress: _autoSearchInProgress,
        };
        if (quick) _cachedStatusSnapshot = { value: payload, at: Date.now() };
        res.json(payload);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get Proxy Logs
app.get('/api/logs', (req, res) => {
    const now = Date.now();
    const count = proxyLogs.length;
    if (_cachedLogsSnapshot && _cachedLogsSnapshot.count === count && (now - _cachedLogsSnapshot.at) < LOGS_SNAPSHOT_CACHE_MS) {
        return res.json(_cachedLogsSnapshot.value);
    }
    const arr = proxyLogs.slice(-30);
    const payload = { logs: arr };
    _cachedLogsSnapshot = { value: payload, at: now, count };
    res.json(payload);
});

app.get('/api/verify-access', async (req, res) => {
    const userId = req.query.id;
    if (!userId) return res.status(400).json({ allowed: false });

    try {
        const AUTH_JSON_URL = 'https://api.npoint.io/da288d5ee6b61ce2ff0b';
        const response = await axios.get(AUTH_JSON_URL, { headers: { 'Cache-Control': 'no-cache' } });
        const allowedIds = response.data;

        if (Array.isArray(allowedIds) && allowedIds.includes(userId)) {
            res.json({ allowed: true });
        } else {
            res.json({ allowed: false });
        }
    } catch (err) {
        console.error("[Realtime Auth Check Failed]:", err.message);
        // In case of error, we assume allowed to prevent kicking users due to network glitches
        res.json({ allowed: true }); 
    }
});

// Configure settings
app.post('/api/configure', async (req, res) => {
    const { gamePath, boatltpkIp } = req.body || {};
    let savedGamePath = '';
    let savedIsInstalled = false;
    try {
        if (typeof gamePath === 'string' && gamePath.length > 0) {
            const absGame = path.resolve(gamePath);
            if (!fs.existsSync(absGame)) {
                return res.status(400).json({ error: `Game executable not found at: ${absGame}` });
            }
            console.log(`[Configure] Saving game_path=${absGame} (raw input=${gamePath})`);
            await db.setSetting('game_path', absGame);
            await db.setSetting('is_installed', 'true');
            savedGamePath = absGame;
            savedIsInstalled = true;
            // Force re-read directly from disk to ensure the DB write actually persisted
            await db.flushSettingsCache();
            const verify1 = await db.getSetting('game_path');
            const verify2 = await db.getSetting('is_installed');
            console.log(`[Configure] Verify after set: game_path=${JSON.stringify(verify1)}, is_installed=${JSON.stringify(verify2)}`);
            if (verify1 !== absGame || verify2 !== 'true') {
                console.warn('[Configure] WARNING: DB write verification failed — will retry once.');
                try {
                    await db.setSetting('game_path', absGame);
                    await db.setSetting('is_installed', 'true');
                    await db.flushSettingsCache();
                    const verify1b = await db.getSetting('game_path');
                    const verify2b = await db.getSetting('is_installed');
                    console.log(`[Configure] Retry verify: game_path=${JSON.stringify(verify1b)}, is_installed=${JSON.stringify(verify2b)}`);
                } catch (retryErr) {
                    console.error('[Configure] Retry DB write failed:', retryErr.message);
                }
            }
        }
        await db.setSetting('server_address', FORCED_PROXY_TARGET);
        await db.setSetting('central_server_url', `https://${FORCED_PROXY_TARGET}`);
        if (typeof boatltpkIp === 'string') {
            const trimmed = boatltpkIp.trim();
            if (trimmed === '') {
                await db.setSetting('boatltpk_custom_ip', '');
                invalidateHostsStatusCache();
            } else {
                const ipv4Ok = /^(25[0-5]|2[0-4]\d|[01]?\d\d?)(\.(25[0-5]|2[0-4]\d|[01]?\d\d?)){3}$/.test(trimmed);
                if (!ipv4Ok) return res.status(400).json({ error: 'boatltpkIp: Invalid IPv4 format' });
                await db.setSetting('boatltpk_custom_ip', trimmed);
                invalidateHostsStatusCache();
            }
        }
        const finalGamePath = savedGamePath || (await db.getSetting('game_path') || '');
        const finalIsInstalled = savedIsInstalled || ((await db.getSetting('is_installed') || '') === 'true');
        res.json({ success: true, gamePath: finalGamePath, isInstalled: finalIsInstalled });
    } catch (err) {
        console.error('[Configure] Failed with error:', err.message || err);
        res.status(500).json({ error: err.message });
    }
});

// Auto-Search game executable across all drives (HSHO.exe only)
const GAME_SEARCH_NAMES = ['HSHO.exe'];
const GAME_SEARCH_PARTIALS = ['hsho'];
const _skipSearchDirs = new Set([
    '$Recycle.Bin', 'System Volume Information', 'Windows', 'WinSxS',
    'WindowsApps', 'MSOCache', 'Recovery', 'PerfLogs',
    'node_modules', '.git', '.trash', '$RECYCLE.BIN',
    'WinSxS', 'Installer', 'Servicing', 'winsxs',
    'Microsoft', 'Package Cache', 'Drivers', 'DriverStore',
    'NVIDIA Corporation', 'Intel', 'AMD', 'Dell', 'HP', 'Lenovo', 'ASUS', 'Acer',
    'Microsoft SDKs', 'Microsoft.NET', 'Windows Kits', 'Microsoft Office',
    'Windows NT', 'Windows Media Player', 'Windows Mail', 'Sidebar',
    'ProgramData', 'Boot', 'EFI', '$WinREAgent', 'System.sav'
]);
const _skipSearchPathPartsLower = new Set([
    '\\windows\\', '\\winsxs\\', '\\system32\\', '\\syswow64\\',
    '\\program files\\windowsapps\\', '\\programdata\\microsoft\\windows defender\\',
    '\\program files\\common files\\microsoft shared\\',
    '\\appdata\\local\\microsoft\\', '\\appdata\\local\\packages\\',
    '\\appdata\\roaming\\microsoft\\',
    '\\$recycle.bin\\', '\\system volume information\\',
    '\\programdata\\package cache\\', '\\msocache\\',
    '\\.nuget\\', '\\vcpkg\\', '\\llvm\\', '\\cygwin64\\', '\\cygwin\\',
    '\\python', '\\jdk-', '\\dotnet\\sdk\\', '\\windows kits\\',
    '\\program files (x86)\\installshield installation information\\',
    '\\programdata\\dell\\', '\\programdata\\hp\\', '\\programdata\\lenovo\\',
    '\\windows\\securitycenter\\', '\\windows\\softwaredistribution\\',
    '\\windows\\systemapps\\', '\\program files (x86)\\microsoft\\',
    '\\program files (x86)\\common files\\',
    '\\program files\\common files\\',
    '\\windows.old\\'
]);
const DIR_SKIP_ENTRIES_THRESHOLD = 450;

function _dirPartIncludes(fullPathLower, baseNameLower) {
    const parts = fullPathLower.split(/\\/g).filter(Boolean);
    return parts.includes(baseNameLower);
}

function _shouldSkipDir(fullPath) {
    try {
        const base = path.basename(fullPath);
        if (_skipSearchDirs.has(base)) return true;
        const lower = fullPath.toLowerCase();
        const insideDownloads = _dirPartIncludes(lower, 'downloads');
        for (const part of _skipSearchPathPartsLower) {
            if (lower.includes(part)) {
                if (insideDownloads && /\\downloads\\.*(?:chrome|edge|firefox|opera|temp|crdownload|partial)/i.test(part)) return true;
                if (insideDownloads) continue;
                return true;
            }
        }
        return false;
    } catch (_) { return true; }
}

function _getWindowsDrivesSync() {
    const drives = [];
    try {
        const out = execSync('wmic logicaldisk get name 2>nul', { timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8', windowsHide: true });
        const lines = (out || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        for (const line of lines) {
            if (/^[A-Za-z]:$/.test(line)) drives.push(line + '\\');
        }
    } catch (_) {}
    if (drives.length === 0) {
        for (let i = 67; i <= 90; i++) {
            const drive = String.fromCharCode(i) + ':\\';
            try { if (fs.existsSync(drive)) drives.push(drive); } catch (__) {}
        }
    }
    const cDrive = 'C:\\';
    if (!drives.includes(cDrive)) try { if (fs.existsSync(cDrive)) drives.unshift(cDrive); } catch (__) {}
    const dDrive = 'D:\\';
    if (drives.includes(dDrive)) {
        const idx = drives.indexOf(dDrive);
        drives.splice(idx, 1);
        drives.unshift(dDrive);
    }
    return Array.from(new Set(drives));
}

function _scanRegistryUninstallForInstallLocationsSync() {
    const results = [];
    if (process.platform !== 'win32') return results;
    const regPaths = [
        'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
        'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
        'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
    ];
    for (const rp of regPaths) {
        try {
            const cmd = `reg query "${rp}" /s /v "InstallLocation" 2>nul`;
            const out = execSync(cmd, { timeout: 6000, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8', windowsHide: true });
            const lines = (out || '').split(/\r?\n/);
            for (const line of lines) {
                const m = line.match(/InstallLocation\s+(?:REG_SZ|REG_EXPAND_SZ)\s+(.+)/i);
                if (m) {
                    const loc = m[1].trim();
                    if (loc && loc.length >= 4 && /^[A-Za-z]:/.test(loc)) {
                        try {
                            const clean = loc.replace(/["']/g, '').replace(/\\+$/, '');
                            if (fs.existsSync(clean)) results.push(clean);
                        } catch (_) {}
                    }
                }
            }
        } catch (_) {}
    }
    return Array.from(new Set(results.filter(Boolean)));
}

function _scanRegistryGameLocationsForHSHO() {
    const results = [];
    if (process.platform !== 'win32') return results;

    function _regReadSingleValue(keyPath, valueName) {
        try {
            const cmd = `reg query "${keyPath}" /v "${valueName}" 2>nul`;
            const out = execSync(cmd, { timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8', windowsHide: true });
            if (!out) return null;
            const line = out.split(/\r?\n/).map(l => l.trim()).find(l => l.toLowerCase().includes(valueName.toLowerCase()));
            if (!line) return null;
            const m = line.match(new RegExp(`${valueName}\\s+(?:REG_SZ|REG_EXPAND_SZ|REG_DWORD)\\s+(.+)`, 'i'));
            return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
        } catch (_) { return null; }
    }

    function _regListSubkeys(keyPath) {
        try {
            const cmd = `reg query "${keyPath}" 2>nul`;
            const out = execSync(cmd, { timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8', windowsHide: true });
            if (!out) return [];
            return out.split(/\r?\n/).map(l => l.trim()).filter(Boolean).filter(l => l.toLowerCase().startsWith(keyPath.toLowerCase()));
        } catch (_) { return []; }
    }

    try {
        const steam64 = _regReadSingleValue('HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath');
        if (steam64 && fs.existsSync(steam64)) {
            results.push(steam64);
            const common = path.join(steam64, 'steamapps', 'common');
            if (fs.existsSync(common)) results.push(common);
        }
        const steamCu = _regReadSingleValue('HKCU\\SOFTWARE\\Valve\\Steam', 'SteamPath');
        if (steamCu && fs.existsSync(steamCu)) {
            results.push(steamCu);
            const common = path.join(steamCu, 'steamapps', 'common');
            if (fs.existsSync(common)) results.push(common);
        }
    } catch (_) {}

    try {
        const epic = _regReadSingleValue('HKLM\\SOFTWARE\\WOW6432Node\\Epic Games\\EpicGamesLauncher', 'AppDataPath');
        if (epic) {
            const root = path.resolve(epic, '..', '..', 'Games');
            if (fs.existsSync(root)) results.push(root);
        }
    } catch (_) {}

    try {
        const gog = _regReadSingleValue('HKLM\\SOFTWARE\\WOW6432Node\\GOG.com\\GalaxyClient\\paths', 'client');
        if (gog) {
            const games = path.resolve(gog, '..', 'Games');
            if (fs.existsSync(games)) results.push(games);
            const games2 = path.join(gog, 'Games');
            if (fs.existsSync(games2)) results.push(games2);
        }
    } catch (_) {}

    try {
        const riot = _regReadSingleValue('HKLM\\SOFTWARE\\Riot Games, Inc\\Riot Client', 'InstallLocation');
        if (riot && fs.existsSync(riot)) results.push(riot);
    } catch (_) {}

    try {
        const ubi = _regReadSingleValue('HKLM\\SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher', 'InstallDir');
        if (ubi) {
            const games = path.join(ubi, 'games');
            if (fs.existsSync(ubi)) results.push(ubi);
            if (fs.existsSync(games)) results.push(games);
        }
    } catch (_) {}

    try {
        const battlenet64Keys = _regListSubkeys('HKLM\\SOFTWARE\\WOW6432Node\\Blizzard Entertainment\\World of Warcraft');
        for (const _ of []) { void _; }
        const battlenetUninstall = [
            'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
            'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
        ];
        for (const uRoot of battlenetUninstall) {
            const subKeys = _regListSubkeys(uRoot);
            for (const sk of subKeys) {
                try {
                    if (!/battle|blizzard|hsho|hosh/i.test(sk)) continue;
                    const il = _regReadSingleValue(sk, 'InstallLocation');
                    if (il && fs.existsSync(il)) results.push(il);
                } catch (_) {}
            }
        }
    } catch (_) {}

    return Array.from(new Set(results.filter(Boolean)));
}

function _readSteamLibraryPathsSync(roots) {
    const results = [];
    for (const drive of roots) {
        const steams = [
            path.join(drive, 'Program Files (x86)', 'Steam'),
            path.join(drive, 'Program Files', 'Steam'),
            path.join(drive, 'Steam')
        ];
        for (const sp of steams) {
            try {
                const vdf = path.join(sp, 'steamapps', 'libraryfolders.vdf');
                if (!fs.existsSync(vdf)) continue;
                const txt = fs.readFileSync(vdf, 'utf8');
                const paths = [];
                const pathRegex = /"path"\s*"([^"]+)"/gi;
                let mm;
                while ((mm = pathRegex.exec(txt)) !== null) {
                    let pp = mm[1].replace(/\\\\/g, '\\');
                    try {
                        const common = path.join(pp, 'steamapps', 'common');
                        if (fs.existsSync(common)) results.push(common);
                        if (fs.existsSync(pp)) results.push(pp);
                    } catch (_) {}
                }
            } catch (_) {}
            try {
                const common = path.join(sp, 'steamapps', 'common');
                if (fs.existsSync(common)) results.push(common);
            } catch (_) {}
        }
    }
    return Array.from(new Set(results.filter(Boolean)));
}

function _readShortcutTargetSync(lnkPath) {
    try {
        if (process.platform !== 'win32') return null;
        const cmd = `powershell -NoProfile -Command "(New-Object -ComObject WScript.Shell).CreateShortcut('${lnkPath.replace(/'/g, "''")}').TargetPath" 2>nul`;
        const out = execSync(cmd, { timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8', windowsHide: true });
        const v = (out || '').trim();
        if (v && v.length > 4 && fs.existsSync(v)) return v;
    } catch (_) {}
    return null;
}

function _collectShortcutTargetsSync() {
    const results = [];
    if (process.platform !== 'win32') return results;
    const scanPlaces = [];
    try {
        const home = require('os').homedir();
        if (home) {
            scanPlaces.push(path.join(home, 'Desktop'));
            scanPlaces.push(path.join(home, 'Downloads'));
            scanPlaces.push(path.join(home, 'Documents'));
            scanPlaces.push(path.join(home, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs'));
        }
        scanPlaces.push(path.join(process.env.PUBLIC || 'C:\\Users\\Public', 'Desktop'));
        scanPlaces.push('C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs');
    } catch (_) {}
    for (const place of scanPlaces) {
        try {
            if (!fs.existsSync(place)) continue;
            const entries = fs.readdirSync(place, { withFileTypes: true });
            for (const e of entries) {
                if (!e.isFile()) continue;
                const low = e.name.toLowerCase();
                if (!low.endsWith('.lnk')) continue;
                if (!low.includes('hsho')) continue;
                const full = path.join(place, e.name);
                const tgt = _readShortcutTargetSync(full);
                if (tgt) {
                    if (fs.statSync(tgt).isFile()) results.push(tgt);
                    else results.push(path.dirname(tgt));
                }
            }
        } catch (_) {}
    }
    return Array.from(new Set(results.filter(Boolean)));
}

function _scoreLikelihood(fullPath, fileNameLower) {
    let score = 0;
    const lower = fullPath.toLowerCase();
    if (fileNameLower === 'hsho.exe') score += 100;
    if (lower.includes('\\steamapps\\common\\')) score += 25;
    if (lower.includes('\\epic games\\')) score += 20;
    if (lower.includes('\\gog galaxy\\games\\')) score += 20;
    if (lower.includes('\\games\\')) score += 15;
    if (lower.includes('\\program files\\') || lower.includes('\\program files (x86)\\')) score += 10;
    if (lower.includes('hsho')) score += 15;
    if (lower.includes('\\downloads\\')) score += 3;
    if (lower.includes('\\desktop\\')) score += 3;
    if (lower.includes('\\documents\\')) score += 2;
    if (lower.includes('appdata')) score -= 5;
    if (lower.includes('temp')) score -= 10;
    try {
        const st = fs.statSync(fullPath);
        if (st.size > 10 * 1024 * 1024) score += 15;
        else if (st.size > 2 * 1024 * 1024) score += 8;
        else if (st.size > 500 * 1024) score += 3;
        else if (st.size < 100 * 1024) score -= 20;
    } catch (_) {}
    return score;
}

function _findGameRecursive(searchRoot, exactNamesLower, partialKeysLower, matches, maxDepth, currentDepth, startTime, deadlineMs, allowPartial) {
    if (currentDepth > maxDepth) return;
    if ((Date.now() - startTime) > deadlineMs) return;
    let entries;
    try {
        entries = fs.readdirSync(searchRoot, { withFileTypes: true });
    } catch (_) { return; }
    let threshold = DIR_SKIP_ENTRIES_THRESHOLD;
    try {
        const lower = searchRoot.toLowerCase();
        if (_dirPartIncludes(lower, 'downloads')) threshold = 15000;
    } catch (_) {}
    if (entries && entries.length > threshold && currentDepth >= 2) {
        return;
    }
    for (const entry of entries) {
        try {
            const full = path.join(searchRoot, entry.name);
            if (entry.isDirectory()) {
                if (_shouldSkipDir(full)) continue;
                if (currentDepth + 1 <= maxDepth) {
                    _findGameRecursive(full, exactNamesLower, partialKeysLower, matches, maxDepth, currentDepth + 1, startTime, deadlineMs, allowPartial);
                }
            } else if (entry.isFile()) {
                const nameLower = entry.name.toLowerCase();
                let hit = false;
                if (exactNamesLower.includes(nameLower)) hit = true;
                if (!hit && allowPartial) {
                    for (const pk of partialKeysLower) {
                        if (nameLower.includes(pk) && nameLower.endsWith('.exe')) { hit = true; break; }
                    }
                }
                if (hit) {
                    try {
                        const stats = fs.statSync(full);
                        if (stats && stats.size > 100 * 1024) {
                            matches.push({ path: full, nameLower, size: stats.size });
                        }
                    } catch (_) {}
                }
            }
        } catch (_) {}
    }
}

function _probeDirForFile(dir, exactNamesLower) {
    try {
        if (!fs.existsSync(dir)) return null;
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const e of entries) {
            if (!e.isFile()) continue;
            if (exactNamesLower.includes(e.name.toLowerCase())) {
                const full = path.join(dir, e.name);
                try {
                    const st = fs.statSync(full);
                    if (st && st.size > 100 * 1024) return { path: full, nameLower: e.name.toLowerCase(), size: st.size };
                } catch (_) {}
            }
        }
        const trySub = ['Bin', 'bin', 'Bin64', 'Bin32', 'Build', 'Release', 'Client', 'Game', 'HSHO'];
        for (const sub of trySub) {
            const sp = path.join(dir, sub);
            if (!fs.existsSync(sp)) continue;
            try {
                const ents = fs.readdirSync(sp, { withFileTypes: true });
                for (const e of ents) {
                    if (!e.isFile()) continue;
                    if (exactNamesLower.includes(e.name.toLowerCase())) {
                        const full = path.join(sp, e.name);
                        try {
                            const st = fs.statSync(full);
                            if (st && st.size > 100 * 1024) return { path: full, nameLower: e.name.toLowerCase(), size: st.size };
                        } catch (_) {}
                    }
                }
            } catch (_) {}
        }
    } catch (_) {}
    return null;
}

function searchGameExecutablesSync(opts = {}) {
    const names = opts.names || GAME_SEARCH_NAMES;
    const namesLower = names.map(n => String(n).toLowerCase());
    const partialsLower = GAME_SEARCH_PARTIALS.map(s => s.toLowerCase());
    const deadlineMs = opts.deadlineMs || (50 * 1000);
    const maxDepth = opts.maxDepth || 5;
    const startTime = Date.now();
    const matches = [];

    let roots = [];
    if (process.platform === 'win32') {
        roots = _getWindowsDrivesSync();
    } else {
        roots = ['/'];
        try {
            const home = require('os').homedir();
            if (home && fs.existsSync(home)) roots.unshift(home);
        } catch (_) {}
    }

    let homeDir = null;
    try { homeDir = require('os').homedir(); } catch (_) {}

    const probeLocations = new Set();

    try {
        const regPaths = _scanRegistryUninstallForInstallLocationsSync();
        for (const p of regPaths) probeLocations.add(p);
    } catch (_) {}

    try {
        const regHSHO = _scanRegistryGameLocationsForHSHO();
        for (const p of regHSHO) probeLocations.add(p);
    } catch (_) {}

    try {
        const steamLibraries = _readSteamLibraryPathsSync(roots);
        for (const p of steamLibraries) probeLocations.add(p);
    } catch (_) {}

    try {
        const scTargets = _collectShortcutTargetsSync();
        for (const p of scTargets) {
            if (fs.existsSync(p) && fs.statSync(p).isFile()) {
                const nm = path.basename(p).toLowerCase();
                if (namesLower.includes(nm) || partialsLower.some(k => nm.includes(k))) {
                    try {
                        const st = fs.statSync(p);
                        if (st && st.size > 100 * 1024) matches.push({ path: p, nameLower: nm, size: st.size });
                    } catch (_) {}
                }
            } else {
                probeLocations.add(p);
            }
        }
    } catch (_) {}

    function _scoreLikelihoodBoostForDownloads(fullPathLower, currentScore) {
        if (currentScore >= 0) return currentScore;
        if (_dirPartIncludes(fullPathLower, 'downloads')) {
            if (/hsho|home.*sweet.*home|hsh/i.test(fullPathLower)) return 0;
            return Math.max(currentScore, -3);
        }
        return currentScore;
    }

    function _scoreLikelihoodWrap(fullPath, fileNameLower) {
        let s = _scoreLikelihood(fullPath, fileNameLower);
        s = _scoreLikelihoodBoostForDownloads(fullPath.toLowerCase(), s);
        if (fullPath.toLowerCase().includes('\\downloads\\') && fileNameLower === 'hsho.exe') s += 12;
        return s;
    }

    for (const loc of Array.from(probeLocations)) {
        if ((Date.now() - startTime) > deadlineMs) break;
        const hit = _probeDirForFile(loc, namesLower);
        if (hit) matches.push(hit);
    }

    const likelyDirsHigh = [];
    const likelyDirsMid = [];
    const fallbackDriveRoots = [];
    const publicDownloads = [];

    for (const drive of roots) {
        const homeBaseName = homeDir ? path.basename(homeDir) : null;
        const highPaths = [
            'Games', 'Game',
            'Steam\\steamapps\\common',
            'Epic Games', 'GOG Galaxy\\Games',
            'Riot Games', 'Ubisoft\\Ubisoft Game Launcher\\games',
            'Battle.net', 'Bethesda.net Launcher\\games',
            'Itch Games', 'HSHO', 'HSH', 'Home Sweet Home',
            'Users\\' + (homeBaseName || 'Public') + '\\Desktop',
            'Users\\' + (homeBaseName || 'Public') + '\\Downloads',
            'Users\\' + (homeBaseName || 'Public') + '\\Games',
            'Users\\' + (homeBaseName || 'Public') + '\\Documents',
            'Users\\Public\\Downloads'
        ];
        for (const pf of highPaths) {
            const p = path.join(drive, pf);
            try { if (fs.existsSync(p)) likelyDirsHigh.push(p); } catch (__) {}
        }
        const midPaths = [
            'Program Files',
            'Program Files (x86)',
            'Users\\' + (homeBaseName || 'Public') + '\\AppData\\Local'
        ];
        for (const pf of midPaths) {
            const p = path.join(drive, pf);
            try { if (fs.existsSync(p)) likelyDirsMid.push(p); } catch (__) {}
        }
        try { if (fs.existsSync(drive)) fallbackDriveRoots.push(drive); } catch (__) {}
    }

    if (homeDir) {
        for (const sub of ['Desktop', 'Downloads', 'Documents', 'Games', 'AppData\\Local']) {
            const p = path.join(homeDir, sub);
            try { if (fs.existsSync(p)) likelyDirsHigh.unshift(p); } catch (_) {}
        }
        try {
            const pd = path.resolve(homeDir, '..', 'Public', 'Downloads');
            if (fs.existsSync(pd)) publicDownloads.push(pd);
        } catch (_) {}
    }

    const publicDir = process.env.PUBLIC;
    if (publicDir) {
        for (const sub of ['Desktop', 'Downloads', 'Documents']) {
            const p = path.join(publicDir, sub);
            try { if (fs.existsSync(p)) likelyDirsHigh.push(p); } catch (_) {}
        }
    }
    for (const p of publicDownloads) {
        try { if (fs.existsSync(p)) likelyDirsHigh.push(p); } catch (_) {}
    }

    const allDriveDownloads = [];
    for (const drive of roots) {
        try {
            const p = path.join(drive, 'Downloads');
            if (fs.existsSync(p)) allDriveDownloads.push(p);
        } catch (_) {}
        try {
            const p2 = path.join(drive, 'Download');
            if (fs.existsSync(p2)) allDriveDownloads.push(p2);
        } catch (_) {}
    }
    for (const p of allDriveDownloads) {
        try { if (fs.existsSync(p)) likelyDirsHigh.push(p); } catch (_) {}
    }

    const dedupLikelyHigh = [];
    const dedupLikelyMid = [];
    const dedupFallbackDrives = [];
    const seenLikely = new Set();
    for (const d of likelyDirsHigh) {
        const key = path.normalize(d).toLowerCase();
        if (seenLikely.has(key)) continue;
        seenLikely.add(key);
        dedupLikelyHigh.push(d);
    }
    for (const d of likelyDirsMid) {
        const key = path.normalize(d).toLowerCase();
        if (seenLikely.has(key)) continue;
        seenLikely.add(key);
        dedupLikelyMid.push(d);
    }
    for (const d of fallbackDriveRoots) {
        const key = path.normalize(d).toLowerCase();
        if (seenLikely.has(key)) continue;
        seenLikely.add(key);
        dedupFallbackDrives.push(d);
    }

    const remainingMs = deadlineMs - (Date.now() - startTime);
    const phase1Deadline = Date.now() + Math.max(10000, Math.floor(remainingMs * 0.5));
    const phase2Deadline = Date.now() + Math.max(18000, Math.floor(remainingMs * 0.8));

    function _isDownloadsRoot(p) {
        try { return _dirPartIncludes(p.toLowerCase(), 'downloads'); } catch (_) { return false; }
    }

    const downloadsHigh = dedupLikelyHigh.filter(p => _isDownloadsRoot(p));
    const otherHigh = dedupLikelyHigh.filter(p => !_isDownloadsRoot(p));
    const phase1HighPriority = [...downloadsHigh, ...otherHigh];

    for (const root of phase1HighPriority) {
        if ((Date.now() - startTime) > deadlineMs) break;
        if (matches.length > 0 && (Date.now() - startTime) > phase1Deadline) break;
        const phaseStart = Date.now();
        const isDownloads = _isDownloadsRoot(root);
        const d = isDownloads ? Math.min(Math.max(maxDepth, 7), 9) : Math.min(maxDepth, 5);
        _findGameRecursive(root, namesLower, partialsLower, matches, d, 0, phaseStart, phase1Deadline, false);
    }

    if ((matches.length === 0 || (Date.now() - startTime) < phase1Deadline) && (Date.now() - startTime) < deadlineMs) {
        for (const root of dedupLikelyMid) {
            if ((Date.now() - startTime) > deadlineMs) break;
            if (matches.length > 0 && (Date.now() - startTime) > phase2Deadline) break;
            const phaseStart = Date.now();
            _findGameRecursive(root, namesLower, partialsLower, matches, Math.min(maxDepth, 4), 0, phaseStart, phase2Deadline, false);
        }
    }

    if (matches.length === 0 && (Date.now() - startTime) < deadlineMs) {
        for (const root of phase1HighPriority) {
            if ((Date.now() - startTime) > deadlineMs) break;
            const isDownloads = _isDownloadsRoot(root);
            const d = isDownloads ? 10 : Math.max(maxDepth, 7);
            _findGameRecursive(root, namesLower, partialsLower, matches, d, 0, startTime, deadlineMs, true);
        }
    }

    if (matches.length === 0 && (Date.now() - startTime) < deadlineMs) {
        for (const root of dedupLikelyMid) {
            if ((Date.now() - startTime) > deadlineMs) break;
            _findGameRecursive(root, namesLower, partialsLower, matches, Math.max(maxDepth, 6), 0, startTime, deadlineMs, true);
        }
    }

    if (matches.length === 0 && (Date.now() - startTime) < deadlineMs) {
        for (const driveRoot of dedupFallbackDrives) {
            if ((Date.now() - startTime) > deadlineMs) break;
            _findGameRecursive(driveRoot, namesLower, partialsLower, matches, 3, 0, startTime, deadlineMs, true);
        }
    }

    const deduped = [];
    const seenPaths = new Set();
    for (const m of matches) {
        const k = path.normalize(m.path).toLowerCase();
        if (seenPaths.has(k)) continue;
        seenPaths.add(k);
        deduped.push(m);
    }

    deduped.sort((a, b) => {
        const sa = _scoreLikelihoodWrap(a.path, a.nameLower);
        const sb = _scoreLikelihoodWrap(b.path, b.nameLower);
        return sb - sa;
    });

    return deduped.map(m => m.path);
}

let _autoSearchCache = null; // { result, at }
const AUTO_SEARCH_CACHE_MS = 75 * 1000;
let _autoSearchInProgress = false;
let _autoSearchWaiters = [];
let _autoSearchStartedAt = 0;

function _runAutoSearchInternal(force) {
    if (_autoSearchInProgress) return;
    _autoSearchInProgress = true;
    _autoSearchStartedAt = Date.now();
    const deadline = Date.now() + 70000;
    const runSearch = () => {
        try {
            const paths = searchGameExecutablesSync();
            return { found: paths.length > 0, paths, path: paths[0] || null };
        } catch (_) {
            return { found: false, paths: [], path: null };
        }
    };
    const doIt = async () => {
        let result;
        try {
            const syncResultP = new Promise(resolve => setImmediate(() => resolve(runSearch())));
            const timeoutP = new Promise(resolve => setTimeout(() => resolve({ found: false, paths: [], path: null, timedOut: true }), 60000));
            result = await Promise.race([syncResultP, timeoutP]);
            result.message = result.found
                ? `Found ${result.paths.length} candidate file(s). Auto-selected the most likely match.`
                : (result.timedOut ? 'Search timed out. Use Browse File to locate HSHO.exe manually.' : 'Could not locate HSHO.exe automatically. Please use Browse File.');
        } catch (_) {
            result = { found: false, paths: [], path: null, message: 'Unexpected error during auto search. Please use Browse File.' };
        }
        _autoSearchCache = { result, at: Date.now() };
        _autoSearchInProgress = false;
        const waiters = _autoSearchWaiters;
        _autoSearchWaiters = [];
        for (const w of waiters) try { w({ searching: false, ...result }); } catch (_) {}
    };
    doIt();
}

app.get('/api/auto-search-game', async (req, res) => {
    try {
        const force = (req.query && req.query.force === '1') || false;
        const wait = (req.query && req.query.wait === '1') || false;
        const now = Date.now();
        if (!force && _autoSearchCache && (now - _autoSearchCache.at) < AUTO_SEARCH_CACHE_MS) {
            return res.json({ searching: false, ..._autoSearchCache.result });
        }
        if (_autoSearchInProgress) {
            if (!wait) {
                return res.json({ searching: true, message: 'Searching all drives for HSHO.exe... Poll again in a moment.' });
            }
            return new Promise(resolve => {
                const timer = setTimeout(() => {
                    const idx = _autoSearchWaiters.findIndex(w => w === sendRsp);
                    if (idx >= 0) _autoSearchWaiters.splice(idx, 1);
                    if (_autoSearchCache) resolve(res.json({ searching: _autoSearchInProgress, ..._autoSearchCache.result }));
                    else resolve(res.json({ searching: true, message: 'Still searching. Please poll again.' }));
                }, 45000);
                function sendRsp(payload) { clearTimeout(timer); resolve(res.json(payload)); }
                _autoSearchWaiters.push(sendRsp);
            });
        }
        _runAutoSearchInternal(force);
        if (!wait) {
            return res.json({ searching: true, message: 'Deep scan started! Scanning registry, shortcuts, and all drives thoroughly for HSHO.exe (may take up to 100s). Poll again for result.' });
        }
        return new Promise(resolve => {
            const timer = setTimeout(() => {
                const idx = _autoSearchWaiters.findIndex(w => w === sendRsp);
                if (idx >= 0) _autoSearchWaiters.splice(idx, 1);
                if (_autoSearchCache) resolve(res.json({ searching: _autoSearchInProgress, ..._autoSearchCache.result }));
                else resolve(res.json({ searching: true, message: 'Search still in progress. Poll again shortly.' }));
            }, 95000);
            function sendRsp(payload) { clearTimeout(timer); resolve(res.json(payload)); }
            _autoSearchWaiters.push(sendRsp);
        });
    } catch (err) {
        _autoSearchInProgress = false;
        return res.status(500).json({ searching: false, found: false, paths: [], error: err.message });
    }
});

// Install (Simulated)
app.post('/api/install', async (req, res) => {
    try {
        const timeoutMs = 10;
        await new Promise(resolve => setTimeout(resolve, timeoutMs));
        await db.setSetting('is_installed', 'true');
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get custom boatltpk IP setting
app.get('/api/boatltpk-ip', async (req, res) => {
    try {
        const custom = await db.getSetting('boatltpk_custom_ip');
        const currentIp = custom && custom.trim() ? custom.trim() : '127.0.0.1';
        res.json({ success: true, currentIp, custom: custom || '' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Save custom boatltpk IP
app.post('/api/set-boatltpk-ip', async (req, res) => {
    try {
        const { ip } = req.body || {};
        const trimmed = (ip || '').toString().trim();
        if (!trimmed) {
            return res.status(400).json({ error: 'IP is required (e.g. 192.168.1.10)' });
        }
        const ipv4Ok = /^(25[0-5]|2[0-4]\d|[01]?\d\d?)(\.(25[0-5]|2[0-4]\d|[01]?\d\d?)){3}$/.test(trimmed);
        if (!ipv4Ok) {
            return res.status(400).json({ error: 'Invalid IPv4 format. Example: 192.168.1.10' });
        }
        await db.setSetting('boatltpk_custom_ip', trimmed);
        invalidateHostsStatusCache();
        res.json({ success: true, ip: trimmed });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get hosts file status (per-domain IP + present flag) — short-TTL result cache
// Hosts file almost never changes between explicit "apply" button clicks, so heavy cache is safe
const _computeHostsStatus = async () => {
    const settings = await db.getAllSettings();
    const boatltpkIp = (settings.boatltpk_custom_ip && settings.boatltpk_custom_ip.trim()) ? settings.boatltpk_custom_ip.trim() : '127.0.0.1';
    const sig = boatltpkIp + '::' + TARGET_DOMAINS.join(',');
    const now = Date.now();
    if (_cachedHostsStatus && (now - _cachedHostsStatusAt) < HOSTS_STATUS_TTL_MS && _cachedHostsStatusSig === sig) {
        return _cachedHostsStatus;
    }
    const hostsPath = HOSTS_FILE;
    let actualContent = '';
    try { actualContent = fs.readFileSync(hostsPath, 'utf8'); } catch (_) {}
    const entries = TARGET_DOMAINS.map(d => {
        const expectedIp = d === 'boatltpk' ? boatltpkIp : '127.0.0.1';
        const present = new RegExp(`^${expectedIp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+${d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'im').test(actualContent);
        return { domain: d, ip: expectedIp, present };
    });
    const allOk = entries.every(e => e.present);
    _cachedHostsStatus = { allOk, entries };
    _cachedHostsStatusAt = now;
    _cachedHostsStatusSig = sig;
    return _cachedHostsStatus;
};

app.get('/api/hosts-status', async (req, res) => {
    try {
        const force = req.query && req.query.force === '1';
        if (force) invalidateHostsStatusCache();
        const result = await _computeHostsStatus();
        res.json({ success: true, allOk: result.allOk, entries: result.entries });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Apply hosts file entries manually (on/off)
app.post('/api/apply-hosts', async (req, res) => {
    try {
        const enable = req.body && req.body.enable !== undefined ? req.body.enable : true;
        try {
            await modifyHostsFile(enable);
        } catch (modifyErr) {
            const isPerm = modifyErr.code === 'EPERM' || modifyErr.code === 'EACCES';
            return res.status(500).json({
                error: isPerm ? 'Permission Denied - Please run Launcher as ADMINISTRATOR.' : modifyErr.message,
                permission: isPerm
            });
        }
        const hostsPath = HOSTS_FILE;
        let actualContent = '';
        try { actualContent = fs.readFileSync(hostsPath, 'utf8'); } catch (_) {}
        const boatltpkIp = await getDomainIp('boatltpk');
        const entries = TARGET_DOMAINS.map(d => {
            const expectedIp = d === 'boatltpk' ? boatltpkIp : '127.0.0.1';
            const present = new RegExp(`^${expectedIp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+${d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'im').test(actualContent);
            return { domain: d, ip: expectedIp, present };
        });
        res.json({ success: true, entries });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Launch Game — Mutex-locked, monitors game exit for auto-cleanup, proper rollback on failure
app.post('/api/launch', async (req, res) => {
    if (_LAUNCH_MUTEX.running) {
        return res.status(409).json({ error: 'Launch is already in progress. Please wait...' });
    }
    _LAUNCH_MUTEX.running = true;

    let rollbackHosts = false;
    try {
        const settings = await db.getAllSettings();
        const gamePath = settings.game_path || '';
        const serverAddress = settings.server_address || '';

        if (!gamePath) {
            return res.status(400).json({ error: 'Game path not configured. Please select HSHO.exe first.' });
        }

        if (!fs.existsSync(gamePath)) {
            return res.status(400).json({ error: `Game executable not found at: ${gamePath}` });
        }

        const exeName = path.basename(gamePath);
        const isRunning = await isProcessRunning(exeName);
        if (isRunning) {
            return res.json({ success: true, message: 'Game is already running' });
        }

        const args = [];
        addProxyLog(`[Launch] Game Path: ${gamePath}`);

        const steamRunning = await checkSteamRunning();

        if (!steamRunning) {
            return res.status(400).json({
                error: 'Steam is not running!\n\nPlease:\n1. Start Steam\n2. Login to your account\n3. Open your Friends List'
            });
        }

        const gameDir = path.dirname(gamePath);
        const steamAppidLocations = [
            path.join(gameDir, 'steam_appid.txt'),
            path.join(gameDir, 'HSHO', 'Binaries', 'Win64', 'steam_appid.txt')
        ];
        for (const loc of steamAppidLocations) {
            try {
                const dir = path.dirname(loc);
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                fs.writeFileSync(loc, '480', 'utf8');
            } catch (e) {
                addProxyLog(`[Launch] WARN: steam_appid.txt write failed at ${loc}: ${e.message}`);
            }
        }

        addProxyLog('[Launch] Applying hosts file redirection...');
        await modifyHostsFile(true);
        rollbackHosts = true;

        const forcedTarget = FORCED_PROXY_TARGET;
        addProxyLog(`[Launch] Starting HTTPS proxy -> ${forcedTarget}:443`);
        startProxy(forcedTarget, 443);

        await new Promise(r => setTimeout(r, 250));

        const cwd = gameDir;
        addProxyLog(`[Launch] Spawning ${exeName} in ${cwd}`);
        let child;
        try {
            child = spawn(gamePath, args, {
                cwd,
                detached: true,
                stdio: 'ignore',
                env: process.env
            });
        } catch (spawnErr) {
            throw new Error(`Failed to launch game: ${spawnErr.message}`);
        }

        child.on('error', (err) => {
            addProxyLog(`[Launch] ERROR spawn failed: ${err.message}`);
            modifyHostsFile(false).catch(() => {});
            stopProxy().catch(() => {});
        });

        const startedPid = child.pid;
        child.unref();

        _startGameMonitor(startedPid, async () => {
            addProxyLog(`[Game Monitor] Auto-cleanup after game exit.`);
            await modifyHostsFile(false).catch(() => {});
            await stopProxy().catch(() => {});
        });

        res.json({ success: true, pid: startedPid });
    } catch (err) {
        addProxyLog(`[Launch] ERROR: ${err.message}`);
        if (rollbackHosts) {
            modifyHostsFile(false).catch(() => {});
            stopProxy().catch(() => {});
        }
        res.status(500).json({ error: err.message });
    } finally {
        _LAUNCH_MUTEX.running = false;
    }
});

// Stop Game — kills process, reverts hosts, stops proxy, clears monitor
app.post('/api/stop', async (req, res) => {
    try {
        if (_gameMonitorTimer) {
            clearInterval(_gameMonitorTimer);
            _gameMonitorTimer = null;
            _lastGamePid = 0;
        }

        const gamePath = await db.getSetting('game_path');
        let stopped = false;
        if (gamePath && fs.existsSync(gamePath)) {
            const exeName = path.basename(gamePath);
            try { await killProcess(exeName); stopped = true; } catch(_) {}
        }

        await modifyHostsFile(false).catch(() => {});
        await stopProxy().catch(() => {});

        res.json({ success: true, message: stopped ? 'Game stopped & cleaned up' : 'Cleanup completed' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Reset Settings
app.post('/api/reset', async (req, res) => {
    try {
        await db.setSetting('game_path', '');
        await db.setSetting('is_installed', 'false');
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Fix All Settings
app.post('/api/fix-all', async (req, res) => {
    addProxyLog('--- [REPAIR] Full System Repair Started ---');
    try {
        // 1. Reset Hosts File to prevent connection issues during the process
        addProxyLog('[REPAIR] Step 1: Restoring hosts file to default.');
        await modifyHostsFile(false);
        addProxyLog('[REPAIR] Step 1: Hosts file restored successfully.');

        // 2. Clean and Re-generate/Re-install the certificate
        addProxyLog('[REPAIR] Step 2: Starting certificate cleanup and regeneration...');
        const certResult = await generateAndInstallCertificate(false, true); // cleanOld = true is critical here
        addProxyLog(`[REPAIR] Step 2: Certificate process finished. Manual action required: ${certResult.manual}`);

        // 3. Re-apply Hosts File Redirection
        addProxyLog('[REPAIR] Step 3: Re-applying hosts file redirection...');
        await modifyHostsFile(true);
        addProxyLog('[REPAIR] Step 3: Hosts file redirection applied.');

        // 4. Ensure Firewall Rule exists
        addProxyLog('[REPAIR] Step 4: Ensuring firewall rule for HTTPS port exists...');
        if (process.platform === 'win32') {
            const ruleName = "MalakorProxyHTTPS";
            exec(`netsh advfirewall firewall show rule name="${ruleName}"`, (err, stdout) => {
                if (err || !stdout.includes(ruleName)) {
                    exec(`netsh advfirewall firewall add rule name="${ruleName}" dir=in action=allow protocol=TCP localport=443 profile=any`, (addErr) => {
                        if (addErr) {
                            addProxyLog(`[REPAIR] Step 4 WARN: Failed to add firewall rule. ${addErr.message}`);
                        } else {
                            addProxyLog('[REPAIR] Step 4: Firewall rule created successfully.');
                        }
                    });
                } else {
                    addProxyLog('[REPAIR] Step 4: Firewall rule already exists.');
                }
            });
        }

        addProxyLog('--- [REPAIR] Full System Repair Completed ---');
        res.json({ 
            success: true, 
            message: 'System repair process completed. Check logs for details.', 
            manual: certResult.manual, // Pass the manual flag to the UI
            log: certResult.message    // Pass the specific message from cert generation
        });

    } catch (err) {
        addProxyLog(`[REPAIR] CRITICAL ERROR: Full repair failed. ${err.message}`);
        console.error("[REPAIR] Full repair failed:", err);
        res.status(500).json({ error: `Repair process failed: ${err.message}` });
    }
});

// Fix CA Certificate (Legacy/Specific)
app.post('/api/fix-ca', async (req, res) => {
    try {
        addProxyLog('--- MANUAL CA REPAIR REQUESTED (ERROR 3 FIX) ---');
        // forceManual=true to ensure user interaction if auto fails
        const result = await generateAndInstallCertificate(true, true); 
        res.json({ 
            success: true, 
            message: result.message || 'Certificate re-generated and installed.',
            manual: result.manual 
        });
    } catch (err) {
        addProxyLog(`CRITICAL: CA Fix failed: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

// --- AUTO UPDATE ENDPOINTS (Game Patch + App Version) ---
// Shared: load npoint config once with short TTL to avoid spamming
let _cachedConfig = null;
let _cachedConfigAt = 0;
const CONFIG_TTL_MS = 45000;

// Periodic main-process memory cleanup (non-blocking hint)
setInterval(() => {
    try { global.gc && global.gc(); } catch (_) {}
    // Drop process cache when idle to release Set memory
    if (_processCache && (Date.now() - _processCacheAt) > 60000) {
        _processCache = null;
    }
}, 60000).unref();

const loadRemoteConfig = async () => {
    const now = Date.now();
    if (_cachedConfig && (now - _cachedConfigAt) < CONFIG_TTL_MS) return _cachedConfig;
    const { data } = await axios.get(Updater.prototype.configUrl || 'https://api.npoint.io/d2f1a6192837d901e8f9', {
        headers: { 'Cache-Control': 'no-cache' },
        timeout: 10000
    });
    _cachedConfig = data;
    _cachedConfigAt = now;
    return data;
};

// 1) Check Game Patch + App Version in ONE CALL (so UI doesn't need double fetch)
app.get('/api/check-update', async (req, res) => {
    if (_updateCheckInProgress) {
        return res.json({ game: { update: false }, app: { update: false }, update: false, _checking: true });
    }
    _updateCheckInProgress = true;
    addProxyLog('[SYSTEM] Update check requested');
    try {
        const gamePath = await db.getSetting('game_path');
        const checkPath = gamePath ? path.dirname(gamePath) : __dirname;
        const updater = new Updater(checkPath, addProxyLog);
        const remoteConfig = await loadRemoteConfig();

        // Game patch check via Updater (reads local version.json, compares to remote.version)
        let gameUpdate = null;
        try {
            const localVersion = updater.getLocalVersion();
            addProxyLog(`[Updater] Local game version: v${localVersion}, Remote: v${remoteConfig?.version || '?'}`);
            if (remoteConfig && remoteConfig.version && remoteConfig.version !== localVersion) {
                gameUpdate = {
                    update: true,
                    version: remoteConfig.version,
                    description: remoteConfig.description || '',
                    downloadUrl: remoteConfig.downloadUrl
                };
            } else {
                gameUpdate = { update: false, version: localVersion };
            }
        } catch (e) {
            addProxyLog(`[Updater WARN] Game patch check fallback: ${e.message}`);
            const fallback = await updater.checkUpdate();
            gameUpdate = fallback || { update: false };
        }

        // App version check (compare package.json embedded version vs remote.appVersion)
        let appUpdate = { update: false };
        try {
            const localAppVersion = (require('./package.json') || {}).version || '0.0.0';
            addProxyLog(`[Updater] Local app version: v${localAppVersion}, Remote: v${remoteConfig?.appVersion || '?'}`);
            if (remoteConfig && remoteConfig.appVersion && remoteConfig.appVersion !== localAppVersion) {
                appUpdate = {
                    update: true,
                    appVersion: remoteConfig.appVersion,
                    appDescription: remoteConfig.appDescription || '',
                    appDownloadUrl: remoteConfig.appDownloadUrl
                };
            } else {
                appUpdate = { update: false, appVersion: localAppVersion };
            }
        } catch (_) {}

        res.json({
            game: gameUpdate,
            app: appUpdate,
            // Backward-compat fields for old UI that reads top-level:
            update: !!gameUpdate && gameUpdate.update,
            ...(gameUpdate && gameUpdate.update ? gameUpdate : {})
        });
    } catch (err) {
        console.error("[Update Check Error]:", err);
        addProxyLog(`[ERROR] Update check failed: ${err.message}`);
        res.status(500).json({ error: err.message });
    } finally {
        _updateCheckInProgress = false;
    }
});

// 2) Start GAME patch download + extract (progress logged for UI polling)
let _updateProgress = { percent: 0, status: 'idle', ts: 0 };

app.get('/api/update-progress', (req, res) => {
    res.json(_updateProgress);
});

app.post('/api/start-update', async (req, res) => {
    let _timedOut = false;
    let _responded = false;
    const _safeSendError = (statusCode, errMsg) => {
        if (_responded) return;
        _responded = true;
        addProxyLog(`[Update Error] ${errMsg}`);
        _updateProgress = { percent: _updateProgress.percent || 0, status: 'Failed', ts: Date.now(), error: errMsg };
        res.status(statusCode).json({ error: errMsg });
    };
    const _safeSendSuccess = (payload) => {
        if (_responded) return;
        _responded = true;
        _updateProgress = { percent: 100, status: 'Update complete!', ts: Date.now(), error: null };
        res.json(payload);
    };
    try {
        const { downloadUrl } = req.body;
        if (!downloadUrl) return _safeSendError(400, 'Download URL is required.');

        const gamePath = await db.getSetting('game_path');
        if (!gamePath) return _safeSendError(400, 'Game path not set. Cannot apply patch.');
        const updater = new Updater(path.dirname(gamePath), addProxyLog);

        _updateProgress = { percent: 0, status: 'Preparing...', ts: Date.now(), error: null };
        let lastPush = 0;

        const updateTimeoutMs = 25 * 60 * 1000;
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error('Update process timeout (exceeded 25 minutes).')), updateTimeoutMs);
        });

        const updatePromise = updater.downloadAndExtract(downloadUrl, (percent, status) => {
            const now = Date.now();
            if (now - lastPush > 200 || percent >= 100 || percent === 0) {
                lastPush = now;
                _updateProgress = { percent: Math.min(100, Math.max(0, Math.round(percent || 0))), status: status || '', ts: now, error: null };
            }
        });

        await Promise.race([updatePromise, timeoutPromise]);

        _safeSendSuccess({ success: true, message: 'Update completed successfully.' });
    } catch (err) {
        _safeSendError(500, err.message || 'Unknown update error.');
    }
});

module.exports = { app, initializeServer };
