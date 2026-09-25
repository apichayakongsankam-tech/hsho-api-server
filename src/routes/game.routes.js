// แปะเพิ่มลงในไฟล์ game.routes.js 
// หมายเหตุ: ปรับเปลี่ยน '/matchmaking' ให้ตรงกับ URL Endpoint ส่วนท้ายที่ตัวเกมยิงมาจริง ๆ
router.post('/matchmaking', async (req, res) => {
    try {
        const { Type, State, Data, SteamID, Name } = req.body;

        // ตรวจสอบค่าที่ส่งมาจากตัวเกมตามที่เราดักได้ในภาพ
        if (Type === 'QuickMatchMaking' && State === 'GetSearchingState') {
            console.log(`[Matchmaking] ผู้เล่น ${Name} (${SteamID}) กำลังกดหาห้อง...`);

            // ตอบกลับ JSON โครงสร้างเป๊ะ ๆ ตามที่ตัวเกมต้องการ
            return res.json({
                data: {
                    logged: true
                },
                error: null,
                status: 1
            });
        }

        // กรณีที่ Request ถูกส่งมาที่นี่แต่ไม่ใช่การหาห้องแบบ QuickMatchMaking
        return res.status(400).json({ 
            data: null, 
            error: "Invalid matchmaking request", 
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
