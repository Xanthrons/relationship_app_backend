const { pool } = require('../config/db');
const { createNotification } = require('../services/notificationService');

/**
 * Saves or updates the daily journal (highlight) and gratitude.
 * Triggered when a user submits their daily entry.
 */
exports.upsertHighlightGratitude = async (req, res) => {
    const { highlight, gratitude } = req.body;
    const userId = req.user.id;
    const coupleId = req.user.couple_id;
    
    // Create a date string and a unique day_key (YYYY-MM-DD-userId)
    const today = new Date().toISOString().split('T')[0];
    const dayKey = `${today}-${userId}`;

    try {
        // 1. Identify the partner using your creator_id / partner_id schema
        const coupleResult = await pool.query(
            "SELECT creator_id, partner_id FROM couples WHERE id = $1", 
            [coupleId]
        );
        
        if (coupleResult.rows.length === 0) {
            return res.status(404).json({ error: "Couple not found" });
        }

        const couple = coupleResult.rows[0];
        const partnerId = (couple.creator_id === userId) ? couple.partner_id : couple.creator_id;

        // 2. Upsert Highlight (Journal) and Gratitude
        // Using EXCLUDED ensures that if they edit their entry, it updates the existing row
        const result = await pool.query(
            `INSERT INTO daily_highlights_gratitude (user_id, couple_id, highlight, gratitude, day_key)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (day_key) 
             DO UPDATE SET 
                highlight = EXCLUDED.highlight, 
                gratitude = EXCLUDED.gratitude,
                created_at = NOW()
             RETURNING *`,
            [userId, coupleId, highlight, gratitude, dayKey]
        );

        // 3. Notify partner of the update
        if (partnerId) {
            await createNotification({
                recipientId: partnerId,
                senderId: userId,
                type: 'highlight_update',
                message: `Your partner updated their daily journal and gratitude! ✨`,
                link: '/' // Directs them to the dashboard to read it
            });
        }

        res.json(result.rows[0]);
    } catch (err) {
        console.error("Error in upsertHighlightGratitude:", err);
        res.status(500).json({ error: "Server error saving daily entry" });
    }
};

/**
 * Fetches today's entries for both partners.
 * Used to populate the "Journal" and "Gratitude" cards on the dashboard.
 */
exports.getDailyHighlights = async (req, res) => {
    const userId = req.user.id;
    const coupleId = req.user.couple_id;
    const today = new Date().toISOString().split('T')[0];

    try {
        // Fetch entries for the couple for the current day
        // We JOIN with users to get nickname and avatar_id for the UI
        const result = await pool.query(
            `SELECT h.*, u.nickname, u.avatar_id 
             FROM daily_highlights_gratitude h
             JOIN users u ON h.user_id = u.id
             WHERE h.couple_id = $1 AND h.day_key LIKE $2`,
            [coupleId, `${today}%`]
        );

        // Organize the data so the frontend knows which one belongs to the current user
        const responseData = {
            userEntry: result.rows.find(r => r.user_id === userId) || null,
            partnerEntry: result.rows.find(r => r.user_id !== userId) || null
        };

        res.json(responseData);
    } catch (err) {
        console.error("Error in getDailyHighlights:", err);
        res.status(500).json({ error: "Server error fetching daily entries" });
    }
};