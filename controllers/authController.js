const { pool } = require('../config/db'); 
const userModel = require('../models/userModel');
const coupleModel = require('../models/coupleModel');
const hashing = require('../utils/hashing');
const jwt = require('jsonwebtoken');
const { sendEmail } = require('../utils/sendMail');
const { validateForgotPassword, validateResetPassword } = require('../middlewares/validator');
const { OAuth2Client } = require('google-auth-library');

const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
const sharp = require('sharp');

const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true // Add this for good measure
});
const generateToken = (userId) => {
    return jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '30d' });
};
const generateInviteLink = (inviteCode) => {
    const baseUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    return `${baseUrl}/join?code=${inviteCode}`;
};

// --- AUTHENTICATION ---

exports.register = async (req, res) => {
    const { email, password, name } = req.body;
    try {
        const hashedPassword = await hashing.hashPassword(password);
        const user = await userModel.create(email, hashedPassword, name);
        const token = generateToken(user.id);
        res.status(201).json({ user, token });
    } catch (err) {
        console.error("DETAILED ERROR:", err); // Look at your terminal!
        res.status(400).json({ 
            error: err.message, 
            detail: err.detail,
            hint: err.hint 
        }); 
    }
};

exports.login = async (req, res) => {
    const { email, password } = req.body;
    try {
        const user = await userModel.findByEmail(email);
        if (!user) return res.status(401).json({ error: "Invalid credentials" });

        const isMatch = await hashing.comparePassword(password, user.password_hash);
        if (!isMatch) return res.status(401).json({ error: "Invalid credentials" });

        delete user.password_hash;
        const token = generateToken(user.id);
        res.json({ user, token });
    } catch (err) {
        res.status(500).json({ error: "Server error" });
    }
};

// --- ONBOARDING & PROFILE ---

exports.onboardCreator = async (req, res) => {
    const userId = req.user.id;
    
    if (!userId) {
        return res.status(401).json({ error: "User ID not found in token" });
    }

    const { nickname, avatar_id, gender, rel_status } = req.body;
    const dbClient = await pool.connect();

    try {
        await dbClient.query('BEGIN');
        
        // 1. Update User Identity
        const userUpdate = await dbClient.query(
            'UPDATE users SET nickname = $1, avatar_id = $2, gender = $3 WHERE id = $4 RETURNING id',
            [nickname, avatar_id, gender, userId]
        );

        if (userUpdate.rowCount === 0) throw new Error("User record not found");

        // 2. Create Couple Record
        const inviteCode = Math.random().toString(36).substring(2, 8).toUpperCase();
        const coupleRes = await dbClient.query(
            'INSERT INTO couples (invite_code, creator_id, rel_status, status) VALUES ($1, $2, $3, $4) RETURNING id',
            [inviteCode, userId, rel_status, 'waiting']
        );
        const coupleId = coupleRes.rows[0].id;

        // 3. Link User to Couple
        await dbClient.query('UPDATE users SET couple_id = $1 WHERE id = $2', [coupleId, userId]);

        await dbClient.query('COMMIT');
        const inviteLink = generateInviteLink(inviteCode);

        res.status(200).json({ 
            message: "Onboarding complete!", 
            inviteCode, 
            inviteLink,
            coupleId 
        });
    } catch (err) {
        await dbClient.query('ROLLBACK');
        res.status(500).json({ error: "Onboarding failed", details: err.message });
    } finally {
        dbClient.release();
    }
};

exports.getInviteDetails = async (req, res) => {
    const userId = req.user.id;
    try {
        // Find the active invite where this user is the creator
        const result = await pool.query(
            `SELECT invite_code, rel_status FROM couples WHERE creator_id = $1 AND status = 'waiting'`,
            [userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "No active invite found. Please complete onboarding first." });
        }

        const { invite_code, rel_status } = result.rows[0];
        const inviteLink = generateInviteLink(invite_code);

        res.json({
            inviteCode: invite_code,
            inviteLink: inviteLink,
            rel_status: rel_status,
            instructions: "Share this link with your partner!"
        });
    } catch (err) {
        res.status(500).json({ error: "Server error fetching invite details" });
    }
};

exports.pairCouple = async (req, res) => {
   
    if (!req.user || !req.user.id) {
        return res.status(401).json({ error: "User authentication failed. Token missing or invalid." });
    }

    const userId = req.user.id; 
    const { inviteCode, nickname, avatar_id } = req.body;

    // 2. CRITICAL FIX: Check if inviteCode was actually sent
    if (!inviteCode) {
        return res.status(400).json({ error: "Invite code is required." });
    }

    const dbClient = await pool.connect();

    try {
        await dbClient.query('BEGIN');

        // 3. Validate Invite Code (Safe to use .trim() now)
        const cleanCode = inviteCode.trim().toUpperCase();
        
        const targetRes = await dbClient.query(
            `SELECT c.*, u.gender as creator_gender 
             FROM couples c 
             JOIN users u ON c.creator_id = u.id 
             WHERE TRIM(UPPER(c.invite_code)) = $1 AND c.status = 'waiting'`,
            [cleanCode]
        );

        if (targetRes.rows.length === 0) {
            await dbClient.query('ROLLBACK'); // Always rollback before returning error
            return res.status(400).json({ error: "Invalid or expired invite code." });
        }
        
        const targetCouple = targetRes.rows[0];

        if (targetCouple.creator_id === userId) {
            await dbClient.query('ROLLBACK');
            return res.status(400).json({ error: "You cannot join your own invite code." });
        }

        // 4. GHOST CLEANUP
        const userRes = await dbClient.query('SELECT couple_id FROM users WHERE id = $1', [userId]);
        const currentCoupleId = userRes.rows[0]?.couple_id;
        
        if (currentCoupleId && currentCoupleId !== targetCouple.id) {
            await dbClient.query("DELETE FROM couples WHERE id = $1 AND status = 'waiting'", [currentCoupleId]);
        }

        // 5. AUTO-GENDER & IDENTITY UPDATE
        const joinerGender = targetCouple.creator_gender === 'Boy' ? 'Girl' : 'Boy';

        await dbClient.query(
            `UPDATE users SET 
                nickname = COALESCE($1, nickname), 
                avatar_id = COALESCE($2, avatar_id), 
                gender = $3, 
                couple_id = $4 
             WHERE id = $5`,
            [nickname || null, avatar_id || null, joinerGender, targetCouple.id, userId]
        );

        // 6. FINALIZE COUPLE
        await dbClient.query(
            "UPDATE couples SET partner_id = $1, status = 'full' WHERE id = $2",
            [userId, targetCouple.id]
        );

        await dbClient.query('COMMIT');
        
        res.json({ 
            message: "Successfully paired!", 
            rel_status: targetCouple.rel_status, 
            coupleId: targetCouple.id 
        });
    } catch (err) {
        await dbClient.query('ROLLBACK');
        console.error("❌ PAIRING ERROR DETAIL:", err.message); // This shows in your terminal
        res.status(500).json({ error: "Internal server error during pairing.", details: err.message });
    } finally {
        dbClient.release();
    }
};

exports.getInvitePreview = async (req, res) => {
    const { code } = req.params;
    
    try {
        // We add TRIM and UPPER to make sure the match isn't failing due to a hidden space
        const result = await pool.query(
            `SELECT u.nickname, u.avatar_id, c.rel_status, c.status 
             FROM couples c 
             INNER JOIN users u ON c.creator_id = u.id 
             WHERE TRIM(UPPER(c.invite_code)) = $1`,
            [code.trim().toUpperCase()]
        );

        // If this is empty, it means either the code is wrong OR the creator_id doesn't exist in users table
        if (result.rows.length === 0) {
            return res.status(404).json({ 
                error: "Invite not found. Check if the creator still exists or if the code is correct." 
            });
        }

        const invite = result.rows[0];

        // Now check status separately so we can give a better error message
        if (invite.status !== 'waiting') {
            return res.status(400).json({ error: "This invite has already been used by someone else." });
        }

        res.json({
            creatorNickname: invite.nickname,
            creatorAvatar: invite.avatar_id,
            relationshipType: invite.rel_status,
            message: `${invite.nickname} is waiting for you to join!`
        });
    } catch (err) {
        console.error("PREVIEW ERROR:", err);
        res.status(500).json({ error: "Error fetching invite preview" });
    }
};

exports.getDashboard = async (req, res) => {
    const userId = req.user.id; 

    try {
        // 1. Get the User and their Couple info
        const userRes = await pool.query(
            `SELECT u.couple_id, u.gender, c.status, c.rel_status, c.shared_image_url, c.created_at
             FROM users u
             LEFT JOIN couples c ON u.couple_id = c.id
             WHERE u.id = $1`,
            [userId]
        );

        const userData = userRes.rows[0];

        // If no couple_id, they are strictly solo
        if (!userData || !userData.couple_id) {
            return res.json({ 
                mode: "solo", 
                message: "You are in Solo Mode. Onboard or join a partner to see your dashboard." 
            });
        }

        // 2. Find the Partner (the other person in the same couple_id)
        const partnerRes = await pool.query(
            `SELECT id, nickname, avatar_id, gender 
             FROM users 
             WHERE couple_id = $1 AND id != $2`,
            [userData.couple_id, userId]
        );

        const partner = partnerRes.rows[0] || null;

        // 3. Construct Response based on status
        res.json({
            mode: userData.status === 'full' ? 'couple' : 'waiting',
            relationship: {
                type: userData.rel_status,
                since: userData.created_at,
                sharedImage: userData.shared_image_url || null
            },
            partner: partner ? {
                nickname: partner.nickname,
                avatar_id: partner.avatar_id,
                gender: partner.gender
            } : null
        });

    } catch (err) {
        console.error("DASHBOARD ERROR:", err);
        res.status(500).json({ error: "Failed to load dashboard" });
    }
};

exports.unlinkCouple = async (req, res) => {
    const userId = req.user.id; 
    const dbClient = await pool.connect();
    try {
        await dbClient.query('BEGIN');
        
        const userRes = await dbClient.query('SELECT couple_id FROM users WHERE id = $1', [userId]);
        const coupleId = userRes.rows[0]?.couple_id;

        if (!coupleId) return res.status(400).json({ error: "Not in a relationship." });

        // 1. Reset both users to Solo Mode
        await dbClient.query(
            'UPDATE users SET couple_id = NULL, gender = NULL WHERE couple_id = $1', 
            [coupleId]
        );

        // 2. Delete the shared couple record
        await dbClient.query('DELETE FROM couples WHERE id = $1', [coupleId]);

        await dbClient.query('COMMIT');
        res.json({ message: "Unlinked successfully. You are now in Solo Mode." });
    } catch (err) {
        await dbClient.query('ROLLBACK');
        res.status(500).json({ error: "Failed to unlink." });
    } finally {
        dbClient.release();
    }
};

// --- WELCOME QUESTIONS (JSONB) ---

exports.submitWelcomeAnswers = async (req, res) => {
    const userId = req.user.id; 
    const { answers } = req.body; 
    
    try {
        const userRes = await pool.query('SELECT couple_id FROM users WHERE id = $1', [userId]);
        const coupleId = userRes.rows[0]?.couple_id;

        if (!coupleId) return res.status(400).json({ error: "No couple connection found" });

        // Merge JSONB answers
        await pool.query(
            `UPDATE couples SET answers = answers || $1 WHERE id = $2`,
            [JSON.stringify({ [userId]: answers }), coupleId]
        );
        
        res.json({ message: "Answers saved!" });
    } catch (err) {
        res.status(500).json({ error: "Failed to save answers" });
    }
};

exports.deleteAccount = async (req, res) => {
    const userId = req.user.id; 
    try {
        // This will also trigger the unlink logic if you have FK constraints set to CASCADE
        await pool.query('DELETE FROM users WHERE id = $1', [userId]);
        res.json({ message: "Account deleted." });
    } catch (err) { 
        res.status(500).json({ error: "Delete failed" }); 
    }
};

// --- SHARED MEDIA ---

exports.upsertSharedPicture = async (req, res) => {
    const dbClient = await pool.connect();

    try {
        // 1. Basic Validation
        if (!req.file) return res.status(400).json({ error: "No image file provided." });

        // 2. Identify the Couple
        const userRes = await dbClient.query('SELECT couple_id FROM users WHERE id = $1', [req.user.id]);
        const coupleId = userRes.rows[0]?.couple_id;

        if (!coupleId) {
            return res.status(400).json({ error: "No pairing found. Please pair with a partner first." });
        }

        // 3. Backend Compression (The Safety Net)
        // This ensures that even if the frontend sends a large file, our storage stays lean.
        const compressedBuffer = await sharp(req.file.buffer)
            .resize(1000, 1000, { fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 80 })
            .toBuffer();

        const fileBase64 = `data:image/jpeg;base64,${compressedBuffer.toString('base64')}`;

        // 4. Cloudinary "Upsert" (Overwrite)
        // The magic happens here: using the same public_id forces Cloudinary to replace the old file.
        console.log(`♻️ Syncing shared image for couple_${coupleId}...`);
        
        const result = await cloudinary.uploader.upload(fileBase64, {
            folder: 'twofold_shared',
            public_id: `couple_${coupleId}`, 
            overwrite: true,   // Replaces the old file on the server
            invalidate: true,  // Clears the URL from Cloudinary's global cache (CDN)
            resource_type: 'image'
        });

        // 5. Sync Database
        await dbClient.query(
            'UPDATE couples SET shared_image_url = $1 WHERE id = $2',
            [result.secure_url, coupleId]
        );

        res.json({ 
            success: true, 
            message: "Shared picture synced successfully!", 
            url: result.secure_url 
        });

    } catch (err) {
        console.error("❌ UPSERT ERROR:", err);
        res.status(500).json({ error: "Failed to sync image", details: err.message });
    } finally {
        dbClient.release();
    }
};
exports.deleteSharedPicture = async (req, res) => {
    try {
        const userRes = await pool.query('SELECT couple_id FROM users WHERE id = $1', [req.user.id]);
        const coupleId = userRes.rows[0]?.couple_id;

        if (!coupleId) return res.status(400).json({ error: "No couple found" });

        // 1. Delete from Cloudinary
        await cloudinary.uploader.destroy(`twofold_shared/couple_${coupleId}`, { invalidate: true });

        // 2. Clear from Database
        await pool.query('UPDATE couples SET shared_image_url = NULL WHERE id = $1', [coupleId]);

        res.json({ success: true, message: "Shared photo removed!" });
    } catch (err) {
        res.status(500).json({ error: "Delete failed", details: err.message });
    }
};
// --- HELPERS & ACCOUNT MANAGEMENT ---

exports.getMe = async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT users.*, couples.status as couple_status FROM users LEFT JOIN couples ON users.couple_id = couples.id WHERE users.id = $1', 
            [req.user.id]
        );
        const user = result.rows[0];
        if (!user) return res.status(404).json({ error: "User not found" });
        delete user.password_hash;
        res.json(user);
    } catch (err) {
        res.status(500).json({ error: "Server error" });
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
                'INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING *',
                [email, name, 'google-auth-account']
            );
            user = insertRes.rows[0];
        }

        const token = generateToken(user.id);
        res.json({ user, token });
    } catch (err) {
        res.status(400).json({ error: "Google authentication failed" });
    }
};

exports.forgotPassword = async (req, res) => {
    const { error } = validateForgotPassword(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });
    const { email } = req.body;
    try {
        const user = await userModel.findByEmail(email);
        if (!user) return res.status(404).json({ error: "User not found" });
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        const hashedCode = await hashing.hashPassword(code);
        const expires = new Date(Date.now() + 10 * 60000); 
        await pool.query('UPDATE users SET reset_code = $1, reset_expires = $2 WHERE email = $3', [hashedCode, expires, email]);
        const emailHtml = `<h1>${code}</h1><p>Your TwoFold reset code.</p>`;
        await sendEmail(email, "Reset Code", emailHtml);
        res.json({ message: "Reset code sent!" });
    } catch (err) { res.status(500).json({ error: "Error processing request" }); }
};
exports.verifyResetCode = async (req, res) => {
    const { email, code } = req.body;
    try {
        const result = await pool.query(
            'SELECT * FROM users WHERE email = $1 AND reset_expires > NOW()',
            [email]
        );
        const user = result.rows[0];

        if (!user) return res.status(400).json({ error: "Code expired or user not found" });

        const isMatch = await hashing.comparePassword(code, user.reset_code);
        if (!isMatch) return res.status(400).json({ error: "Incorrect verification code" });

        res.json({ message: "Code verified. You may now reset your password." });
    } catch (err) {
        res.status(500).json({ error: "Verification failed" });
    }
};

exports.resetPassword = async (req, res) => {
    const { error } = validateResetPassword(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });
    const { email, code, newPassword } = req.body;
    try {
        const userRes = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        const user = userRes.rows[0];
        if (!user || new Date() > user.reset_expires) return res.status(400).json({ error: "Code expired" });
        const isMatch = await hashing.comparePassword(code, user.reset_code);
        if (!isMatch) return res.status(400).json({ error: "Invalid code" });
        const hashed = await hashing.hashPassword(newPassword);
        await pool.query('UPDATE users SET password_hash = $1, reset_code = NULL, reset_expires = NULL WHERE email = $2', [hashed, email]);
        res.json({ message: "Password updated!" });
    } catch (err) { res.status(500).json({ error: "Reset failed" }); }
};


exports.updateProfile = async (req, res) => {
    const userId = req.user.id;
    const { nickname, avatar_id } = req.body;

    try {
        const result = await pool.query(
            `UPDATE users 
             SET nickname = COALESCE($1, nickname), 
                 avatar_id = COALESCE($2, avatar_id) 
             WHERE id = $3 
             RETURNING id, nickname, avatar_id`,
            [nickname, avatar_id, userId]
        );

        res.json({ 
            message: "Profile updated successfully", 
            user: result.rows[0] 
        });
    } catch (err) {
        console.error("UPDATE ERROR:", err);
        res.status(500).json({ error: "Failed to update profile" });
    }
};