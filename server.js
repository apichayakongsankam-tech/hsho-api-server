require('module-alias/register');
require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const config = require('@config/index');
const routes = require('@routes/index');
const Health = require('@src/Health');

const app = express();

app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

// ----------------------------------------------------
// Mongoose Model สำหรับเก็บข้อมูลห้อง (In-file Model)
// ----------------------------------------------------
const roomSchema = new mongoose.Schema({
  roomId: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  host: { type: String, default: 'System' },
  maxPlayers: { type: Number, default: 4 },
  currentPlayers: { type: Number, default: 0 },
  status: { type: String, enum: ['WAITING', 'PLAYING'], default: 'WAITING' },
  createdAt: { type: Date, default: Date.now }
});

const Room = mongoose.models.Room || mongoose.model('Room', roomSchema);

// ----------------------------------------------------
// REST API Routes สำหรับระบบค้นหาและจัดการห้อง
// ----------------------------------------------------

// 1. ดึงรายการห้องทั้งหมด
app.get('/api/rooms', async (req, res) => {
  try {
    const rooms = await Room.find().sort({ createdAt: -1 });
    res.status(200).json({ success: true, count: rooms.length, data: rooms });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Fetch rooms failed: ' + err.message });
  }
});

// 2. ค้นหาห้อง (Search by Room ID or Name)
app.get('/api/rooms/search', async (req, res) => {
  try {
    const { query } = req.query; // ตัวอย่าง: /api/rooms/search?query=ROOM001
    if (!query) {
      return res.status(400).json({ success: false, message: 'Please provide query param' });
    }

    const rooms = await Room.find({
      $or: [
        { roomId: { $regex: query,$options: 'i' } },
        { name: { $regex: query,$options: 'i' } }
      ]
    });

    res.status(200).json({ success: true, count: rooms.length, data: rooms });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Search rooms error: ' + err.message });
  }
});

// 3. ค้นหาห้องด้วย Room ID เจาะจง
app.get('/api/rooms/:roomId', async (req, res) => {
  try {
    const room = await Room.findOne({ roomId: req.params.roomId });
    if (!room) {
      return res.status(404).json({ success: false, message: 'Room not found' });
    }
    res.status(200).json({ success: true, data: room });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 4. สร้างห้องใหม่
app.post('/api/rooms/create', async (req, res) => {
  try {
    const { roomId, name, host, maxPlayers } = req.body;
    
    const existingRoom = await Room.findOne({ roomId });
    if (existingRoom) {
      return res.status(400).json({ success: false, message: 'Room ID already exists' });
    }

    const newRoom = new Room({
      roomId: roomId || `ROOM_${Math.floor(1000 + Math.random() * 9000)}`,
      name: name || 'Custom Game Room',
      host: host || 'Anonymous',
      maxPlayers: maxPlayers || 4
    });

    await newRoom.save();
    res.status(201).json({ success: true, data: newRoom });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Create room error: ' + err.message });
  }
});

// Routes เดิมของระบบ
app.use('/', routes);
app.use('/', Health);

// ----------------------------------------------------
// Socket.IO Server & Real-time Room Events
// ----------------------------------------------------
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

io.on('connection', (socket) => {
  console.log(`[Socket] User connected: ${socket.id}`);

  // Event: ค้นหาห้องผ่าน Socket
  socket.on('find_room', async (roomId) => {
    try {
      const room = await Room.findOne({ roomId });
      if (room) {
        socket.emit('room_found', { success: true, data: room });
      } else {
        socket.emit('room_found', { success: false, message: 'ไม่พบห้องที่ต้องการ' });
      }
    } catch (err) {
      socket.emit('room_found', { success: false, message: err.message });
    }
  });

  // Event: ดึงรายการห้องแบบ Real-time
  socket.on('get_all_rooms', async () => {
    try {
      const rooms = await Room.find().sort({ createdAt: -1 });
      socket.emit('room_list', rooms);
    } catch (err) {
      console.error('Fetch rooms error:', err);
    }
  });

  // Event: เข้าร่วมห้อง
  socket.on('join_room', async (data) => {
    const { roomId, username } = data;
    
    try {
      const room = await Room.findOne({ roomId });
      if (!room) {
        return socket.emit('error_message', 'Room does not exist');
      }

      socket.join(roomId);
      console.log(`[Socket] ${username || socket.id} joined room: ${roomId}`);

      // อัปเดตจำนวนผู้เล่นในห้อง
      room.currentPlayers = (room.currentPlayers || 0) + 1;
      await room.save();

      // บรอดแคสต์บอกคนในห้อง
      io.to(roomId).emit('user_joined', {
        message: `${username || socket.id} has joined the room`,
        currentPlayers: room.currentPlayers,
        user: username || socket.id
      });
    } catch (err) {
      console.error('Join room error:', err.message);
    }
  });

  // Event: ออกจากห้อง
  socket.on('leave_room', async (roomId) => {
    try {
      socket.leave(roomId);
      const room = await Room.findOne({ roomId });
      if (room && room.currentPlayers > 0) {
        room.currentPlayers -= 1;
        await room.save();
      }

      io.to(roomId).emit('user_left', {
        message: `${socket.id} left the room`,
        currentPlayers: room ? room.currentPlayers : 0
      });
    } catch (err) {
      console.error('Leave room error:', err.message);
    }
  });

  socket.on('disconnect', () => {
    console.log(`[Socket] User disconnected: ${socket.id}`);
  });
});

// ----------------------------------------------------
// Startup & Shutdown Functions
// ----------------------------------------------------
async function start() {
  try {
    // เชื่อมต่อ MongoDB ผ่าน mongoose.connect
    await mongoose.connect(config.mongo.uri, {
      dbName: config.mongo.dbName,
    });
    console.log(`MongoDB connected to: ${config.mongo.dbName}`);

    // รันผ่าน HTTP Server เพื่อให้ Socket.IO ทำงานร่วมกับ Express ได้
    server.listen(config.port, () => {
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
