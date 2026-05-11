const { pool } = require('../config/db');

const checkLockout = async (req, res, next) => {
    const userId = req.user.id;
    const today = new Date().toISOString().split('T')[0];

    try {
        // Check for ANY task from a previous date that is not 'approved'
        const result = await pool.query(
            `SELECT * FROM daily_tasks 
             WHERE user_id = $1 
             AND scheduled_date < $2 
             AND status NOT IN ('approved', 'completed')
             ORDER BY scheduled_date ASC LIMIT 1`,
            [userId, today]
        );

        if (result.rows.length > 0) {
            const overdueTask = result.rows[0];
            return res.status(403).json({
                locked: true,
                message: "LOCKED: You have an outstanding debt from " + overdueTask.scheduled_date.toISOString().split('T')[0],
                overdueTaskId: overdueTask.id,
                currentStatus: overdueTask.status
            });
        }

        // No lockout found, proceed to the route
        next();
    } catch (err) {
        res.status(500).json({ error: "Lockout check failed." });
    }
};

module.exports = checkLockout;