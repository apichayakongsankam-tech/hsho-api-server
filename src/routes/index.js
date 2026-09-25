// เพิ่ม Route นี้เข้าไปในไฟล์ game.routes.js ของคุณ
// หมายเหตุ: ปรับเปลี่ยน '/matchmaking' ให้ตรงกับ URL Endpoint ที่ตัวเกมเรียกใช้งานจริง (เช่น '/quickmatch' หรือ '/lobby/search')
router.post('/matchmaking', async (req, res) => {
    try {
        const { Type, State, Data, SteamID, Name } = req.body;

        // ตรวจสอบโครงสร้างข้อมูลที่ดักได้ตามภาพ
        if (Type === 'QuickMatchMaking' && State === 'GetSearchingState') {
            console.log(`[Matchmaking] ผู้เล่น ${Name} (${SteamID}) กำลังค้นหาห้อง...`);

            // ตอบกลับในรูปแบบ JSON โครงสร้างตามภาพที่ได้จากตัวเกม
            return res.json({
                data: {
                    logged: true
                },
                error: null,
                status: 1
            });
        }

        // หาก Request ส่งมาแต่ไม่ใช่แบบหาห้องด่วน
        return res.status(400).json({ 
            data: null,
            error: "Invalid matchmaking type", 
            status: 0 
        });

    } catch (err) {
        console.error('[Matchmaking Error]:', err.message);
        return res.status(500).json({ 
            data: null,
            error: "Internal Server Error", 
            status: 0 
        });
    }
});
