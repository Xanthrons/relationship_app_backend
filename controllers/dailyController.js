const { pool } = require('../config/db');
const { createNotification } = require('../services/notificationService');

/**
 * GET DAILY TASK / QUESTION
 * Fetches the question assigned for today based on Month and Day
 */
exports.getDailyTask = async (req, res) => {
    try {
        const today = new Date();
        const monthNames = [
            "January", "February", "March", "April", "May", "June",
            "July", "August", "September", "October", "November", "December"
        ];
        
        const currentMonth = monthNames[today.getMonth()];
        const currentDay = today.getDate();

        // Match based on your seeded table structure (Month and Day)
        const result = await pool.query(
            "SELECT * FROM daily_questions WHERE month = $1 AND day = $2 LIMIT 1",
            [currentMonth, currentDay]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ message: "No question found for today's date." });
        }

        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

/**
 * SUBMIT ANSWER
 * Saves or updates the user's daily answer
 */
exports.submitAnswer = async (req, res) => {
    const { question_id, answer, is_shared } = req.body;
    const userId = req.user.id;
    
    // 1. Generate a clean YYYY-MM-DD for the unique constraint
    const todayStr = new Date().toISOString().split('T')[0];
    const day_key = `${todayStr}-${userId}`; // Ensure variable name matches the one used in the array below

    try {
        // 2. Fetch Couple ID directly to avoid 404 "Couple Not Found" if middleware fails
        const userRes = await pool.query("SELECT couple_id FROM users WHERE id = $1", [userId]);
        const coupleId = userRes.rows[0]?.couple_id;

        if (!coupleId) {
            return res.status(403).json({ error: "Access denied. You are not linked to a world/couple yet." });
        }

        // 3. Get Partner ID for notification
        const coupleResult = await pool.query(
            "SELECT creator_id, partner_id FROM couples WHERE id = $1", [coupleId]
        );
        
        if (coupleResult.rows.length === 0) {
            return res.status(404).json({ error: "The relationship record for this couple no longer exists." });
        }

        const couple = coupleResult.rows[0];
        const partnerId = (couple.creator_id === userId) ? couple.partner_id : couple.creator_id;

        // 4. Upsert answer using the UNIQUE day_key
        // This prevents a user from answering the same question twice on the same day
        const result = await pool.query(
            `INSERT INTO daily_answers (user_id, couple_id, question_id, answer, is_shared, day_key)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (day_key) 
             DO UPDATE SET answer = EXCLUDED.answer, is_shared = EXCLUDED.is_shared, updated_at = NOW()
             RETURNING *`,
            [userId, coupleId, question_id, answer, is_shared, day_key]
        );

        // 5. Notify Partner if shared
        if (is_shared && partnerId) {
            const io = req.app.get('socketio');
            // Ensure notificationService is imported at the top of this file
            await createNotification({
                recipientId: partnerId,
                senderId: userId,
                type: 'daily_answer',
                message: `Your partner shared their thoughts for today! ✍️`,
                link: `/daily`
            }, io);
        }

        res.json(result.rows[0]);

    } catch (err) {
        console.error("❌ SUBMIT_ANSWER_ERROR:", err.message);
        res.status(500).json({ error: err.message });
    }
};

/**
 * GET TODAY'S STATUS
 * Returns your answer and your partner's answer (if they shared it)
 */
exports.getDailyStatus = async (req, res) => {
    const userId = req.user.id;
    const coupleId = req.user.couple_id;
    const todayStr = new Date().toISOString().split('T')[0];

    try {
        // Fetch both answers for the couple for today
        const result = await pool.query(
            `SELECT * FROM daily_answers 
             WHERE couple_id = $1 AND day_key LIKE $2`,
            [coupleId, `${todayStr}%`]
        );

        // Organize the data so the frontend knows whose is whose
        const myAnswer = result.rows.find(row => row.user_id === userId) || null;
        const partnerAnswerRaw = result.rows.find(row => row.user_id !== userId) || null;

        // Security: Only send partner's answer text if is_shared is true
        let partnerAnswer = null;
        if (partnerAnswerRaw) {
            partnerAnswer = {
                id: partnerAnswerRaw.id,
                is_shared: partnerAnswerRaw.is_shared,
                answer: partnerAnswerRaw.is_shared ? partnerAnswerRaw.answer : "Hidden until shared",
                created_at: partnerAnswerRaw.created_at
            };
        }

        res.json({
            myAnswer,
            partnerAnswer
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};