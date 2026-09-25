require('module-alias/register');
require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const config = require('@config/index');
const routes = require('@routes/index');
const Health = require('@src/Health');

const app = express();

// ตั้งค่าให้รองรับการรับส่งข้อมูลขนาดใหญ่ (สูงสุด 100mb)
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

// เชื่อมต่อเราเตอร์หลักและระบบเช็กสถานะเซิฟเวอร์
app.use('/', routes);
app.use('/', Health);

// ฟังก์ชันเริ่มต้นทำงานของเซิฟเวอร์และฐานข้อมูล
async function start() {
    try {
        // แก้ไขโครงสร้างเชื่อมต่อ MongoDB ให้ถูกต้อง
        await mongoose.connect(config.mongo.uri, {
            dbName: config.mongo.dbName,
        });
        console.log(`MongoDB connected to: ${config.mongo.dbName}`);

        // เปิดพอร์ตสำหรับรอรับการเชื่อมต่อจากตัวเกม
        app.listen(config.port, () => {
            console.log(`Server running on port ${config.port}`);
            console.log(`Environment: ${config.env}`);
        });
    } catch (err) {
        console.error('Startup error:', err.message);
        process.exit(1);
    }
}

// ฟังก์ชันสำหรับปิดเซิฟเวอร์อย่างปลอดภัยเมื่อถูกสั่งหยุดทำงาน
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

// ดักจับอีเวนต์เพื่อปิดเซิฟเวอร์แบบคลีนๆ (เช่น เมื่อกด Ctrl+C)
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// เริ่มรันระบบ
start();
