const { pool } = require('../config/db');

exports.recordPunishment = async (req, res) => {
    const { taskId, punishmentName } = req.body;
    const coupleId = req.user.couple_id;

    try {
        await pool.query(
            `UPDATE daily_tasks SET punishment_rolled = $1, punishment_completed = false WHERE id = $2`,
            [punishmentName, taskId]
        );

        // Notify partner that the wheel has spoken
        const io = req.app.get('socketio');
        io.to(`couple_${coupleId}`).emit('punishment_rolled', {
            punishment: punishmentName,
            message: `The wheel landed on: ${punishmentName}! 😈`
        });

        res.json({ success: true, punishment: punishmentName });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

exports.markPunishmentDone = async (req, res) => {
    const { taskId } = req.body;
    try {
        await pool.query(
            "UPDATE daily_tasks SET punishment_completed = true, status = 'approved' WHERE id = $1",
            [taskId]
        );
        res.json({ success: true, message: "Debt settled!" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};