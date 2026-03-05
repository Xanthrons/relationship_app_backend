const { pool } = require('../config/db');

// 1. Get all possible punishments for the Wheel UI
exports.getWheelItems = async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM wheel_library");
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// 2. Record the result of a spin
exports.saveSpinResult = async (req, res) => {
    const { taskId } = req.body; // No punishmentId from frontend anymore!
    const userId = req.user.id;

    try {
        // 1. Get all punishments from the library
        const libraryRes = await pool.query("SELECT * FROM wheel_library");
        
        if (libraryRes.rows.length === 0) {
            return res.status(404).json({ error: "No punishments found in library." });
        }

        // 2. BACKEND picks the random punishment
        const randomIndex = Math.floor(Math.random() * libraryRes.rows.length);
        const selectedPunishment = libraryRes.rows[randomIndex];

        // 3. Update the daily task with the RANDOM result
        await pool.query(
            `UPDATE daily_tasks 
             SET punishment_id = $1, status = 'punishment_assigned' 
             WHERE id = $2 AND user_id = $3`,
            [selectedPunishment.id, taskId, userId]
        );

        // 4. Send the result back so the frontend can animate the wheel to the correct slice
        res.json({ 
            success: true, 
            punishment: selectedPunishment,
            message: `Fate has spoken: ${selectedPunishment.title} 🎡`
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};