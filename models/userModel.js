const { query } = require('../config/db');

const userModel = {
    /**
     * CREATE NEW USER
     * Used during Register or Google Auth
     */
    async create(email, hashedPassword, name) {
        const sql = `
            INSERT INTO users (email, password_hash, name)
            VALUES ($1, $2, $3)
            RETURNING id, email, name, nickname, avatar_id, couple_id, gender, points, created_at;
        `;
        const result = await query(sql, [email, hashedPassword, name]);
        return result.rows[0];
    },

    /**
     * FIND BY EMAIL
     * Used during Login to verify credentials and return full state
     */
    async findByEmail(email) {
        // We use SELECT * here to ensure password_hash is available for comparison in the controller
        const sql = 'SELECT * FROM users WHERE email = $1';
        const result = await query(sql, [email]);
        return result.rows[0];
    },

    /**
     * FIND BY ID
     * Used by Middleware or Profile screens to get current status
     */
    async findById(id) {
        const sql = `
            SELECT id, email, name, nickname, avatar_id, couple_id, gender, points, created_at
            FROM users 
            WHERE id = $1
        `;
        const result = await query(sql, [id]);
        return result.rows[0];
    },

    /**
     * UPDATE PROFILE
     * Handles nickname, avatar, and gender updates
     */
    async updateProfile(userId, nickname, avatarId, gender) {
        const sql = `
            UPDATE users 
            SET nickname = $1, avatar_id = $2, gender = $3 
            WHERE id = $4 
            RETURNING id, nickname, avatar_id, gender, couple_id, points;
        `;
        const result = await query(sql, [nickname, avatarId, gender, userId]);
        return result.rows[0];
    },

    /**
     * UPDATE POINTS
     * Call this when a user completes a Quest
     */
    async updatePoints(userId, pointsToAdd) {
        const sql = `
            UPDATE users 
            SET points = points + $1 
            WHERE id = $2 
            RETURNING id, points;
        `;
        const result = await query(sql, [pointsToAdd, userId]);
        return result.rows[0];
    },

    /**
     * DELETE USER
     */
    async delete(id) {
        const sql = 'DELETE FROM users WHERE id = $1';
        return await query(sql, [id]);
    }
};

module.exports = userModel;