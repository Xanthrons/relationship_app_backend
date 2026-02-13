const { query } = require('../config/db');

const coupleModel = {
    // Create the shared space (for User A)
    async create(inviteCode, creatorId, creatorRole) {
        const roleColumn = creatorRole === 'boyfriend' ? 'boyfriend' : 'girlfriend';
        const sql = `
            INSERT INTO couples (invite_code, ${roleColumn}, status)
            VALUES ($1, $2, 'waiting')
            RETURNING *;
        `;
        const result = await query(sql, [inviteCode, creatorId]);
        return result.rows[0];
    },

    // Find a couple by code (for User B joining)
    async findByCode(inviteCode) {
        const sql = 'SELECT * FROM couples WHERE invite_code = $1';
        const result = await query(sql, [inviteCode.toUpperCase()]);
        return result.rows[0];
    }
};

module.exports = coupleModel;