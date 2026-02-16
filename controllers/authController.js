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

const handleAuthError = (err, customMessage = "Something went wrong") => {
    console.error("❌ AUTH_ERROR:", err.message);
    
    // Postgres Unique Violation (Email/Code already exists)
    if (err.code === '23505') {
        return { status: 400, error: "This email is already registered to a world." };
    }
    // Postgres Foreign Key Violation (Linking to something that doesn't exist)
    if (err.code === '23503') {
        return { status: 404, error: "We couldn't find that connection. Please refresh." };
    }
    // Data too long or invalid format
    if (err.code === '22001' || err.code === '22P02') {
        return { status: 400, error: "One of the fields contains invalid characters or is too long." };
    }

    return { status: 500, error: customMessage };
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
        const { status, error } = handleAuthError(err, "Failed to create your account.");
        res.status(status).json({ error });
    }
};

exports.login = async (req, res) => {
    const { email, password } = req.body;
    try {
        const user = await userModel.findByEmail(email);
        // We use generic messages for security so hackers don't know if the email exists
        if (!user) return res.status(401).json({ error: "Invalid email or password." });

        const isMatch = await hashing.comparePassword(password, user.password_hash);
        if (!isMatch) return res.status(401).json({ error: "Invalid email or password." });

        delete user.password_hash;
        const token = generateToken(user.id);
        res.json({ user, token });
    } catch (err) {
        res.status(500).json({ error: "Login currently unavailable. Try again shortly." });
    }
};

// --- ONBOARDING & PROFILE ---

exports.onboardCreator = async (req, res) => {
    const userId = req.user.id;
    
    if (!userId) {
        return res.status(401).json({ error: "Your session has expired. Please log in again." });
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

        if (userUpdate.rowCount === 0) throw new Error("USER_NOT_FOUND");

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
        // Standardized error response
        const { status, error } = handleAuthError(err, "We couldn't set up your profile. Please try again.");
        res.status(status).json({ error });
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
        return res.status(401).json({ error: "Authentication failed. Please log in again." });
    }

    const userId = req.user.id; 
    const { inviteCode, nickname, avatar_id } = req.body;

    if (!inviteCode) {
        return res.status(400).json({ error: "Please enter your partner's invite code." });
    }

    const dbClient = await pool.connect();

    try {
        await dbClient.query('BEGIN');

        const cleanCode = inviteCode.trim().toUpperCase();
        
        const targetRes = await dbClient.query(
            `SELECT c.*, u.gender as creator_gender 
             FROM couples c 
             JOIN users u ON c.creator_id = u.id 
             WHERE TRIM(UPPER(c.invite_code)) = $1 AND c.status = 'waiting'`,
            [cleanCode]
        );

        if (targetRes.rows.length === 0) {
            await dbClient.query('ROLLBACK');
            return res.status(400).json({ error: "That code is invalid or has already been used." });
        }
        
        const targetCouple = targetRes.rows[0];

        if (targetCouple.creator_id === userId) {
            await dbClient.query('ROLLBACK');
            return res.status(400).json({ error: "You cannot join your own world. Send this code to your partner!" });
        }

        // 4. GHOST CLEANUP (Restored)
        const userRes = await dbClient.query('SELECT couple_id FROM users WHERE id = $1', [userId]);
        const currentCoupleId = userRes.rows[0]?.couple_id;
        
        if (currentCoupleId && currentCoupleId !== targetCouple.id) {
            await dbClient.query("DELETE FROM couples WHERE id = $1 AND status = 'waiting'", [currentCoupleId]);
        }

        // 5. AUTO-GENDER & IDENTITY UPDATE (Restored)
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
        console.error("❌ PAIRING ERROR:", err.message);
        res.status(500).json({ error: "Connection failed. Please check the code and try again." });
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
        res.status(500).json({ error: "Failed to load dashboard. Please refresh." });
    }
};

exports.unlinkCouple = async (req, res) => {
    const userId = req.user.id; 
    const dbClient = await pool.connect();
    try {
        await dbClient.query('BEGIN');
        
        const userRes = await dbClient.query('SELECT couple_id FROM users WHERE id = $1', [userId]);
        const coupleId = userRes.rows[0]?.couple_id;

        if (!coupleId) {
            await dbClient.query('ROLLBACK'); // Explicitly rollback even on 400s for safety
            return res.status(400).json({ error: "Not in a relationship." });
        }

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
        console.error("UNLINK ERROR:", err);
        res.status(500).json({ error: "Failed to unlink. Please try again later." });
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
        const compressedBuffer = await sharp(req.file.buffer)
            .resize(1000, 1000, { fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 80 })
            .toBuffer();

        const fileBase64 = `data:image/jpeg;base64,${compressedBuffer.toString('base64')}`;

        // 4. Cloudinary "Upsert" (Overwrite)
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
        // Removed details: err.message to hide raw tech details
        res.status(500).json({ error: "Failed to sync image. Please try again." });
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
    const { error: validationError } = validateForgotPassword(req.body);
    if (validationError) return res.status(400).json({ error: validationError.details[0].message });

    const { email } = req.body;
    try {
        const user = await userModel.findByEmail(email);
        
        // If user doesn't exist, we still say "Reset code sent" 
        // to prevent people from checking if an email is registered.
        if (user) {
            const code = Math.floor(100000 + Math.random() * 900000).toString();
            const hashedCode = await hashing.hashPassword(code);
            const expires = new Date(Date.now() + 10 * 60000); 
            
            await pool.query(
                'UPDATE users SET reset_code = $1, reset_expires = $2 WHERE email = $3', 
                [hashedCode, expires, email]
            );
            
            const emailHtml = `<h1>${code}</h1><p>Your TwoFold reset code. It expires in 10 minutes.</p>`;
            await sendEmail(email, "Reset Code", emailHtml);
        }

        res.json({ message: "If that email exists, a reset code has been sent!" });
    } catch (err) { 
        res.status(500).json({ error: "We're having trouble sending emails right now." }); 
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
        res.status(500).json({ error: "Verification failed. Please try again." });
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
        res.status(500).json({ error: "Failed to update password. Please try again." }); 
    }
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

        if (result.rowCount === 0) {
            return res.status(404).json({ error: "User profile not found." });
        }

        res.json({ 
            message: "Profile updated!", 
            user: result.rows[0] 
        });
    } catch (err) {
        // Use the helper we built earlier to catch "Nickname too long" (22001)
        const { status, error } = handleAuthError(err, "We couldn't save your changes.");
        res.status(status).json({ error });
    }
};