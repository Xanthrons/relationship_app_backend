// src/utils/userHelpers.js
const pool = require('../config/db');

/**
 * Checks if a user is currently in "Solo Mode".
 * Solo Mode = No couple_id OR couples table status is 'waiting'.
 */
const checkSoloStatus = async (userId) => {
    try {
        const userRes = await pool.query(
            "SELECT couple_id FROM users WHERE id = $1", 
            [userId]
        );
        const coupleId = userRes.rows[0]?.couple_id;

        // If no couple_id exists, they are definitely solo
        if (!coupleId) return true;

        const coupleRes = await pool.query(
            "SELECT status FROM couples WHERE id = $1", 
            [coupleId]
        );
        
        // If the couple status is 'waiting', they are solo
        return coupleRes.rows[0]?.status === 'waiting';
    } catch (err) {
        console.error("Error checking solo status:", err);
        return true; // Default to solo to prevent partner-logic crashes
    }
};

module.exports = { checkSoloStatus };