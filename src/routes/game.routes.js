const express = require('express');
const router = express.Router();

// เส้นทางสำหรับดักจับการหาห้องด่วน (QuickMatchMaking) จากตัวเกม Home Sweet Home Online
router.post('/matchmaking', async (req, res) => {
    try {
        const { Type, State, Data, SteamID, Name } = req.body;

        // ตรวจสอบโครงสร้างข้อมูลที่ดักจับได้ตามที่คุณส่งมาในภาพแรก
        if (Type === 'QuickMatchMaking' && State === 'GetSearchingState') {
            console.log(`[Matchmaking] ผู้เล่น ${Name} (${SteamID}) กำลังกดค้นหาห้อง...`);

            // ตอบกลับโครงสร้าง JSON สัญญาณตอบรับสำเร็จเป๊ะๆ ตามที่ตัวเกมต้องการ
            return res.json({
                data: {
                    logged: true
                },
                error: null,
                status: 1
            });
        }

        // กรณีที่มีการเรียกเข้ามาแต่ไม่ใช่การหาห้องด่วน
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

module.exports = router;
