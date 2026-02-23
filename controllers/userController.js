const { pool } = require('../config/db'); 
const generateInviteLink = (inviteCode) => {
    const baseUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    return `${baseUrl}/join?code=${inviteCode}`;
};

exports.getMe = async (req, res) => {
  const userId = req.user.id;

  try {
    const result = await pool.query(`
      SELECT 
        u.id, u.name, u.nickname, u.couple_id, u.onboarded, u.avatar_id,
        c.invite_code, c.status as couple_status, c.creator_id, c.rel_status
      FROM users u
      LEFT JOIN couples c ON u.couple_id = c.id
      WHERE u.id = $1
    `, [userId]);

    const row = result.rows[0];
    if (!row) return res.status(404).json({ error: "User not found" });

    // Determine the "mode" for the TrafficController logic in App.jsx
    let mode = "solo";
    if (row.couple_id) {
        // If the couple record exists but status is waiting, user is in 'waiting' mode
        mode = (row.couple_status === 'full') ? "couple" : "waiting";
    }

    res.json({
      id: row.id,
      name: row.name,
      nickname: row.nickname,
      avatar_id: row.avatar_id,
      coupleId: row.couple_id,
      onboarded: row.onboarded, 
      mode: mode,               
      inviteCode: row.invite_code,
      inviteLink: row.invite_code ? generateInviteLink(row.invite_code) : null,
      isCreator: row.creator_id === userId
    });

  } catch (err) {
    res.status(500).json({ error: "Failed to fetch user data" });
  }
};

exports.updateProfile = async (req, res) => {
    const userId = req.user.id;
    const { nickname, avatar_id, rel_status } = req.body; 
    const dbClient = await pool.connect();

    try {
        await dbClient.query('BEGIN');

        // Identity update (Avatar is cast to Number)
        const userUpdate = await dbClient.query(
            `UPDATE users SET 
             nickname = COALESCE($1, nickname), 
             avatar_id = COALESCE($2, avatar_id) 
             WHERE id = $3 RETURNING couple_id`,
            [nickname, avatar_id ? parseInt(avatar_id) : null, userId]
        );

        const coupleId = userUpdate.rows[0].couple_id;

        // Relationship Evolution (Dating -> Engaged -> etc)
        if (rel_status && coupleId) {
            await dbClient.query(
                `UPDATE couples SET rel_status = $1 WHERE id = $2`,
                [rel_status, coupleId]
            );
        }

        await dbClient.query('COMMIT');
        res.json({ message: "Settings updated successfully!" });
    } catch (err) {
        await dbClient.query('ROLLBACK');
        res.status(500).json({ error: "Update failed." });
    } finally {
        dbClient.release();
    }
};
exports.deleteAccount = async (req, res) => {
    const userId = req.user.id; 
    try {
        // This will also trigger the unlink logic if you have FK constraints set to CASCADE
        await pool.query('DELETE FROM users WHERE id = $1', [userId]);
        res.json({ message: "Account deleted." });
    } catch (err) { 
        res.status(500).json({ error: "Delete failed" }); 
    }
};