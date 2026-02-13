const { query } = require('../config/db');

const userModel = {
    async create(email, hashedPassword, name) {
        const sql = `
            INSERT INTO users (email, password_hash, name)
            VALUES ($1, $2, $3)
            RETURNING id, email, name, nickname, avatar_id, couple_id, gender;
        `;
        const result = await query(sql, [email, hashedPassword, name]);
        return result.rows[0];
    },

    async findByEmail(email) {
        const sql = 'SELECT * FROM users WHERE email = $1';
        const result = await query(sql, [email]);
        return result.rows[0];
    },

    async findById(id) {
        const sql = `
            SELECT id, email, name, nickname, avatar_id, couple_id, gender 
            FROM users 
            WHERE id = $1
        `;
        const result = await query(sql, [id]);
        return result.rows[0];
    },

    async updateProfile(userId, nickname, avatarId, gender) {
        const sql = `
            UPDATE users 
            SET nickname = $1, avatar_id = $2, gender = $3 
            WHERE id = $4 
            RETURNING id, nickname, avatar_id, gender;
        `;
        const result = await query(sql, [nickname, avatarId, gender, userId]);
        return result.rows[0];
    },

    async delete(id) {
        const sql = 'DELETE FROM users WHERE id = $1';
        return await query(sql, [id]);
    }
};

module.exports = userModel;