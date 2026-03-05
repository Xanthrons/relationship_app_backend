const { pool } = require('../config/db');

exports.getNotifications = async (req, res) => {
    try {
        const result = await pool.query(
            "SELECT * FROM notifications WHERE recipient_id = $1 ORDER BY created_at DESC LIMIT 20",
            [req.user.id]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

exports.markAsRead = async (req, res) => {
    try {
        await pool.query(
            "UPDATE notifications SET is_read = true WHERE recipient_id = $1 AND is_read = false",
            [req.user.id]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};