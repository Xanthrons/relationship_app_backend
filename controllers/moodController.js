const { pool } = require('../config/db');
const { calculateNextStats } = require('../services/evolutionService');

const MOOD_MAP = {
    1: { emoji: "😩", label: "Exhausted" },
    2: { emoji: "😔", label: "Low" },
    3: { emoji: "😕", label: "Meh" },
    4: { emoji: "😐", label: "Neutral" },
    5: { emoji: "🙂", label: "Okay" },
    6: { emoji: "😊", label: "Good" },
    7: { emoji: "😌", label: "Chilled" },
    8: { emoji: "✨", label: "High Vibe" },
    9: { emoji: "🤩", label: "Radiant" },
    10: { emoji: "🔥", label: "Elite" },
};

/**
 * UPSERT MOOD
 */
exports.upsertMood = async (req, res) => {
    const { score } = req.body; // Expecting 1-10
    const userId = req.user.id;
    const coupleId = req.user.couple_id;
    const today = new Date().toISOString().split('T')[0];
    const dayKey = `${today}-${userId}`;

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // 1. Check if mood for today already exists
        const existingMood = await client.query(
            "SELECT id FROM moods WHERE day_key = $1", [dayKey]
        );

        // 2. Fetch current user stats
        const userRes = await client.query(
            "SELECT streak_high, streak_steady, streak_low, level, nickname FROM users WHERE id = $1",
            [userId]
        );
        const user = userRes.rows[0];

        // 3. Fetch recent mood for trend
        const lastMoodRes = await client.query(
            "SELECT score FROM moods WHERE user_id = $1 AND day_key != $2 ORDER BY created_at DESC LIMIT 1",
            [userId, dayKey]
        );

        let evolutionResults = { didLevelUp: false, level: user.level };

        // 4. EVOLUTION LOGIC (Only on first entry of the day)
        if (existingMood.rows.length === 0) {
            const lastScore = lastMoodRes.rows.length > 0 ? lastMoodRes.rows[0].score : null;
            evolutionResults = calculateNextStats(user, score, lastScore);

            await client.query(
                `UPDATE users 
                 SET streak_high = $1, streak_steady = $2, streak_low = $3, level = $4 
                 WHERE id = $5`,
                [evolutionResults.streak_high, evolutionResults.streak_steady, evolutionResults.streak_low, evolutionResults.level, userId]
            );
        }

        // 5. UPSERT the mood entry
        const moodResult = await client.query(
            `INSERT INTO moods (user_id, couple_id, score, first_score, day_key) 
             VALUES ($1, $2, $3, $3, $4) 
             ON CONFLICT (day_key) 
             DO UPDATE SET score = $3, updated_at = NOW()
             RETURNING *`,
            [userId, coupleId, score, dayKey]
        );

        await client.query('COMMIT');

        // 6. REAL-TIME SOCKET ALERTS
       const io = req.app.get('socketio');
        const moodInfo = MOOD_MAP[score] || { emoji: "😶", label: "Unknown" };
        
        if (io) {
            // Alert A: Level Up (Celebration for both)
            if (evolutionResults.didLevelUp) {
                io.to(`couple_${coupleId}`).emit('level_up', {
                    nickname: user.nickname,
                    newLevel: evolutionResults.level,
                    message: `✨ ${user.nickname} reached Level ${evolutionResults.level}! ✨`
                });
            }

            // Alert B: Mood Update (Silent Dashboard Sync)
            // This updates the partner's UI without necessarily triggering a "Buzz" notification
            io.to(`couple_${coupleId}`).emit('mood_update', {
                senderId: userId,
                score,
                label: moodInfo.label,
                emoji: moodInfo.emoji,
                message: `${user.nickname} is feeling ${moodInfo.label} ${moodInfo.emoji}`
            });

            // Alert C: The 3-Day Slump "Buzz"
            // This only triggers when the trend becomes serious
            if (evolutionResults.streak_low >= 3) {
                io.to(`couple_${coupleId}`).emit('slump_alert', {
                    senderId: userId,
                    message: `💌 ${user.nickname} has been feeling low for ${evolutionResults.streak_low} days. Reach out with some extra love today.`
                });
            }
        }

        // 7. DYNAMIC JSON RESPONSE (The "Inserter's" Private Message)
        let feedbackMessage = "Mood saved."; 

        if (score <= 3) {
            feedbackMessage = "Take a deep breath. Remember, everything is going to be okay. ❤️";
        } else if (score >= 8) {
            feedbackMessage = "You're glowing! Keep that beautiful energy. ✨";
        }

        res.status(200).json({ 
            mood: moodResult.rows[0], 
            evolution: evolutionResults,
            message: feedbackMessage 
        });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Mood Controller Error:", err);
        res.status(500).json({ error: "Failed to process mood entry" });
    } finally {
        client.release();
    }
};
exports.getTodayMood = async (req, res) => {
    const userId = req.user.id;
    const today = new Date().toISOString().split('T')[0];
    const dayKey = `${today}-${userId}`;

    try {
        const result = await pool.query("SELECT * FROM moods WHERE day_key = $1", [dayKey]);
        res.json(result.rows[0] || null);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

/**
 * GET PARTNER SUMMARY (7-Day History)
 */
exports.getPartnerSummary = async (req, res) => {
    const userId = req.user.id;
    const coupleId = req.user.couple_id;

    try {
        // Find the partner's ID
        const partnerRes = await pool.query(
            "SELECT id, nickname, level FROM users WHERE couple_id = $1 AND id != $2",
            [coupleId, userId]
        );

        if (partnerRes.rows.length === 0) return res.status(404).json({ error: "Partner not found" });
        const partner = partnerRes.rows[0];

        // Get last 7 days of moods
        const historyRes = await pool.query(
            `SELECT score, created_at, day_key 
             FROM moods 
             WHERE user_id = $1 
             ORDER BY created_at DESC LIMIT 7`,
            [partner.id]
        );

        res.json({
            partnerNickname: partner.nickname,
            partnerLevel: partner.level,
            history: historyRes.rows.map(row => ({
                ...row,
                label: MOOD_MAP[row.score]?.label,
                emoji: MOOD_MAP[row.score]?.emoji
            }))
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};