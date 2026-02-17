const express = require('express');
const cors = require('cors');
const http = require('http'); // 1. Import http
const { Server } = require('socket.io'); // 2. Import socket.io
require('dotenv').config();
const { pool } = require('./config/db');

const authRoutes = require('./routers/authRouter');

const app = express();
const server = http.createServer(app); // 3. Wrap app
const io = new Server(server, {
    cors: {
        origin: process.env.FRONTEND_URL || "http://localhost:3000",
        methods: ["GET", "POST"]
    }
});

// 4. Attach io to the app so we can use it in controllers
app.set('socketio', io);

const PORT = process.env.PORT || 5000;

app.use(cors()); 
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Socket.io Connection Logic
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // When a creator opens the modal, they join a "room" named after their invite code
    socket.on('join_invite_room', (inviteCode) => {
        socket.join(inviteCode);
        console.log(`User joined room: ${inviteCode}`);
    });

    socket.on('disconnect', () => {
        console.log('User disconnected');
    });
});

// --- 3. DATABASE CONNECTION CHECK ---
pool.query('SELECT NOW()', (err, res) => {
    if (err) {
        console.error('❌ Neon Connection Error:', err.stack);
    } else {
        console.log('✅ Neon Database Connected at:', res.rows[0].now);
    }
});

// --- 4. ROUTES ---

// Health Check
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'active', message: 'Server is purring like a kitten 🐱' });
});

// Use Auth Routes
app.use('/api/auth', authRoutes);

// --- 5. GLOBAL ERROR HANDLER ---
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Something went wrong on our end!' });
});

// --- 6. START SERVER ---
server.listen(PORT, () => {
    console.log(`🚀 Server + WebSockets running on http://localhost:${PORT}`);
});