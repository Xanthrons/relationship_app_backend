const { pool } = require('../config/db');

/**
 * 1. GET ALL ROOMS FOR A COUPLE
 * Used to populate the sidebar/navigation with active topics.
 */
exports.getRooms = async (req, res) => {
    const coupleId = req.user.couple_id;
    try {
        const result = await pool.query(
            "SELECT * FROM chat_rooms WHERE couple_id = $1 AND is_active = TRUE ORDER BY id ASC",
            [coupleId]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: "Failed to load rooms." });
    }
};

/**
 * 2. GET MESSAGES FOR A SPECIFIC ROOM
 * Fetches history when a user clicks on a topic (General, Finance, etc.)
 */
exports.getRoomMessages = async (req, res) => {
    const { roomId } = req.params;
    try {
        const result = await pool.query(
            `SELECT m.*, u.username 
             FROM messages m 
             JOIN users u ON m.sender_id = u.id 
             WHERE m.room_id = $1 
             ORDER BY m.created_at ASC LIMIT 100`,
            [roomId]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: "Failed to load messages." });
    }
};

/**
 * 3. SEND MESSAGE (Persistence)
 * Saves the message to the DB (Socket.io handles the real-time broadcast)
 */
exports.sendMessage = async (req, res) => {
    const { roomId, content } = req.body;
    const userId = req.user.id;
    try {
        const result = await pool.query(
            "INSERT INTO messages (room_id, sender_id, content) VALUES ($1, $2, $3) RETURNING *",
            [roomId, userId, content]
        );
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: "Failed to send message." });
    }
};

/**
 * 4. TOGGLE ROOM STATUS
 * Allows couples to "Turn on" Health, Finance, or custom rooms.
 */
exports.toggleRoom = async (req, res) => {
    const { roomName, isActive } = req.body;
    const coupleId = req.user.couple_id;
    try {
        await pool.query(
            "UPDATE chat_rooms SET is_active = $1 WHERE couple_id = $2 AND room_name = $3",
            [isActive, coupleId, roomName]
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: "Failed to update room status." });
    }
};
