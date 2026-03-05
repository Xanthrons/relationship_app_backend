const router = require('express').Router();
const { pool } = require('../config/db');
const { protect, hasCouple } = require('../middlewares/authMiddleware');

router.use(protect);
router.use(hasCouple);

router.get('/summary', async (req, res) => {
    const userId = req.user.id;
    const coupleId = req.user.couple_id;
    const today = new Date().toISOString().split('T')[0];

    try {
        // Fetch everything relevant for today in parallel
        const [quest, mood, highlights] = await Promise.all([
            pool.query("SELECT * FROM daily_tasks WHERE user_id = $1 AND scheduled_date = $2", [userId, today]),
            pool.query("SELECT * FROM moods WHERE user_id = $1 AND day_key LIKE $2", [userId, `${today}%`]),
            pool.query("SELECT * FROM daily_highlights_gratitude WHERE couple_id = $1 AND day_key LIKE $2", [coupleId, `${today}%`]),
        ]);

        res.json({
            quest: quest.rows[0] || null,
            mood: mood.rows[0] || null,
            highlights: highlights.rows // Contains both partners
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;