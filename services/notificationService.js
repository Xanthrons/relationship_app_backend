const { pool } = require('../config/db');

/**
 * Creates a notification and emits a socket event if io is provided.
 * @param {Object} io - Socket.io instance passed from controller
 */
const createNotification = async ({ recipientId, senderId, type, message, link }, io = null) => {
    try {
        const result = await pool.query(
            `INSERT INTO notifications (recipient_id, sender_id, type, message, link)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING *`,
            [recipientId, senderId, type, message, link]
        );
        
        const newNotif = result.rows[0];

        // If socket instance is passed, alert the recipient immediately
        if (io) {
            // We use a specific room for the user ID to ensure privacy
            io.to(`user_${recipientId}`).emit('new_notification', newNotif);
        }
        
        return newNotif;
    } catch (err) {
        console.error("Notification Service Error:", err);
    }
};

module.exports = { createNotification };