require('module-alias/register');
require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const config = require('@config/index');
const routes = require('@routes/index');
const Health = require('@src/Health');

const app = express();

app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

// =======================================================
//  Middleware ดักจับการหาห้อง ( QuickMatchMaking / GetSearchingState )
// =======================================================
app.use((req, res, next) => {
  const body = req.body || {};
  // ดึงข้อมูลจาก Data object ที่ตัวเกมส่งมาให้ตรงตามแพ็กเก็ต[cite: 3]
  const gameData = body.Data || body;

  // ตรวจสอบ Type และ State จากตัวเกม[cite: 3]
  if (
    gameData.Type === 'QuickMatchMaking' || 
    gameData.State === 'GetSearchingState'
  ) {
    console.log('[Matchmaking]: ดักจับ Request หาห้องสำเร็จ -> ตอบกลับ status: 1');

    // โครงสร้าง Response JSON ที่ตรงกับรูปแบบของตัวเกม[cite: 3]
    return res.json({
      status: 1,
      error: null,
      data: {
        logged: true
      }
    });
  }

  next();
});

app.use('/', routes);
app.use('/', Health);

async function start() {
  try {
    await mongoose.connect(config.mongo.uri, {
      dbName: config.mongo.dbName,
    });
    console.log(`MongoDB connected to: ${config.mongo.dbName}`);

    app.listen(config.port, () => {
      console.log(`Server running on port ${config.port}`);
      console.log(`Environment: ${config.env}`);
    });
  } catch (err) {
    console.error('Startup error:', err.message);
    process.exit(1);
  }
}

async function shutdown() {
  try {
    await mongoose.connection.close();
    console.log('Shutdown complete');
    process.exit(0);
  } catch (err) {
    console.error('Error during shutdown:', err.message);
    process.exit(1);
  }
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

start();
