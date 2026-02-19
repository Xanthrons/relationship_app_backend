const express = require('express');
const cors = require('cors');
const http = require('http'); 
const { Server } = require('socket.io'); 
require('dotenv').config();
const { pool } = require('./config/db');
const authRoutes = require('./routers/authRouter');

const app = express();
const server = http.createServer(app); 

// --- 1. CONFIGURE CORS PROPERLY ---
const allowedOrigins = [
    "http://localhost:5173", 
    "http://localhost:3000", 
    process.env.FRONTEND_URL
].filter(Boolean);

// App-level CORS
app.use(cors({
    origin: allowedOrigins,
    credentials: true
}));

// Socket.io CORS
const io = new Server(server, {
    cors: {
        origin: allowedOrigins,
        methods: ["GET", "POST"],
        credentials: true
    },
    // Add this to handle the "WebSocket closed" issues during handshakes
    transports: ['polling', 'websocket'] 
});

app.set('socketio', io);

const PORT = process.env.PORT || 5000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- 2. SOCKET LOGIC ---
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('join_invite_room', (inviteCode) => {
        if (!inviteCode || inviteCode === "undefined") return; // Validation
        socket.join(inviteCode);
        console.log(`User ${socket.id} joined room: ${inviteCode}`);
    });

    socket.on('disconnect', () => {
        console.log('User disconnected');
    });
});

// --- 3. DB & ROUTES (Kept the same) ---
pool.query('SELECT NOW()', (err, res) => {
    if (err) console.error('❌ Neon Connection Error:', err.stack);
    else console.log('✅ Neon Database Connected');
});

app.get('/health', (req, res) => {
    res.status(200).json({ status: 'active' });
});

app.use('/api/auth', authRoutes);

app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Internal Server Error' });
});

server.listen(PORT, () => {
    console.log(`🚀 Server + WebSockets running on port ${PORT}`);
});