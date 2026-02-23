const express = require('express');
const cors = require('cors');
const http = require('http'); 
const { Server } = require('socket.io'); 
require('dotenv').config();
const { pool } = require('./config/db');

// --- 1. IMPORT NEW ROUTERS ---
const authRoutes = require('./routers/authRouter');
const userRoutes = require('./routers/userRoutes');
const relationshipRoutes = require('./routers/relationshipRoutes');

const app = express();
const server = http.createServer(app); 

// --- 2. CORS CONFIGURATION ---
const allowedOrigins = [
    "http://localhost:5173", 
    "http://localhost:3000", 
    process.env.FRONTEND_URL
].filter(Boolean);

app.use(cors({
    origin: allowedOrigins,
    credentials: true
}));

// --- 3. SOCKET.IO SETUP ---
const io = new Server(server, {
    cors: {
        origin: allowedOrigins,
        methods: ["GET", "POST"],
        credentials: true
    },
    transports: ['polling', 'websocket'] 
});

// Make io accessible in our controllers if needed
app.set('socketio', io);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- 4. SOCKET EVENT LOGIC ---
io.on('connection', (socket) => {
    console.log('⚡ User connected:', socket.id);

    socket.on('join_invite_room', (inviteCode) => {
        if (!inviteCode || inviteCode === "undefined") return;
        socket.join(inviteCode);
        console.log(`👥 User joined room: ${inviteCode}`);
    });

    socket.on('disconnect', () => {
        console.log('🔌 User disconnected');
    });
});

// --- 5. DATABASE CONNECTION CHECK ---
pool.query('SELECT NOW()', (err, res) => {
    if (err) console.error('❌ Neon Connection Error:', err.stack);
    else console.log('✅ Neon Database Connected');
});

// --- 6. API ROUTES ---
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'active' });
});

// Mount the specialized routers
app.use('/api/auth', authRoutes);        
app.use('/api/user', userRoutes);       
app.use('/api/relationship', relationshipRoutes); 

// --- 7. GLOBAL ERROR HANDLING ---
app.use((err, req, res, next) => {
    console.error("🔥 SERVER_ERROR:", err.stack);
    res.status(500).json({ error: 'Internal Server Error' });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
    console.log(`🚀 Server + WebSockets running on port ${PORT}`);
});