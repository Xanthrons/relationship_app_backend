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
        
        // 1. Update User Identity AND set onboarded = true for the creator
        // because they just answered all their questions.
        await dbClient.query(
            'UPDATE users SET nickname = $1, avatar_id = $2, gender = $3, onboarded = true WHERE id = $4',
            [nickname, avatar_id, gender, userId]
        );

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
    const userId = req.user.id; 
    const { inviteCode } = req.body; // Joiners don't need to send nickname if they are already onboarded
    const dbClient = await pool.connect();

    try {
        await dbClient.query('BEGIN');

        // 1. Find User B's (the Joiner) current couple status
        const userB = await dbClient.query(
            'SELECT couple_id, onboarded FROM users WHERE id = $1', 
            [userId]
        );
        const oldCoupleId = userB.rows[0]?.couple_id;
        const alreadyOnboarded = userB.rows[0]?.onboarded;

        // 2. Find User A's (the Creator) world using the invite code
        const targetCoupleRes = await dbClient.query(
            `SELECT id, creator_id FROM couples 
             WHERE TRIM(UPPER(invite_code)) = $1 AND status = 'waiting'`,
            [inviteCode.trim().toUpperCase()]
        );

        if (targetCoupleRes.rows.length === 0) {
            await dbClient.query('ROLLBACK');
            return res.status(400).json({ error: "Invalid or expired invite code." });
        }

        const newCoupleId = targetCoupleRes.rows[0].id;

        // 3. CLEANUP: Delete User B's old solo world so they can't invite others to it
        if (oldCoupleId && oldCoupleId !== newCoupleId) {
            // We only delete if it's a 'waiting' world where they were the creator
            await dbClient.query(
                "DELETE FROM couples WHERE id = $1 AND creator_id = $2 AND status = 'waiting'",
                [oldCoupleId, userId]
            );
        }

        // 4. LINK USER B TO USER A's WORLD
        await dbClient.query(
    `UPDATE users SET couple_id = $1, nickname = $2, avatar_id = $3 WHERE id = $4`,
    [newCoupleId, req.body.nickname, req.body.avatar_id, userId]
);

        // 5. FINALIZE THE COUPLE RECORD
        await dbClient.query(
            "UPDATE couples SET partner_id = $1, status = 'full' WHERE id = $2",
            [userId, newCoupleId]
        );

        await dbClient.query('COMMIT');
        
        res.json({ 
            message: "Joined successfully!", 
            onboarded: alreadyOnboarded 
        });
    } catch (err) {
        await dbClient.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ error: "Failed to join partner." });
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
        // Fetch everything we need for the user and their couple status
        const userRes = await pool.query(
            `SELECT u.id, u.onboarded, u.couple_id, c.status as couple_status 
             FROM users u 
             LEFT JOIN couples c ON u.couple_id = c.id 
             WHERE u.id = $1`,
            [userId]
        );

        const user = userRes.rows[0];

        // This is the data object the TrafficController and Dashboard will use
        res.json({
            id: user.id,
            onboarded: user.onboarded, // This fixes the redirect loop
            mode: user.couple_id 
                ? (user.couple_status === 'full' ? 'couple' : 'waiting') 
                : 'solo',
            // Add placeholder data for your future Dashboard.jsx here
            partner: null, 
            stats: {}
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Internal Server Error" });
    }
};

exports.getDashboardDetails = async (req, res) => {
    const userId = req.user.id;
    try {
        const result = await pool.query(`
            SELECT 
                u.couple_id,
                c.invite_code,
                p.nickname as partner_nickname,
                p.avatar_id as partner_avatar_id,
                p.onboarded as partner_onboarded
            FROM users u
            JOIN couples c ON u.couple_id = c.id
            LEFT JOIN users p ON (c.partner_id = p.id OR c.creator_id = p.id) AND p.id != $1
            WHERE u.id = $1
        `, [userId]);

        if (result.rows.length === 0) return res.status(404).json({ error: "No dashboard data" });
        
        const data = result.rows[0];
        res.json({
            inviteCode: data.invite_code,
            partner_nickname: data.partner_nickname,
            partner_avatar_id: data.partner_avatar_id,
            partner_onboarded: data.partner_onboarded // Tells creator if partner is still in WelcomeQuestions
        });
    } catch (err) {
        res.status(500).json({ error: "Error fetching dashboard details" });
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
            await dbClient.query('ROLLBACK');
            return res.status(400).json({ error: "Not in a relationship." });
        }

        // 1. Reset both users to Solo Mode 
        // We REMOVED "gender = NULL" and "onboarded = false"
        // This keeps your nickname, avatar, and "onboarded" status intact.
        await dbClient.query(
            'UPDATE users SET couple_id = NULL WHERE couple_id = $1', 
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
    const dbClient = await pool.connect();
    
    try {
        await dbClient.query('BEGIN');

        const userRes = await dbClient.query('SELECT couple_id FROM users WHERE id = $1', [userId]);
        const coupleId = userRes.rows[0]?.couple_id;

        if (!coupleId) {
            await dbClient.query('ROLLBACK');
            return res.status(400).json({ error: "No couple connection found" });
        }

        // 1. Save individual answers into the JSONB column
        // We use the UserID as a key so both partners' answers live in one object
        await dbClient.query(
            `UPDATE couples SET answers = COALESCE(answers, '{}'::jsonb) || $1::jsonb WHERE id = $2`,
            [JSON.stringify({ [userId]: answers }), coupleId]
        );

        // 2. IMPORTANT: Set THIS user to onboarded = true
        // This allows them to move from WelcomeQuestions -> Dashboard
        await dbClient.query('UPDATE users SET onboarded = true WHERE id = $1', [userId]);
        
        await dbClient.query('COMMIT');
        res.json({ message: "Answers saved!", success: true });
    } catch (err) {
        await dbClient.query('ROLLBACK');
        res.status(500).json({ error: "Server failed to finalize onboarding" });
    } finally {
        dbClient.release();
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
  const userId = req.user.id;

  try {
    const result = await pool.query(`
      SELECT 
        u.id, u.name, u.nickname, u.couple_id, u.onboarded, u.avatar_id,
        c.invite_code, c.status as couple_status, c.creator_id, c.rel_status
      FROM users u
      LEFT JOIN couples c ON u.couple_id = c.id
      WHERE u.id = $1
    `, [userId]);

    const row = result.rows[0];
    if (!row) return res.status(404).json({ error: "User not found" });

    // Determine the "mode" for the TrafficController logic in App.jsx
    let mode = "solo";
    if (row.couple_id) {
        // If the couple record exists but status is waiting, user is in 'waiting' mode
        mode = (row.couple_status === 'full') ? "couple" : "waiting";
    }

    res.json({
      id: row.id,
      name: row.name,
      nickname: row.nickname,
      avatar_id: row.avatar_id,
      coupleId: row.couple_id,
      onboarded: row.onboarded, 
      mode: mode,               
      inviteCode: row.invite_code,
      inviteLink: row.invite_code ? generateInviteLink(row.invite_code) : null,
      isCreator: row.creator_id === userId
    });

  } catch (err) {
    res.status(500).json({ error: "Failed to fetch user data" });
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
        // 1. VALIDATION: Check if user exists
        const user = await userModel.findByEmail(email);
        
        if (!user) {
            // We stop here if the email isn't in our system
            return res.status(404).json({ error: "No account found with this email address." });
        }

        // 2. GENERATE CODE
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        const hashedCode = await hashing.hashPassword(code);
        const expires = new Date(Date.now() + 10 * 60000); // 10 minutes
        
        // 3. UPDATE DATABASE
        await pool.query(
            'UPDATE users SET reset_code = $1, reset_expires = $2 WHERE email = $3', 
            [hashedCode, expires, email]
        );
        
        // 4. ATTEMPT EMAIL
        const emailHtml = `
            <div style="font-family: sans-serif; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
                <h1 style="color: #f43f5e;">${code}</h1>
                <p>Your TwoFold reset code. It expires in 10 minutes.</p>
            </div>`;

        try {
            await sendEmail(email, "Reset Code", emailHtml);
            return res.json({ message: "Reset code sent! Check your inbox." });
        } catch (emailErr) {
            // Log this specific error to your terminal so you can see the Gmail/SMTP error
            console.error("Mailer Error:", emailErr);
            return res.status(500).json({ error: "The email server is busy. Please try again in a few minutes." });
        }

    } catch (err) { 
        console.error("Database/Server Error:", err);
        return res.status(500).json({ error: "Something went wrong on our end." }); 
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
    const { nickname, avatar_id, rel_status } = req.body; // Added rel_status
    const dbClient = await pool.connect();

    try {
        await dbClient.query('BEGIN');

        // 1. Update User Data
        const userUpdate = await dbClient.query(
            `UPDATE users SET 
             nickname = COALESCE($1, nickname), 
             avatar_id = COALESCE($2, avatar_id) 
             WHERE id = $3 RETURNING couple_id`,
            [nickname, avatar_id, userId]
        );

        // 2. Update Couple Data (if rel_status is provided)
        if (rel_status && userUpdate.rows[0].couple_id) {
            await dbClient.query(
                `UPDATE couples SET rel_status = $1 WHERE id = $2`,
                [rel_status, userUpdate.rows[0].couple_id]
            );
        }

        await dbClient.query('COMMIT');
        res.json({ message: "Profile updated!" });
    } catch (err) {
        await dbClient.query('ROLLBACK');
        res.status(500).json({ error: "Failed to update" });
    } finally {
        dbClient.release();
    }
};