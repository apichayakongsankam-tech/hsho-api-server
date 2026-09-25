require('module-alias/register');
require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const config = require('@config/index');
const routes = require('@routes/index');
const Health = require('@src/Health');

const app = express();

// 💡 เพิ่มระบบจำลองห้องในระดับ Memory
global.matchmakingQueue = []; // เก็บรายชื่อผู้เล่นที่กำลังหาห้อง
global.activeRooms = {};      // เก็บสถานะห้องแข่งขันที่ถูกสร้างขึ้น

app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

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
