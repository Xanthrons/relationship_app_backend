const { pool } = require('../config/db');
const cloudinary = require('cloudinary').v2;
const sharp = require('sharp');

const generateInviteLink = (inviteCode) => {
    const baseUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    return `${baseUrl}/join?code=${inviteCode}`;
};

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true
});

// --- ERROR HANDLER ---
const handleRelError = (err, customMessage = "Something went wrong") => {
    console.error("❌ RELATIONSHIP_ERROR:", err.message);
    
    if (err.code === '23505') {
        return { status: 400, error: "This operation conflicts with an existing record." };
    }
    if (err.code === '23503') {
        return { status: 404, error: "We couldn't find that connection. Please refresh." };
    }
    if (err.code === '22001' || err.code === '22P02') {
        return { status: 400, error: "One of the fields contains invalid characters or is too long." };
    }

    return { status: 500, error: customMessage };
};

exports.onboardCreator = async (req, res) => {
    const userId = req.user.id;
    const { nickname, avatar_id, gender, rel_status } = req.body;
    const dbClient = await pool.connect();

    try {
        await dbClient.query('BEGIN');

        // 1. Set Creator as Onboarded (Solo Mode)
        await dbClient.query(
            `UPDATE users SET nickname = $1, avatar_id = $2, gender = $3, onboarded = true WHERE id = $4`,
            [nickname, parseInt(avatar_id), gender, userId]
        );

        // 2. Create Couple Record
        const inviteCode = Math.random().toString(36).substring(2, 8).toUpperCase();
        const finalStatus = rel_status || 'dating';

        const coupleRes = await dbClient.query(
            `INSERT INTO couples (invite_code, creator_id, rel_status, status) 
             VALUES ($1, $2, $3, 'waiting') RETURNING id`,
            [inviteCode, userId, finalStatus]
        );
        const coupleId = coupleRes.rows[0].id;

        await dbClient.query('UPDATE users SET couple_id = $1 WHERE id = $2', [coupleId, userId]);

        await dbClient.query('COMMIT');
        res.status(200).json({ 
            message: "World created!", 
            inviteCode, 
            rel_status: finalStatus 
        });
    } catch (err) {
        await dbClient.query('ROLLBACK');
        const { status, error } = handleRelError(err, "Failed to create world.");
        res.status(status).json({ error });
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
        const { status, error } = handleRelError(err, "Error fetching invite preview");
        res.status(status).json({ error });
    }
};

exports.getDashboard = async (req, res) => {
    const userId = req.user.id;
    try {
        const result = await pool.query(`
            SELECT 
                u.id, u.onboarded, u.couple_id,
                c.status as couple_status,
                c.invite_code,
                c.rel_status,
                c.creator_id,
                c.p1_answered,
                c.p2_answered,
                c.p1_seen_reveal,
                c.p2_seen_reveal,
                p.nickname as partner_nickname,
                p.avatar_id as partner_avatar_id,
                p.onboarded as partner_onboarded
            FROM users u 
            LEFT JOIN couples c ON u.couple_id = c.id 
            LEFT JOIN users p ON (c.partner_id = p.id OR c.creator_id = p.id) AND p.id != $1
            WHERE u.id = $1`, [userId]);

        const data = result.rows[0];
        if (!data) return res.status(404).json({ error: "User not found" });

        // 1. Determine if we are in 'couple' mode or 'solo' mode
        const mode = data.couple_id && data.couple_status === 'full' ? 'couple' : 'solo';

        // 2. Notification Logic (CALCULATED ON THE FLY)
        let showRevealNotification = false;
        
        if (mode === 'couple') {
            // Identity Check: Are you the one who created the world (P1)?
            const isP1 = data.creator_id === userId;
            
            // Condition A: Both partners must have finished the welcome quiz
            const bothFinishedQuiz = data.p1_answered && data.p2_answered;
            
            // Condition B: THIS specific user hasn't dismissed the reveal yet
            const hasSeenAlready = isP1 ? data.p1_seen_reveal : data.p2_seen_reveal;
            
            // Notification is true ONLY if both are done AND you haven't seen it
            showRevealNotification = bothFinishedQuiz && !hasSeenAlready;
        }

        // 3. Send the response to the Frontend
        res.json({
            id: data.id,
            onboarded: data.onboarded, // If false, frontend redirects to Quiz
            mode: mode,
            showRevealNotification,    // If true, frontend shows the "Reveal Match" banner
            
            // Shared Details
            inviteCode: data.invite_code,
            relStatus: data.rel_status,
            
            // Partner Details (if they exist)
            partner: mode === 'couple' ? {
                nickname: data.partner_nickname,
                avatarId: data.partner_avatar_id,
                onboarded: data.partner_onboarded,
                // Tells the user if their partner is still busy with the quiz
                hasFinishedQuiz: (data.creator_id === userId) ? data.p2_answered : data.p1_answered
            } : null
        });
    } catch (err) {
        const { status, error } = handleRelError(err, "Dashboard fetch failed");
        res.status(status).json({ error });
    }
};

exports.pairCouple = async (req, res) => {
    const inviteeId = req.user.id; 
    const { inviteCode, nickname, avatar_id } = req.body; 
    const dbClient = await pool.connect();

    try {
        await dbClient.query('BEGIN');

        // 1. Find the Creator's World (The ID we are moving INTO)
        const creatorRes = await dbClient.query(
            `SELECT c.id, c.rel_status, u.gender as creator_gender 
             FROM couples c JOIN users u ON c.creator_id = u.id 
             WHERE TRIM(UPPER(c.invite_code)) = $1`,
            [inviteCode.trim().toUpperCase()]
        );

        if (creatorRes.rows.length === 0) throw new Error("Invite code not found.");
        const { id: sharedCoupleId, rel_status, creator_gender } = creatorRes.rows[0];

        // 2. Identify the Invitee's current solo ID (The one to be REMOVED)
        const inviteeRes = await dbClient.query('SELECT couple_id FROM users WHERE id = $1', [inviteeId]);
        const oldSoloId = inviteeRes.rows[0].couple_id;

        // 3. Update Invitee's Profile
        const partnerGender = creator_gender === 'Boy' ? 'Girl' : 'Boy';
        
        await dbClient.query(
            `UPDATE users SET 
                couple_id = $1, 
                nickname = COALESCE($2, nickname), 
                avatar_id = COALESCE($3, avatar_id),
                gender = $4,
                onboarded = false -- Triggers the Welcome Questions
             WHERE id = $5`,
            [sharedCoupleId, nickname, avatar_id, partnerGender, inviteeId]
        );

        // 4. Update the Creator's onboarded status to false 
        await dbClient.query(`UPDATE users SET onboarded = false WHERE couple_id = $1`, [sharedCoupleId]);

        // 5. Finalize the Couple Record
        await dbClient.query(
            `UPDATE couples SET partner_id = $1, status = 'full', rel_status = $2 WHERE id = $3`,
            [inviteeId, rel_status, sharedCoupleId]
        );

        // 6. DELETE the Invitee's old solo ID (Method 3 & 4 cleanup)
        if (oldSoloId && oldSoloId !== sharedCoupleId) {
            await dbClient.query('DELETE FROM couples WHERE id = $1', [oldSoloId]);
        }

        await dbClient.query('COMMIT');
        res.json({ success: true, message: "Accounts merged. Proceed to Welcome Questions." });

    } catch (err) {
        await dbClient.query('ROLLBACK');
        const { status, error } = handleRelError(err, err.message);
        res.status(status).json({ error });
    } finally {
        dbClient.release();
    }
};

exports.unlinkCouple = async (req, res) => {
    const userId = req.user.id;
    const dbClient = await pool.connect();

    try {
        await dbClient.query('BEGIN');

        const userRes = await dbClient.query('SELECT couple_id FROM users WHERE id = $1', [userId]);
        const sharedId = userRes.rows[0].couple_id;

        const relinkCode = "RL-" + Math.random().toString(36).substring(2, 8).toUpperCase();

        // 1. Archive the Shared World
        await dbClient.query(
            `UPDATE couples SET status = 'archived', relink_code = $1, deactivated_at = NOW() WHERE id = $2`,
            [relinkCode, sharedId]
        );

        // 2. Give BOTH users new, separate Solo IDs
        const partnerRes = await dbClient.query(`SELECT id FROM users WHERE couple_id = $1`, [sharedId]);
        const userIds = partnerRes.rows.map(r => r.id);

        for (let id of userIds) {
            const newSolo = await dbClient.query(
                `INSERT INTO couples (creator_id, status, rel_status) 
                 VALUES ($1, 'waiting', 'Dating') RETURNING id`, [id]
            );
            
            await dbClient.query(
                `UPDATE users SET 
                    couple_id = $1, 
                    last_shared_id = $2, 
                    onboarded = true 
                 WHERE id = $3`, [newSolo.rows[0].id, sharedId, id]
            );
        }

        await dbClient.query('COMMIT');
        res.json({ relinkCode, message: "Unlinked. New solo worlds created." });
    } catch (err) {
        await dbClient.query('ROLLBACK');
        const { status, error } = handleRelError(err, "Unlink failed.");
        res.status(status).json({ error });
    } finally {
        dbClient.release();
    }
};

exports.togglePause = async (req, res) => {
    const userId = req.user.id;
    try {
        const userRes = await pool.query('SELECT couple_id FROM users WHERE id = $1', [userId]);
        const coupleId = userRes.rows[0]?.couple_id;
        
        // Toggle the paused state
        await pool.query('UPDATE couples SET is_paused = NOT is_paused WHERE id = $1', [coupleId]);
        
        res.json({ message: "Relationship state updated." });
    } catch (err) {
        const { status, error } = handleRelError(err, "Could not update state.");
        res.status(status).json({ error });
    }
};

exports.submitWelcomeAnswers = async (req, res) => {
    const userId = req.user.id; 
    const { answers } = req.body; 
    const dbClient = await pool.connect();
    
    try {
        await dbClient.query('BEGIN');
        const userRes = await dbClient.query('SELECT couple_id FROM users WHERE id = $1', [userId]);
        const coupleId = userRes.rows[0]?.couple_id;

        const coupleCheck = await dbClient.query('SELECT creator_id FROM couples WHERE id = $1', [coupleId]);
        const isP1 = coupleCheck.rows[0].creator_id === userId;
        const column = isP1 ? 'p1_answered' : 'p2_answered';

        // Update answers and flag
        await dbClient.query(
            `UPDATE couples SET answers = answers || $1::jsonb, ${column} = TRUE WHERE id = $2`,
            [JSON.stringify({ [userId]: answers }), coupleId]
        );

        // FLIP BACK: This user is now allowed back on the homepage
        await dbClient.query('UPDATE users SET onboarded = true WHERE id = $1', [userId]);
        
        await dbClient.query('COMMIT');
        res.json({ message: "Welcome to your shared home!", success: true });
    } catch (err) {
        await dbClient.query('ROLLBACK');
        const { status, error } = handleRelError(err, "Submission failed");
        res.status(status).json({ error });
    } finally {
        dbClient.release();
    }
};

exports.getWelcomeComparison = async (req, res) => {
    try {
        const userId = req.user.id;
        const result = await pool.query(`
            SELECT c.*, u1.nickname as p1_nick, u2.nickname as p2_nick
            FROM couples c
            JOIN users u1 ON c.creator_id = u1.id
            JOIN users u2 ON c.partner_id = u2.id
            WHERE c.creator_id = $1 OR c.partner_id = $1
        `, [userId]);

        const rel = result.rows[0];
        if (!rel || !rel.p1_answered || !rel.p2_answered) return res.status(200).json({ ready: false });

        const isP1 = rel.creator_id === userId;
        const p1Ans = rel.answers[rel.creator_id] || {};
        const p2Ans = rel.answers[rel.partner_id] || {};

        const comparison = Object.keys(p1Ans).map(k => ({
            questionKey: k,
            myAnswer: isP1 ? p1Ans[k] : p2Ans[k],
            partnerAnswer: isP1 ? p2Ans[k] : p1Ans[k],
            isMatch: p1Ans[k] === p2Ans[k]
        }));

        res.json({ ready: true, questions: comparison });
    } catch (err) {
        const { status, error } = handleRelError(err, "Comparison failed");
        res.status(status).json({ error });
    }
};

exports.markRevealAsSeen = async (req, res) => {
    try {
        const userId = req.user.id;
        const check = await pool.query('SELECT id, creator_id FROM couples WHERE creator_id = $1 OR partner_id = $1', [userId]);
        const column = check.rows[0].creator_id === userId ? 'p1_seen_reveal' : 'p2_seen_reveal';
        await pool.query(`UPDATE couples SET ${column} = TRUE WHERE id = $1`, [check.rows[0].id]);
        res.json({ success: true });
    } catch (err) {
        const { status, error } = handleRelError(err, "Update failed");
        res.status(status).json({ error });
    }
};

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
        const { status, error } = handleRelError(err, "Failed to sync image. Please try again.");
        res.status(status).json({ error });
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
        const { status, error } = handleRelError(err, "Delete failed");
        res.status(status).json({ error });
    }
};

exports.relinkCouple = async (req, res) => {
    const userId = req.user.id;
    const { relinkCode } = req.body;
    const dbClient = await pool.connect();

    try {
        await dbClient.query('BEGIN');

        // 1. Find the archived world by the relink code from the card/QR
        const relRes = await dbClient.query(
            `SELECT id, creator_id, partner_id, status 
             FROM couples 
             WHERE relink_code = $1 AND status = 'archived'`, 
            [relinkCode]
        );

        if (relRes.rows.length === 0) {
            throw new Error("Invalid or expired relink code.");
        }
        
        const rel = relRes.rows[0];
        const partnerId = (rel.creator_id === userId) ? rel.partner_id : rel.creator_id;

        // 2. Safety Check: Is the partner already with someone else?
        const partnerCheck = await dbClient.query(
            `SELECT c.status FROM users u 
             JOIN couples c ON u.couple_id = c.id 
             WHERE u.id = $1`, [partnerId]
        );

        if (partnerCheck.rows[0]?.status === 'full') {
            throw new Error("Your old partner is already linked with someone else.");
        }

        // 3. Identify the temporary Solo IDs to delete
        const soloIdsRes = await dbClient.query(
            `SELECT couple_id FROM users WHERE id IN ($1, $2)`, 
            [userId, partnerId]
        );
        const soloIdsToDelete = soloIdsRes.rows.map(r => r.couple_id);

        // 4. Move both users back to the original shared ID
        await dbClient.query(
            `UPDATE users SET 
                couple_id = $1, 
                is_unlinked_partner = false, 
                onboarded = false 
             WHERE id IN ($2, $3)`,
            [rel.id, userId, partnerId]
        );

        // 5. Restore the Archived Couple record to 'full'
        await dbClient.query(
            `UPDATE couples SET 
                status = 'full', 
                is_active = true, 
                relink_code = NULL, 
                deactivated_at = NULL 
             WHERE id = $1`, 
            [rel.id]
        );

        // 6. Cleanup: Delete the temporary solo IDs they were using
        if (soloIdsToDelete.length > 0) {
            await dbClient.query(
                `DELETE FROM couples WHERE id = ANY($1) AND status = 'waiting'`, 
                [soloIdsToDelete]
            );
        }

        await dbClient.query('COMMIT');

        res.json({ 
            success: true, 
            message: "Relationship restored! Redirecting to welcome questions." 
        });

    } catch (err) {
        await dbClient.query('ROLLBACK');
        const { status, error } = handleRelError(err, err.message);
        res.status(status).json({ error });
    } finally {
        dbClient.release();
    }
};