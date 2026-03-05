const { pool } = require('../config/db');
const userModel = require('../models/userModel');
const hashing = require('../utils/hashing');
const jwt = require('jsonwebtoken');
const { sendEmail } = require('../utils/sendMail');
const { validateForgotPassword, validateResetPassword } = require('../middlewares/validator');
const { OAuth2Client } = require('google-auth-library');
const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const generateToken = (userId) => {
    return jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '30d' });
};

// --- ERROR HANDLER ---
const handleAuthError = (err, customMessage = "Something went wrong") => {
    console.error("❌ AUTH_ERROR:", err.message);
    
    // Postgres Unique Violation (e.g., Email already exists)
    if (err.code === '23505') {
        return { status: 400, error: "This email is already registered. Please login instead." };
    }
    // Postgres Foreign Key Violation
    if (err.code === '23503') {
        return { status: 404, error: "The requested connection or resource does not exist." };
    }
    // Postgres Data too long or invalid format
    if (err.code === '22001' || err.code === '22P02') {
        return { status: 400, error: "Invalid data format provided." };
    }
    // Specific JWT or Auth errors could be added here
    if (err.name === 'JsonWebTokenError') {
        return { status: 401, error: "Invalid session. Please login again." };
    }

    return { status: 500, error: customMessage };
};

// --- AUTHENTICATION ---

exports.register = async (req, res) => {
    const email = req.body.email.toLowerCase().trim();
    const { password, name } = req.body;
    try {
        const hashedPassword = await hashing.hashPassword(password);
        const user = await userModel.create(email, hashedPassword, name);
        const token = generateToken(user.id);
        res.status(201).json({ user, token });
    } catch (err) {
        const { status, error } = handleAuthError(err, "Failed to create your account.");
        res.status(status).json({ error });
    }
};

exports.login = async (req, res) => {
    const email = req.body.email.toLowerCase().trim();
    const { password } = req.body;
    try {
        const user = await userModel.findByEmail(email);
        if (!user) return res.status(401).json({ error: "Invalid email or password." });

        const isMatch = await hashing.comparePassword(password, user.password_hash);
        if (!isMatch) return res.status(401).json({ error: "Invalid email or password." });

        delete user.password_hash;
        const token = generateToken(user.id);
        res.json({ user, token });
    } catch (err) {
        const { status, error } = handleAuthError(err, "Login currently unavailable. Try again shortly.");
        res.status(status).json({ error });
    }
};

exports.googleAuth = async (req, res) => {
    const { idToken } = req.body;
    try {
        const ticket = await client.verifyIdToken({
            idToken,
            audience: process.env.GOOGLE_CLIENT_ID,
        });
        const { email, name } = ticket.getPayload();
        let userRes = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        let user = userRes.rows[0];

     if (!user) {
    const insertRes = await pool.query(
        'INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id, email, name, couple_id', 
        [email, name, 'google-auth-account']
    );
    user = insertRes.rows[0];
}

        const token = generateToken(user.id);
        res.json({ user, token });
    } catch (err) {
        const { status, error } = handleAuthError(err, "Google authentication failed.");
        res.status(status).json({ error });
    }
};

exports.forgotPassword = async (req, res) => {
    const { error: validationError } = validateForgotPassword(req.body);
    if (validationError) return res.status(400).json({ error: validationError.details[0].message });

    const { email } = req.body;

    try {
        const user = await userModel.findByEmail(email);
        if (!user) {
            return res.status(404).json({ error: "No account found with this email address." });
        }

        const code = Math.floor(100000 + Math.random() * 900000).toString();
        const hashedCode = await hashing.hashPassword(code);
        const expires = new Date(Date.now() + 10 * 60000); 

        await pool.query(
            'UPDATE users SET reset_code = $1, reset_expires = $2 WHERE email = $3', 
            [hashedCode, expires, email]
        );
        
        const emailHtml = `
            <div style="font-family: sans-serif; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
                <h1 style="color: #f43f5e;">${code}</h1>
                <p>Your TwoFold reset code. It expires in 10 minutes.</p>
            </div>`;

        try {
            await sendEmail(email, "Reset Code", emailHtml);
            return res.json({ message: "Reset code sent! Check your inbox." });
        } catch (emailErr) {
            console.error("Mailer Error:", emailErr);
            return res.status(500).json({ error: "The email server is busy. Please try again in a few minutes." });
        }

    } catch (err) { 
        const { status, error } = handleAuthError(err, "Something went wrong while requesting the reset code.");
        res.status(status).json({ error });
    }
};

exports.verifyResetCode = async (req, res) => {
    const { email, code } = req.body;
    try {
        const result = await pool.query(
            'SELECT * FROM users WHERE email = $1 AND reset_expires > NOW()',
            [email]
        );
        const user = result.rows[0];

        if (!user) return res.status(400).json({ error: "This code has expired or is invalid." });

        const isMatch = await hashing.comparePassword(code, user.reset_code);
        if (!isMatch) return res.status(400).json({ error: "That code doesn't match our records." });

        res.json({ message: "Code verified! You can now set a new password." });
    } catch (err) {
        const { status, error } = handleAuthError(err, "Verification failed. Please try again.");
        res.status(status).json({ error });
    }
};

exports.resetPassword = async (req, res) => {
    const { error: validationError } = validateResetPassword(req.body);
    if (validationError) return res.status(400).json({ error: validationError.details[0].message });

    const { email, code, newPassword } = req.body;
    try {
        const userRes = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        const user = userRes.rows[0];

        if (!user || !user.reset_expires || new Date() > user.reset_expires) {
            return res.status(400).json({ error: "Your reset session has expired. Please request a new code." });
        }

        const isMatch = await hashing.comparePassword(code, user.reset_code);
        if (!isMatch) return res.status(400).json({ error: "Invalid reset code." });

        const hashed = await hashing.hashPassword(newPassword);
        await pool.query(
            'UPDATE users SET password_hash = $1, reset_code = NULL, reset_expires = NULL WHERE email = $2', 
            [hashed, email]
        );

        res.json({ message: "Success! Your password has been updated." });
    } catch (err) { 
        const { status, error } = handleAuthError(err, "Failed to update password. Please try again.");
        res.status(status).json({ error });
    }
};