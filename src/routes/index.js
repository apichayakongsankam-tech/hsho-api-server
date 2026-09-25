// แปะเพิ่มลงในไฟล์ index.js ก่อนบรรทัด module.exports = router;

// หมายเหตุ: เปลี่ยน '/matchmaking' ให้ตรงกับ URL path ที่ดักได้จริง (เช่น '/matchmake', '/lobby/search')
router.post('/live/matchmaking', async (req, res) => {
  try {
    const { Type, State, Data, SteamID, Name } = req.body;

    // ตรวจสอบโครงสร้างข้อมูลที่ดักได้จากในภาพ
    if (Type === 'QuickMatchMaking' && State === 'GetSearchingState') {
      console.log(`[Matchmaking] ผู้เล่น ${Name} (${SteamID}) กำลังค้นหาห้อง...`);

      // ตอบกลับ JSON ตามรูปแบบที่เกมต้องการ
      return res.json({
        data: {
          logged: true
        },
        error: null,
        status: 1
      });
    }

    return res.status(400).json({ data: null, error: 'Invalid Type', status: 0 });
  } catch (err) {
    console.error('[Matchmaking Error]:', err.message);
    return res.status(500).json({ data: null, error: 'Internal Server Error', status: 0 });
  }
});
