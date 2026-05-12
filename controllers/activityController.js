const { pool } = require('../config/db');
const { createNotification } = require('../services/notificationService');
const { checkSoloStatus } = require('../utils/userHelpers');
const { SAVOLOGY_BOARD } = require('../constants/savologyBoard');

// --- HELPER: Logic Engine ---
const rollForTaskType = () => {
    const roll = Math.random() * 100;
    if (roll < 15) return 'Coupon';      // Rare: Coupon
    if (roll < 60) return 'Savology';    // Standard: Savology
    return 'Quest';                      // Default: Daily Quest
};

/**
 * 1. GET TODAY ACTIVITY (The Orchestrator)
 */
exports.getTodayActivity = async (req, res) => {
    const userId = req.user.id;
    const coupleId = req.user.couple_id;
    const today = new Date().toISOString().split('T')[0];

    try {
        const isSolo = await checkSoloStatus(userId);
        
        // Fetch User State
        const userState = await pool.query(
            "SELECT status, jail_days_count, savology_position, points, gender FROM users WHERE id = $1", [userId]
        );
        const user = userState.rows[0];

        // --- PUNISHMENT BLOCKER ---
        const pendingPunishment = await pool.query(
            `SELECT *, 
             EXTRACT(EPOCH FROM (NOW() - punishment_submitted_at)) / 3600 as hours_passed
             FROM daily_tasks 
             WHERE user_id = $1 AND punishment_completed = false 
             AND status IN ('failed', 'punishment_assigned', 'submitted')
             LIMIT 1`, [userId]
        );

        if (pendingPunishment.rows.length > 0) {
            const p = pendingPunishment.rows[0];

            if (p.status === 'submitted' && p.hours_passed >= 12) {
                await pool.query(
                    "UPDATE daily_tasks SET punishment_completed = true, status = 'approved' WHERE id = $1",
                    [p.id]
                );
            } else {
                return res.json({
                    ui_mode: p.status === 'submitted' ? 'PUNISHMENT_PENDING_APPROVAL' : 'PUNISHMENT_LOCKED',
                    message: p.status === 'submitted' 
                        ? "Punishment done! Ask your partner to approve it so you can move on." 
                        : "You must complete your punishment first!",
                    task: p,
                    user_status: user
                });
            }
        }

        // JAIL LOGIC: 3-day limit check
        if (user.status === 'jail' && user.jail_days_count >= 3) {
            return res.json({ 
                ui_mode: 'FORCE_WHEEL', 
                message: "3 Days in Jail! Your time is up. You must spin the Wheel to escape.",
                user_status: user,
                is_solo: isSolo
            });
        }

        // Task Fetching
        let taskRes = await pool.query(
            `SELECT t.*, q.title, q.prompt as original_prompt, q.is_custom 
             FROM daily_tasks t LEFT JOIN quest_library q ON t.task_id = q.id 
             WHERE t.user_id = $1 AND t.scheduled_date = $2`, [userId, today]
        );

        // GENERATION LOGIC (If no task exists for today)
        if (taskRes.rows.length === 0) {
            const taskType = (user.status === 'jail') ? 'Savology' : rollForTaskType();
            let libraryId = null;
            let needsCustomInput = false;

            if (taskType === 'Quest' || taskType === 'Coupon') {
                const libRes = await pool.query(
                    "SELECT id, is_custom FROM quest_library WHERE LOWER(type) = LOWER($1) ORDER BY RANDOM() LIMIT 1",
                    [taskType]
                );
                if (libRes.rows.length > 0) {
                    libraryId = libRes.rows[0].id;
                    needsCustomInput = libRes.rows[0].is_custom;
                }
            }

            const newEntry = await pool.query(
                `INSERT INTO daily_tasks (user_id, couple_id, scheduled_date, task_type, status, task_id, is_custom) 
                 VALUES ($1, $2, $3, $4, 'pending', $5, $6) RETURNING id`,
                [userId, coupleId, today, taskType, libraryId, needsCustomInput]
            );

            // Notify Partner of the Category (Transparency Rule)
            if (!isSolo) {
                const partnerId = await getPartnerId(userId);
                let notifyMsg = "";
                if (taskType === 'Savology') notifyMsg = "Your partner is heading to the Savology board today! 🎲";
                else if (taskType === 'Quest') notifyMsg = "A new Quest has been assigned to your partner! ⚔️";
                else if (taskType === 'Coupon') notifyMsg = "Lucky! Your partner just scored a Mystery Coupon. 🎟️";

                if (notifyMsg) await createNotification(partnerId, userId, 'partner_task_assigned', notifyMsg);
                
                // Extra notification if input is needed
                if (needsCustomInput) {
                    await createNotification(partnerId, userId, 'custom_input_needed', `Your partner needs you to set their custom ${taskType}! ✍️`);
                }
            }

            taskRes = await pool.query(
                `SELECT t.*, q.title, q.prompt as original_prompt, q.is_custom 
                 FROM daily_tasks t LEFT JOIN quest_library q ON t.task_id = q.id 
                 WHERE t.id = $1`, [newEntry.rows[0].id]
            );
        }

        const task = taskRes.rows[0];

        // SOLO PROMPT OVERRIDE
        let displayPrompt = task.is_custom ? task.custom_prompt : task.original_prompt;
        if (isSolo && task.is_custom && !task.custom_prompt) {
            displayPrompt = "Solo Challenge: Set a goal for yourself today and complete it!";
        } else if (!displayPrompt && task.task_type === 'Savology') {
            displayPrompt = "Roll the dice for freedom!";
        }

        res.json({
            ui_mode: user.status === 'jail' ? 'JAIL_SURVIVAL' : task.task_type,
            task: task,
            user_status: user,
            is_solo: isSolo,
            displayPrompt: displayPrompt || "Waiting for task details..."
        });

    } catch (err) { 
        console.error("GET_TODAY_ERROR:", err.message);
        res.status(500).json({ error: "Database error." }); 
    }
};

/**
 * 2. SAVOLOGY ROLL
 */
exports.rollSavology = async (req, res) => {
    const userId = req.user.id;
    const { useBail } = req.body;
    const today = new Date().toISOString().split('T')[0];
    const isSolo = await checkSoloStatus(userId);

    try {
        const userRes = await pool.query(
            "SELECT status, jail_days_count, points, savology_position, couple_id, gender FROM users WHERE id = $1", 
            [userId]
        );
        const user = userRes.rows[0];

        // LOCK CHECK: Prevent double rolling
        const existingTask = await pool.query(
            "SELECT id, status FROM daily_tasks WHERE user_id = $1 AND scheduled_date = $2 AND task_type = 'Savology'",
            [userId, today]
        );

        if (existingTask.rows.length > 0 && existingTask.rows[0].status === 'completed') {
            return res.status(403).json({ success: false, message: "Already rolled today! Come back tomorrow." });
        }

        let diceRoll = Math.floor(Math.random() * 6) + 1;
        await pool.query('BEGIN');

        // --- CASE A: JAIL LOGIC ---
        if (user.status === 'jail') {
            if (isSolo && useBail) {
                if (user.points >= 100) {
                    await pool.query("UPDATE users SET status = 'free', jail_days_count = 0, points = points - 100 WHERE id = $1", [userId]);
                    await upsertSavologyTask(userId, user.couple_id, today);
                    await pool.query('COMMIT');
                    return res.json({ success: true, message: "Bailed out! You are free.", status: 'free' });
                }
                await pool.query('ROLLBACK');
                return res.json({ success: false, message: "Not enough points!" });
            }

            if (diceRoll === 6) {
                await pool.query("UPDATE users SET status = 'free', jail_days_count = 0 WHERE id = $1", [userId]);
                await upsertSavologyTask(userId, user.couple_id, today);
                if (!isSolo) await createNotification(await getPartnerId(userId), userId, 'jail_escape', `Your partner rolled a 6 and escaped jail! 🏃💨`);
                await pool.query('COMMIT');
                return res.json({ success: true, roll: diceRoll, message: "A SIX! Free!", status: 'free' });
            } else {
                await pool.query("UPDATE users SET jail_days_count = jail_days_count + 1 WHERE id = $1", [userId]);
                await upsertSavologyTask(userId, user.couple_id, today);
                await pool.query('COMMIT');
                return res.json({ success: false, roll: diceRoll, message: "Failed to escape!", jail_days_count: user.jail_days_count + 1 });
            }
        }

        // --- CASE B: MOVEMENT ---
        let newPosition = (user.savology_position + diceRoll) % SAVOLOGY_BOARD.length;
        let landedTile = { ...SAVOLOGY_BOARD[newPosition] };

        // Chance Logic
        if (landedTile.type === 'chance') {
            const secondRoll = Math.floor(Math.random() * 6) + 1;
            diceRoll += secondRoll;
            newPosition = (user.savology_position + diceRoll) % SAVOLOGY_BOARD.length;
            landedTile = { ...SAVOLOGY_BOARD[newPosition] };
        }

        // Board Transformer (Gender Swap)
        const isMale = user.gender === 'male';
        const partnerName = isMale ? "Girlfriend" : "Boyfriend";
        const partnerTitle = isMale ? "Queen" : "King";
        landedTile.name = landedTile.name.replace("{{partner}}", partnerName);
        landedTile.desc = landedTile.desc.replace("{{partner_title}}", partnerTitle);

        let newStatus = landedTile.type === 'jail' ? 'jail' : 'free';

        await pool.query(
            "UPDATE users SET savology_position = $1, points = points + $2, status = $3 WHERE id = $4", 
            [newPosition, landedTile.reward || 0, newStatus, userId]
        );

        // Notify Partner of the Move
        if (!isSolo) {
            const partnerId = await getPartnerId(userId);
            await createNotification(partnerId, userId, 'savology_move', `Your partner landed on "${landedTile.name}"! 🎲`);
            if (newStatus === 'jail') await createNotification(partnerId, userId, 'jail_landed', `Ouch! Your partner was sent to the Dungeon! ⛓️`);
        }

        await upsertSavologyTask(userId, user.couple_id, today);
        await pool.query('COMMIT');

        res.json({ success: true, roll: diceRoll, newPosition, reward: landedTile.reward, tile: landedTile });

    } catch (err) { 
        if (pool) await pool.query('ROLLBACK');
        res.status(500).json({ error: err.message }); 
    }
};

/**
 * 3. QUEST VERDICTS & APPEALS
 */
exports.claimQuestSuccess = async (req, res) => {
    const { taskId } = req.body;
    const userId = req.user.id;
    const isSolo = await checkSoloStatus(userId);
    const proofUrl = req.file ? req.file.path : null; // Multer provides this

    try {
        const result = await pool.query(
            `UPDATE daily_tasks 
             SET status = 'submitted', proof_url = $1, punishment_submitted_at = NOW() 
             WHERE id = $2 AND user_id = $3 RETURNING couple_id`,
            [proofUrl, taskId, userId]
        );

        if (result.rows.length === 0) return res.status(404).json({ error: "Task not found." });

        if (!isSolo) {
            const partnerId = await getPartnerId(userId);
            await createNotification(partnerId, userId, 'quest_submitted', "Quest completed! Verify the proof. 📸");
            req.app.get('socketio').to(`couple_${result.rows[0].couple_id}`).emit('quest_update', { status: 'submitted', taskId });
        } else {
            // In Solo mode, we auto-approve since there is no partner
            await pool.query("UPDATE daily_tasks SET status = 'approved' WHERE id = $1", [taskId]);
            await pool.query("UPDATE users SET points = points + 20 WHERE id = $1", [userId]);
        }

        res.json({ success: true, message: "Submission successful." });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};
exports.submitVerdict = async (req, res) => {
    const { taskId, status } = req.body; 
    const userId = req.user.id;
    const isSolo = await checkSoloStatus(userId);

    try {
        const result = await pool.query("UPDATE daily_tasks SET status = $1 WHERE id = $2 RETURNING user_id", [status, taskId]);
        const recipientId = result.rows[0].user_id;

        if (status === 'approved') {
            await pool.query("UPDATE users SET points = points + 20 WHERE id = $1", [recipientId]);
        }
        
        if (!isSolo && req.user.couple_id) {
            req.app.get('socketio').to(`couple_${req.user.couple_id}`).emit('quest_update', { status, taskId });
            const emoji = status === 'approved' ? '✅' : '❌';
            await createNotification(recipientId, userId, 'verdict_received', `Your partner ${status} your task! ${emoji}`);
        }
        
        res.json({ success: true, status });
    } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.submitAppeal = async (req, res) => {
    const { taskId, appealText } = req.body;
    const userId = req.user.id;
    const isSolo = await checkSoloStatus(userId);

    if (isSolo) return res.status(400).json({ error: "Appeals are not available in Solo mode." });

    try {
        await pool.query("UPDATE daily_tasks SET status = 'appealed', appeal_text = $1 WHERE id = $2 AND user_id = $3", [appealText, taskId, userId]);
        const partnerId = await getPartnerId(userId);
        await createNotification(partnerId, userId, 'appeal_received', `Your partner appealed your verdict! ⚖️`);
        res.json({ success: true, message: "Appeal sent." });
    } catch (err) { res.status(500).json({ error: err.message }); }
};

exports.finalizeVerdict = async (req, res) => {
    const { taskId, status } = req.body;
    const userId = req.user.id;
    try {
        const result = await pool.query("UPDATE daily_tasks SET status = $1 WHERE id = $2 RETURNING user_id", [status, taskId]);
        await createNotification(result.rows[0].user_id, userId, 'final_verdict', `Final verdict on your appeal: ${status}!`);
        res.json({ success: true, message: `Final verdict: ${status}` });
    } catch (err) { res.status(500).json({ error: err.message }); }
};

/**
 * 4. CUSTOM & COUPON LOGIC
 */
exports.setCustomQuest = async (req, res) => {
    const { taskId, customPrompt } = req.body;
    const userId = req.user.id;
    const isSolo = await checkSoloStatus(userId);

    try {
        await pool.query("UPDATE daily_tasks SET custom_prompt = $1 WHERE id = $2", [customPrompt, taskId]);

        if (!isSolo && req.user.couple_id) {
            const taskOwner = await pool.query("SELECT user_id FROM daily_tasks WHERE id = $1", [taskId]);
            req.app.get('socketio').to(`couple_${req.user.couple_id}`).emit('custom_quest_ready', { taskId });
            await createNotification(taskOwner.rows[0].user_id, userId, 'task_ready', `Your partner set your challenge: "${customPrompt}" 😈`);
        }

        res.json({ success: true, message: "Custom prompt saved." });
    } catch (err) { res.status(500).json({ error: "Database error." }); }
};

exports.redeemCoupon = async (req, res) => {
    const { taskId } = req.body;
    const userId = req.user.id;
    try {
        await pool.query("UPDATE daily_tasks SET status = 'approved' WHERE id = $1 AND user_id = $2", [taskId, userId]);
        await pool.query("UPDATE users SET points = points + 50 WHERE id = $1", [userId]);
        
        const isSolo = await checkSoloStatus(userId);
        if (!isSolo) {
            await createNotification(await getPartnerId(userId), userId, 'coupon_redeemed', `Your partner redeemed a Coupon! 🎟️`);
        }
        res.json({ success: true, message: "Coupon redeemed!" });
    } catch (err) { res.status(500).json({ error: err.message }); }
};

// --- HELPERS ---

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

async function upsertSavologyTask(userId, coupleId, date) {
    return await pool.query(
        `INSERT INTO daily_tasks (user_id, couple_id, scheduled_date, task_type, status)
         VALUES ($1, $2, $3, 'Savology', 'completed')
         ON CONFLICT (user_id, scheduled_date) 
         DO UPDATE SET status = 'completed'`,
        [userId, coupleId, date]
    );
}

exports.getBoard = async (req, res) => {
    try {
        res.json({ success: true, board: SAVOLOGY_BOARD });
    } catch (err) {
        res.status(500).json({ error: "Could not fetch board." });
    }
};