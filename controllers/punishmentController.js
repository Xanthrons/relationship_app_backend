const { pool } = require('../config/db');
const cloudinary = require('../config/cloudinary'); 
const sharp = require('sharp');
const { createNotification } = require('../services/notificationService');

// Helper: Compress images to reduce bandwidth and storage usage
const compressImage = async (buffer) => {
    return await sharp(buffer)
        .resize(1000, 1000, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 70, progressive: true }) 
        .toBuffer();
};

/**
 * SET CUSTOM PUNISHMENT
 * Called by the Partner when the Wheel lands on "Partner Choice"
 */
exports.setCustomPunishment = async (req, res) => {
    const { taskId, customPunishmentText, action } = req.body; // 'punish' or 'release'
    const judgeId = req.user.id;

    try {
        const taskRes = await pool.query("SELECT user_id, couple_id FROM daily_tasks WHERE id = $1", [taskId]);
        if (taskRes.rowCount === 0) return res.status(404).json({ error: "Task not found." });
        
        const targetUserId = taskRes.rows[0].user_id;
        const coupleId = taskRes.rows[0].couple_id;

        if (action === 'release') {
            await pool.query(
                "UPDATE daily_tasks SET status = 'approved', punishment_rolled = 'Pardoned by Partner' WHERE id = $1",
                [taskId]
            );
            await pool.query("UPDATE users SET status = 'free', jail_days_count = 0 WHERE id = $1", [targetUserId]);

            // Notification: You've been freed!
            await createNotification(targetUserId, judgeId, 'punishment_pardoned', "Your partner was merciful! You have been pardoned. 🕊️");
            
            return res.json({ success: true, message: "You were merciful! They are free." });
        }

        await pool.query(
            "UPDATE daily_tasks SET punishment_rolled = $1, status = 'punishment_assigned' WHERE id = $2",
            [customPunishmentText, taskId]
        );

        // Notification: Custom punishment set
        await createNotification(targetUserId, judgeId, 'custom_punishment_set', `Your partner set your punishment: "${customPunishmentText}" ⚖️`);

        res.json({ success: true, message: "Custom punishment set." });
    } catch (err) {
        res.status(500).json({ error: "Failed to set custom punishment." });
    }
};

/**
 * 2. Complete Punishment (Upload Proof)
 */
exports.completePunishment = async (req, res) => {
    const { taskId } = req.body;
    const userId = req.user.id;

    try {
        let imageUrl = null;
        if (req.file) {
            const compressedBuffer = await compressImage(req.file.buffer);
            const uploadResult = await new Promise((resolve, reject) => {
                const stream = cloudinary.uploader.upload_stream(
                    { folder: 'punishments', resource_type: 'image' },
                    (error, result) => { result ? resolve(result) : reject(error); }
                );
                stream.end(compressedBuffer);
            });
            imageUrl = uploadResult.secure_url;
        }

        const result = await pool.query(
            `UPDATE daily_tasks 
             SET punishment_image_url = $1, 
                 status = 'submitted',
                 punishment_submitted_at = NOW() 
             WHERE id = $2 AND user_id = $3
             RETURNING id, couple_id`,
            [imageUrl, taskId, userId]
        );

        if (result.rowCount === 0) return res.status(404).json({ error: "Task not found." });

        // Notification: Partner needs to review proof
        const partnerId = await getPartnerId(userId);
        if (partnerId) {
            await createNotification(partnerId, userId, 'punishment_proof_submitted', "Your partner submitted proof of their punishment! Review it now. 📸");
        }

        res.json({ 
            success: true, 
            message: "Proof submitted! Now, your partner needs to approve it. ⏳" 
        });
    } catch (err) {
        res.status(500).json({ error: "Failed to process punishment." });
    }
};

/**
 * 3. Mark Punishment as Done (Judge Approval)
 */
exports.markPunishmentDone = async (req, res) => {
    const { taskId } = req.body;
    const judgeId = req.user.id;
    try {
        const result = await pool.query(
            "UPDATE daily_tasks SET punishment_completed = true, status = 'approved' WHERE id = $1 RETURNING user_id, couple_id",
            [taskId]
        );

        if (result.rowCount === 0) return res.status(404).json({ error: "Task not found." });

        const targetUserId = result.rows[0].user_id;
        const coupleId = result.rows[0].couple_id;

        // Notification: Debt settled
        await createNotification(targetUserId, judgeId, 'punishment_approved', "Your punishment proof was approved! Your debt is settled. ✅");

        // Real-time Socket Update to clear the "Waiting" UI for the partner
        req.app.get('socketio').to(`couple_${coupleId}`).emit('punishment_cleared', { taskId });

        res.json({ success: true, message: "Debt settled! Punishment approved." });
    } catch (err) {
        console.error("MARK_PUNISHMENT_DONE_ERROR:", err.message);
        res.status(500).json({ error: "Database error during settlement." });
    }
};

/**
 * 4. Partner Jail Decision (Manual Pardon)
 */
exports.partnerJailDecision = async (req, res) => {
    const { targetUserId, action } = req.body; // action: 'force_wheel' or 'pardon'
    const judgeId = req.user.id;

    try {
        if (action === 'pardon') {
            await pool.query("UPDATE users SET status = 'free', jail_days_count = 0 WHERE id = $1", [targetUserId]);
            
            await createNotification(targetUserId, judgeId, 'jail_pardon', "Your partner released you from jail early! You are free. 🕊️");
            
            return res.json({ success: true, message: "You released them! How kind." });
        } 
        
        // Notification for forcing a wheel spin
        await createNotification(targetUserId, judgeId, 'force_wheel', "Your partner is forcing you to spin the Wheel of Punishment! 🎡");
        
        res.json({ success: true, message: "They must now face the Punishment Wheel." });
    } catch (err) { res.status(500).json({ error: err.message }); }
};

// --- HELPER ---
async function getPartnerId(userId) {
    // 1. Get the couple_id for the current user
    const userRes = await pool.query("SELECT couple_id FROM users WHERE id = $1", [userId]);
    const coupleId = userRes.rows[0]?.couple_id;

    if (!coupleId) return null;

    // 2. Find the OTHER user in that same couple
    const partnerRes = await pool.query(
        "SELECT id FROM users WHERE couple_id = $1 AND id != $2 LIMIT 1", 
        [coupleId, userId]
    );
    
    return partnerRes.rows[0]?.id || null;
}