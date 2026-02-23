const jwt = require('jsonwebtoken');
const { pool } = require('../config/db');

// 1. Authentication: Is the user logged in at all?
const protect = async (req, res, next) => {
    let token;
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
        try {
            token = req.headers.authorization.split(' ')[1];
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            req.user = { id: decoded.userId }; 
            return next();
        } catch (error) {
            return res.status(401).json({ error: 'Not authorized, token failed' });
        }
    }
    if (!token) return res.status(401).json({ error: 'Not authorized, no token' });
};

// 2. Loose Authorization: Does the user belong to ANY couple record? (Waiting OR Full)
const hasCouple = async (req, res, next) => {
    try {
        const result = await pool.query('SELECT couple_id FROM users WHERE id = $1', [req.user.id]);
        const coupleId = result.rows[0]?.couple_id;

        if (!coupleId) {
            return res.status(403).json({ error: "Access denied. You need a world for this." });
        }

        req.user.coupleId = coupleId; 
        next();
    } catch (err) {
        res.status(500).json({ error: "Server error checking relationship status." });
    }
};

// 3. Strict Authorization: Is the relationship status 'full'? (Both partners present)
const hasFullCouple = async (req, res, next) => {
    try {
        const result = await pool.query(`
            SELECT u.couple_id, c.status 
            FROM users u 
            JOIN couples c ON u.couple_id = c.id 
            WHERE u.id = $1
        `, [req.user.id]);

        const relationship = result.rows[0];

        if (!relationship || !relationship.couple_id) {
            return res.status(403).json({ error: "You are not in a world yet." });
        }

        if (relationship.status !== 'full') {
            return res.status(403).json({ error: "This feature unlocks once your partner joins!" });
        }

        req.user.coupleId = relationship.couple_id;
        next();
    } catch (err) {
        res.status(500).json({ error: "Security check failed." });
    }
};

module.exports = { protect, hasCouple, hasFullCouple };