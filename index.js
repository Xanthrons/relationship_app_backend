const express = require('express');
const cors = require('cors');
const http = require('http'); 
const { Server } = require('socket.io'); 
require('dotenv').config();
const { pool } = require('./config/db');
const initPunishmentCron = require('./jobs/punishmentCron');

// --- 1. IMPORT ROUTERS ---
const authRoutes = require('./routers/authRouter');
const userRoutes = require('./routers/userRoutes');
const relationshipRoutes = require('./routers/relationshipRoutes');
const notificationRoutes = require('./routers/notificationRoutes');
const moodRoutes = require('./routers/moodRoutes');
const highlightRoutes = require('./routers/highlightRoutes');
const dailyRoutes = require('./routers/dailyRoutes'); // Fixed typo from 'dailRoutes'
const questRoutes = require('./routers/questRoutes');      // NEW
const punishmentRoutes = require('./routers/punishmentRoutes'); // NEW
const dashboardRoutes = require('./routers/dashboardRoutes');   // NEW

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

app.set('socketio', io);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- 4. SOCKET EVENT LOGIC ---
// --- 4. SOCKET EVENT LOGIC (Update) ---
io.on('connection', (socket) => {
    console.log('⚡ User connected:', socket.id);

    // Join a room based on couple_id so partners can talk to each other
    socket.on('join_couple_room', (coupleId) => {
        if (!coupleId) return;
        socket.join(`couple_${coupleId}`);
        console.log(`👨‍❤️‍👨 User joined couple room: couple_${coupleId}`);
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

// Mount the routers
app.use('/api/auth', authRoutes);        
app.use('/api/user', userRoutes);       
app.use('/api/relationship', relationshipRoutes); 
app.use('/api/notifications', notificationRoutes);
app.use('/api/moods', moodRoutes);
app.use('/api/highlights', highlightRoutes);
app.use('/api/daily', dailyRoutes);
app.use('/api/quests', questRoutes);           // MOUNTED
app.use('/api/punishments', punishmentRoutes); // MOUNTED
app.use('/api/dashboard', dashboardRoutes);     // MOUNTED

// --- 7. GLOBAL ERROR HANDLING ---
app.use((err, req, res, next) => {
    console.error("🔥 SERVER_ERROR:", err.stack);
    res.status(500).json({ error: 'Internal Server Error' });
});

// Initialize Cron Jobs
initPunishmentCron();

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
    console.log(`🚀 Server + WebSockets running on port ${PORT}`);
});