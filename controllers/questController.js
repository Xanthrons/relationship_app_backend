const { pool } = require('../config/db');
const { createNotification } = require('../services/notificationService');
const cloudinary = require('../config/cloudinary');
const sharp = require('sharp');

// --- HELPER: Probability Logic (Rare Coupons, Frequent Savology) ---
const rollForTaskType = () => {
    const roll = Math.random() * 100;
    if (roll < 15) return 'Coupon';    // ~4 times a month
    if (roll < 60) return 'Savology';  // Most frequent
    return 'Quest';                    // Activity
};

const compressImage = async (buffer) => {
    return await sharp(buffer)
        .resize(1000, 1000, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 70 }) // Drops size significantly while keeping quality good
        .toBuffer();
};

// 1. SET CUSTOM QUEST (Partner's Choice)
exports.setCustomQuest = async (req, res) => {
    const { targetUserId, questText } = req.body;
    const senderId = req.user.id;
    const today = new Date().toISOString().split('T')[0];

    try {
        const result = await pool.query(
            `UPDATE daily_tasks 
             SET custom_prompt = $1 
             WHERE user_id = $2 AND scheduled_date = $3 AND task_type = 'Quest'
             RETURNING *`,
            [questText, targetUserId, today]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ error: "No 'Partner Choice' quest found for partner today." });
        }

        await createNotification({
            recipientId: targetUserId,
            senderId: senderId,
            type: 'quest_ready',
            message: `Your partner has set your quest! Open it to see what it is. 🎁`,
            link: '/quests'
        });

        res.json({ success: true, message: "Quest sent to partner!" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// 2. MAIN DAILY FETCHER (Unified Generation + Retrieval)
exports.getTodayQuest = async (req, res) => {
    const userId = req.user.id;
    const coupleId = req.user.couple_id;
    const today = new Date().toISOString().split('T')[0];

    try {
        // 1. Fetch the task first
        let taskRes = await pool.query(
            `SELECT t.*, q.title, q.prompt as original_prompt, q.image_required, q.is_custom
             FROM daily_tasks t
             LEFT JOIN quest_library q ON t.task_id = q.id
             WHERE t.user_id = $1 AND t.scheduled_date = $2`,
            [userId, today]
        );

        // 2. GENERATION LOGIC: If no task row exists for today
        if (taskRes.rows.length === 0) {
            const taskType = rollForTaskType(); // Ensure this helper function is defined
            let taskId = null;
            let taskTitle = (taskType === 'Savology') ? "Savology Board" : "Daily Task";
            let taskPrompt = (taskType === 'Savology') ? "Roll the dice to move!" : "";

            if (taskType !== 'Savology') {
                const randomQuest = await pool.query(`
    SELECT * FROM quest_library 
    WHERE type = $1 
    AND id NOT IN (
        SELECT task_id FROM daily_tasks 
        WHERE user_id = $2 AND task_id IS NOT NULL 
        ORDER BY scheduled_date DESC LIMIT 50
    )
    ORDER BY RANDOM() LIMIT 1
`, [taskType.toLowerCase(), userId]);

                if (randomQuest.rows.length > 0) {
                    taskId = randomQuest.rows[0].id;
                    taskTitle = randomQuest.rows[0].title;
                    taskPrompt = randomQuest.rows[0].prompt;
                }
            }

          const newEntry = await pool.query(
    `INSERT INTO daily_tasks (user_id, couple_id, scheduled_date, task_type, task_id, status)
     VALUES ($1, $2, $3, $4, $5, 'pending') RETURNING *`,
    [userId, coupleId, today, taskType, taskId] // 1, 2, 3, 4, 5
);

            // Notify Partner
            const partnerRes = await pool.query("SELECT id FROM users WHERE couple_id = $1 AND id != $2", [coupleId, userId]);
            if (partnerRes.rows[0]) {
                await createNotification({
                    recipientId: partnerRes.rows[0].id,
                    senderId: userId,
                    type: 'partner_task_reveal',
                    message: `Your partner got a ${taskType} today! Check what you got.`
                });
            }

            return res.json({ ...newEntry.rows[0], title: taskTitle, prompt: taskPrompt });
        }

        // 3. LOGIC FOR EXISTING TASK
        const task = taskRes.rows[0];

        if (task.task_type === 'Savology') {
            const userPos = await pool.query("SELECT savology_position FROM users WHERE id = $1", [userId]);
            task.current_position = userPos.rows[0].savology_position || 0;
            task.title = "Savology Board";
            task.displayPrompt = "Roll the dice to move! 🎲";
        } else {
            // This is where we handle the Custom Prompt override
            task.displayPrompt = task.is_custom 
                ? (task.custom_prompt || "Waiting for partner to set your quest... ⏳") 
                : task.original_prompt;
        }

        task.ui_state = {
            canSubmit: ['pending', 'failed'].includes(task.status),
            underReview: task.status === 'submitted',
            isDisapproved: task.status === 'failed',
            isAppealed: task.status === 'appealed',
            isCompleted: task.status === 'approved' || task.punishment_completed
        };

        res.json(task);

    } catch (err) {
        console.error("GET_TODAY_QUEST_ERROR:", err.message);
        res.status(500).json({ error: err.message });
    }
};

// 3. SAVOLOGY ROLL LOGIC
exports.rollSavology = async (req, res) => {
    const userId = req.user.id;
    const diceRoll = Math.floor(Math.random() * 6) + 1;
    const BOARD_SIZE = 8; 

    try {
        const userRes = await pool.query("SELECT savology_position FROM users WHERE id = $1", [userId]);
        let newPos = ((userRes.rows[0].savology_position || 0) + diceRoll) % BOARD_SIZE;

        await pool.query("UPDATE users SET savology_position = $1 WHERE id = $2", [newPos, userId]);
        // Savology is auto-approved because the "Board" is the result
        await pool.query(
            "UPDATE daily_tasks SET status = 'approved' WHERE user_id = $1 AND scheduled_date = CURRENT_DATE AND task_type = 'Savology'",
            [userId]
        );

        res.json({ roll: diceRoll, newPosition: newPos });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// 4. PARTNER VERDICT (Socket + Notifications Preserved)
exports.submitVerdict = async (req, res) => {
    const { taskId, status } = req.body; 
    const judgeId = req.user.id;
    const coupleId = req.user.couple_id;

    try {
        const result = await pool.query(
            `UPDATE daily_tasks SET status = $1 WHERE id = $2 RETURNING user_id, task_type`,
            [status, taskId]
        );
        
        if (result.rowCount === 0) return res.status(404).json({ error: "Task not found" });

        const targetUserId = result.rows[0].user_id;

        await createNotification({
            recipientId: targetUserId,
            senderId: judgeId,
            type: status === 'failed' ? 'punishment_triggered' : 'quest_approved',
            message: status === 'failed' 
                ? `Quest rejected! You have until midnight to re-submit or appeal. 🎡`
                : `Your quest was approved! Great job. 🎉`
        });

        const io = req.app.get('socketio');
        io.to(`couple_${coupleId}`).emit('quest_update', {
            status,
            message: status === 'failed' ? "Quest Rejected ❌" : "Quest Approved ✅",
            taskId
        });

        res.json({ success: true, status });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// 5. USER APPEAL (Preserved)
exports.submitAppeal = async (req, res) => {
    const { taskId, appealText } = req.body;
    const userId = req.user.id;
    const coupleId = req.user.couple_id;

    try {
        // 1. Update the task status and text
        const taskUpdate = await pool.query(
            `UPDATE daily_tasks 
             SET status = 'appealed', appeal_text = $1 
             WHERE id = $2 AND user_id = $3 
             RETURNING *`,
            [appealText, taskId, userId]
        );

        if (taskUpdate.rowCount === 0) {
            return res.status(404).json({ error: "Task not found or you don't own it." });
        }

        // 2. Find the Partner to notify them
        const partnerRes = await pool.query(
            "SELECT id FROM users WHERE couple_id = $1 AND id != $2",
            [coupleId, userId]
        );

        // --- SAFETY CHECK START ---
        if (partnerRes.rows.length === 0) {
            // Even if there is no partner, we still allow the appeal to be saved
            return res.json({ 
                success: true, 
                message: "Appeal saved, but no partner found to notify." 
            });
        }
        // --- SAFETY CHECK END ---

        const partnerId = partnerRes.rows[0].id;

        // 3. Create Notification for the Partner
        await createNotification({
            recipientId: partnerId,
            senderId: userId,
            type: 'quest_appeal',
            message: `Your partner appealed their failed quest! Read their defense. 🛡️`
        });

        res.json({ success: true, message: "Appeal submitted! Waiting for the judge's mercy." });

    } catch (err) {
        console.error("APPEAL_ERROR:", err.message);
        res.status(500).json({ error: err.message });
    }
};

// 6. FINALIZE VERDICT (Cloudinary + Notification Preserved)
exports.finalizeVerdict = async (req, res) => {
    const { taskId, finalStatus, publicIdToDelete } = req.body;
    const judgeId = req.user.id;

    try {
        await pool.query(`UPDATE daily_tasks SET status = $1 WHERE id = $2`, [finalStatus, taskId]);

        if (finalStatus === 'failed') {
            const task = await pool.query("SELECT user_id FROM daily_tasks WHERE id = $1", [taskId]);
            if (publicIdToDelete) await cloudinary.uploader.destroy(publicIdToDelete);

            await createNotification({
                recipientId: task.rows[0].user_id,
                senderId: judgeId,
                type: 'spin_wheel',
                message: "Appeal denied. Time to spin the Wheel of Unfortunate! 🎡",
                link: '/wheel'
            });
        }
        res.json({ success: true, status: finalStatus });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// 7. REDEEM COUPON (New Loop)
exports.redeemCoupon = async (req, res) => {
    const { taskId } = req.body;
    const userId = req.user.id;

    try {
        // Move from daily_tasks to a 'collected_coupons' or just mark as approved/collected
        const result = await pool.query(
            "UPDATE daily_tasks SET status = 'approved' WHERE id = $1 AND user_id = $2 RETURNING task_id",
            [taskId, userId]
        );
        
        res.json({ success: true, message: "Coupon added to your collection! 🎟️" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

exports.completePunishment = async (req, res) => {
    const { taskId } = req.body;
    const userId = req.user.id;

    try {
        if (!req.file) return res.status(400).json({ error: "No proof provided." });

        // 1. COMPRESS BEFORE UPLOAD
        const compressedBuffer = await compressImage(req.file.buffer);

        // 2. UPLOAD BUFFER TO CLOUDINARY
        // Since it's a buffer, we use a different Cloudinary method
        const uploadFromBuffer = () => {
            return new Promise((resolve, reject) => {
                const stream = cloudinary.uploader.upload_stream(
                    { folder: 'punishments' },
                    (error, result) => {
                        if (result) resolve(result);
                        else reject(error);
                    }
                );
                stream.end(compressedBuffer);
            });
        };

        const result = await uploadFromBuffer();

        await pool.query(
            `UPDATE daily_tasks 
             SET punishment_completed = TRUE, punishment_image_url = $1, status = 'completed'
             WHERE id = $2 AND user_id = $3`,
            [result.secure_url, taskId, userId]
        );

        res.json({ success: true, message: "Punishment verified and compressed! 🫡" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};