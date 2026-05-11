const { pool } = require('../config/db');
const { createNotification } = require('../services/notificationService');
const { checkSoloStatus } = require('../utils/userHelpers');

/**
 * 1. Get all possible wheel items
 * Optimized: Fetches the library once, suitable for client-side caching.
 */
exports.getWheelItems = async (req, res) => {
    try {
        // 1. Get 6 Random Punishments (Includes 'punishment' and 'custom' types)
        const punishments = await pool.query(
            "SELECT * FROM wheel_library WHERE type IN ('punishment', 'custom') ORDER BY RANDOM() LIMIT 6"
        );
        
        // 2. Get 2 Random Mercies
        const mercies = await pool.query(
            "SELECT * FROM wheel_library WHERE type = 'mercy' ORDER BY RANDOM() LIMIT 2"
        );

        // Combine and shuffle
        const dailyWheel = [...punishments.rows, ...mercies.rows].sort(() => Math.random() - 0.5);

        res.json(dailyWheel);
    } catch (err) {
        res.status(500).json({ error: "Failed to generate wheel." });
    }
};

/**
 * 2. Record the result of a spin
 * Optimized: Backend picks the winner to ensure no client-side cheating.
 */
exports.saveSpinResult = async (req, res) => {
    const { taskId } = req.body;
    const userId = req.user.id;
    const coupleId = req.user.couple_id;

    try {
        const isSolo = await checkSoloStatus(userId);
        const partnerId = !isSolo ? await getPartnerId(userId) : null;

        // 1. Roll the result
        const libraryRes = await pool.query("SELECT * FROM wheel_library");
        const selected = libraryRes.rows[Math.floor(Math.random() * libraryRes.rows.length)];

        let statusUpdate = 'punishment_assigned';
        let customMessage = `The Wheel landed on: ${selected.title}`;
        let partnerNotifyMsg = null;

        // --- THE STRATEGIC ENGINE ---
        switch (selected.title) {
            case 'Get Out of Jail Free':
                await pool.query(
                    "INSERT INTO collected_items (user_id, item_type, item_name, item_data) VALUES ($1, $2, $3, $4)",
                    [userId, 'mercy', 'Jail-Free Card', JSON.stringify({ description: "Use this to skip any punishment." })]
                );
                statusUpdate = 'approved'; 
                customMessage = "🎫 Item added to Vault! You are free for now.";
                partnerNotifyMsg = "Lucky! Your partner found a 'Get Out of Jail Free' card. 🎫";
                break;

            case 'Reverse Uno!':
                if (isSolo) {
                    const bonus = 100;
                    await pool.query("UPDATE users SET points = points + $1 WHERE id = $2", [bonus, userId]);
                    statusUpdate = 'approved';
                    customMessage = `🔄 Solo Reverse! No partner found, so you got +${bonus} points instead!`;
                } else {
                    // Current user is free
                    await pool.query("UPDATE users SET status = 'free', jail_days_count = 0 WHERE id = $1", [userId]);
                    // Partner goes to jail!
                    await pool.query("UPDATE users SET status = 'jail' WHERE couple_id = $1 AND id != $2", [coupleId, userId]);
                    statusUpdate = 'approved';
                    customMessage = "🔄 REVERSE! You escaped. Your partner is now in jail!";
                    partnerNotifyMsg = "OH NO! Your partner used REVERSE UNO! You are now in jail! ⛓️🔄";
                }
                break;

            case 'The Great Escape':
            case 'The Pardon':
                statusUpdate = 'approved';
                await pool.query("UPDATE users SET status = 'free', jail_days_count = 0 WHERE id = $1", [userId]);
                customMessage = selected.title === 'The Great Escape' 
                    ? "🏃 Congrats! You found the exit. You are free!" 
                    : "🕊️ You have been pardoned. No punishment needed.";
                partnerNotifyMsg = `Your partner escaped! Outcome: ${selected.title} 🕊️`;
                break;

            case 'Bonus Points':
                const bonus = 50;
                await pool.query("UPDATE users SET points = points + $1 WHERE id = $2", [bonus, userId]);
                statusUpdate = 'approved';
                customMessage = `💰 Fortune! +${bonus} points added to your account.`;
                partnerNotifyMsg = "Your partner landed on Bonus Points! They're getting richer. 💰";
                break;

            case 'Partner Choice (Custom)':
                if (isSolo) {
                    const systemPick = (await pool.query("SELECT * FROM wheel_library WHERE type = 'punishment' ORDER BY RANDOM() LIMIT 1")).rows[0];
                    statusUpdate = 'punishment_assigned';
                    customMessage = `⚖️ Solo Mode: The System chose your fate: ${systemPick.title}`;
                    selected.id = systemPick.id;
                    selected.title = systemPick.title;
                } else {
                    statusUpdate = 'punishment_assigned';
                    customMessage = "⚖️ Partner's choice! Waiting for them to decide your fate.";
                    partnerNotifyMsg = "YOUR TURN! Your partner landed on 'Partner Choice'. You get to pick their punishment! 😈";
                }
                break;

            default:
                // Standard Punishments
                if (!isSolo) {
                    partnerNotifyMsg = `The Wheel has spoken! Your partner's punishment: ${selected.title} ☠️`;
                }
                break;
        }

        // Final Update to the Task
        await pool.query(
            `UPDATE daily_tasks SET punishment_id = $1, punishment_rolled = $2, status = $3 
             WHERE id = $4`, [selected.id, selected.title, statusUpdate, taskId]
        );

        // --- NOTIFICATIONS & SOCKETS ---
        if (!isSolo && partnerId) {
            // Real-time Socket Update
            req.app.get('socketio').to(`couple_${coupleId}`).emit('wheel_spin_result', {
                user_id: userId,
                result: selected.title,
                message: customMessage
            });

            // Persistent Notification
            if (partnerNotifyMsg) {
                await createNotification(partnerId, userId, 'wheel_result', partnerNotifyMsg);
            }
        }

        res.json({ success: true, punishment: selected, message: customMessage });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
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