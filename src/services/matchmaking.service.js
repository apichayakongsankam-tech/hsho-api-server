const http = require('http');
const url = require('url');
const crypto = require('crypto');

// ตั้งค่า Domain และ Port ผ่าน Config (สามารถปรับเปลี่ยน Domain จำลองได้ที่นี่)
const CONFIG = {
    PORT: process.env.PORT || 10000,
    HOST: '0.0.0.0',
    DEFAULT_API_DOMAIN: process.env.API_DOMAIN || 'api.example-game.com',
    REQUIRED_PLAYERS: 4, // จำนวนผู้เล่นต่อ 1 ห้อง (ปรับเปลี่ยนตามโหมดเกม)
    TICKET_EXPIRE_MS: 300000 // 5 นาที
};

// -------------------------------------------------------------
// System State: Queue และ Active Sessions
// -------------------------------------------------------------
const matchQueue = [];
const activeTickets = new Map();
const activeMatches = new Map();

// -------------------------------------------------------------
// Helper Functions
// -------------------------------------------------------------
function generateId(prefix) {
    return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

function sendResponse(res, statusCode, data) {
    res.writeHead(statusCode, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    res.end(JSON.stringify(data));
}

// -------------------------------------------------------------
// Matchmaking Core Engine
// -------------------------------------------------------------
function processMatchmaking() {
    if (matchQueue.length >= CONFIG.REQUIRED_PLAYERS) {
        const players = matchQueue.splice(0, CONFIG.REQUIRED_PLAYERS);
        const matchId = generateId('MATCH');
        const serverHost = `game-node-${Math.floor(Math.random() * 10) + 1}.${CONFIG.DEFAULT_API_DOMAIN}`;
        const gamePort = 7777;

        const matchSession = {
            matchId,
            status: 'COMPLETED',
            serverIp: serverHost,
            port: gamePort,
            connectionToken: crypto.randomBytes(16).toString('hex'),
            players: players.map(p => ({ playerId: p.playerId, region: p.region })),
            createdAt: Date.now()
        };

        activeMatches.set(matchId, matchSession);

        // อัปเดตสถานะ Ticket ของผู้เล่นทุกคนในกลุ่ม
        for (const player of players) {
            const ticket = activeTickets.get(player.ticketId);
            if (ticket) {
                ticket.status = 'MATCHED';
                ticket.matchData = {
                    matchId,
                    serverUrl: `wss://${serverHost}:${gamePort}`,
                    sessionToken: matchSession.connectionToken
                };
            }
        }
    }
}

// -------------------------------------------------------------
// HTTP Router & Request Handling
// -------------------------------------------------------------
const server = http.createServer((req, res) => {
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;
    const method = req.method.toUpperCase();

    if (method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization'
        });
        return res.end();
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
        let payload = {};
        if (body) {
            try { payload = JSON.parse(body); } catch (e) {}
        }

        // 1. สร้าง Ticket ค้นหาห้อง (Create Matchmaking Ticket)
        if (method === 'POST' && (pathname === '/api/v1/matchmaking/ticket' || pathname === '/hshoapi/v1/matchmaking/find')) {
            const playerId = payload.playerId || payload.userId || generateId('USER');
            const region = payload.region || 'Asia';

            // ตรวจสอบว่ามี Ticket เดิมอยู่หรือไม่
            for (const [tId, ticket] of activeTickets.entries()) {
                if (ticket.playerId === playerId && ticket.status === 'SEARCHING') {
                    return sendResponse(res, 200, { success: true, ticketId: tId, status: 'SEARCHING' });
                }
            }

            const ticketId = generateId('TICKET');
            const ticketEntry = {
                ticketId,
                playerId,
                region,
                status: 'SEARCHING',
                createdAt: Date.now()
            };

            activeTickets.set(ticketId, ticketEntry);
            matchQueue.push({ ticketId, playerId, region });
            
            processMatchmaking();

            return sendResponse(res, 200, {
                success: true,
                code: 200,
                data: {
                    ticketId,
                    status: ticketEntry.status,
                    estimatedWaitTimeSec: 10
                }
            });
        }

        // 2. ตรวจสอบสถานะการหาห้อง (Poll Ticket Status)
        if (method === 'GET' && pathname.startsWith('/api/v1/matchmaking/ticket/')) {
            const ticketId = pathname.split('/').pop();
            const ticket = activeTickets.get(ticketId);

            if (!ticket) {
                return sendResponse(res, 404, { success: false, error: 'TICKET_NOT_FOUND' });
            }

            if (ticket.status === 'MATCHED') {
                return sendResponse(res, 200, {
                    success: true,
                    status: 'MATCHED',
                    data: ticket.matchData
                });
            }

            return sendResponse(res, 200, {
                success: true,
                status: 'SEARCHING',
                playersInQueue: matchQueue.length
            });
        }

        // 3. ยกเลิกการค้นหาห้อง (Cancel Matchmaking)
        if (method === 'POST' && (pathname === '/api/v1/matchmaking/cancel' || pathname === '/hshoapi/v1/matchmaking/cancel')) {
            const ticketId = payload.ticketId;
            const index = matchQueue.findIndex(q => q.ticketId === ticketId);

            if (index !== -1) {
                matchQueue.splice(index, 1);
            }

            if (ticketId && activeTickets.has(ticketId)) {
                activeTickets.delete(ticketId);
            }

            return sendResponse(res, 200, { success: true, message: 'Matchmaking cancelled successfully' });
        }

        // 4. บันทึก Match Log เมื่อจบเกม (Match Log API)
        if (method === 'POST' && pathname === '/logapi/v1/add/matchlog') {
            console.log('[LOG] Match Log Received:', payload);
            return sendResponse(res, 200, {
                success: true,
                code: 200,
                message: 'Match log recorded'
            });
        }

        // Default 404 Route
        sendResponse(res, 404, { success: false, error: 'ENDPOINT_NOT_FOUND' });
    });
});

// -------------------------------------------------------------
// Server Initialization with Port Handshake
// -------------------------------------------------------------
function listenServer(port) {
    server.removeAllListeners('error');
    server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.warn(`[WARN] Port ${port} occupied, trying ${port + 1}...`);
            listenServer(port + 1);
        } else {
            console.error('[ERROR] Server init error:', err);
        }
    });

    server.listen(port, CONFIG.HOST, () => {
        console.log(`[INFO] Matchmaking Server active on http://${CONFIG.HOST}:${port}`);
    });
}

listenServer(CONFIG.PORT);
