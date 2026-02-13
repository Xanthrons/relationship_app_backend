const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { pool } = require('./config/db');

// 1. Import Routers
const authRoutes = require('./routers/authRouter');

const app = express();
const PORT = process.env.PORT || 5000;

// --- 2. MIDDLEWARES (Must come BEFORE routes) ---
app.use(cors()); 
app.use(express.json()); // <--- This MUST be above app.use('/api/auth', ...)
app.use(express.urlencoded({ extended: true }));

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
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`📡 Deployment Environment: ${process.env.NODE_ENV || 'development'}`);
});