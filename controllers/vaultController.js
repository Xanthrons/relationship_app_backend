const { pool } = require('../config/db');
const { createNotification } = require('../services/notificationService');
const { checkSoloStatus } = require('../utils/userHelpers');

/**
 * 1. GET USER INVENTORY (The Vault)
 */
exports.getVaultItems = async (req, res) => {
    const userId = req.user.id;
    try {
        const result = await pool.query(
            "SELECT * FROM collected_items WHERE user_id = $1 ORDER BY created_at DESC", 
            [userId]
        );
        res.json(result.rows);
    } catch (err) {
        console.error("GET_VAULT_ERROR:", err.message);
        res.status(500).json({ error: "Failed to load vault items." });
    }
};

/**
 * 2. GET MARKETPLACE
 */
exports.getMarketplace = async (req, res) => {
    try {
        const items = await pool.query("SELECT * FROM marketplace_items ORDER BY cost ASC");
        res.json(items.rows);
    } catch (err) {
        res.status(500).json({ error: "Failed to load shop." });
    }
};

/**
 * 3. PURCHASE ITEM
 */
exports.purchaseMarketplaceItem = async (req, res) => {
    const { itemId } = req.body; 
    const userId = req.user.id;

    try {
        await pool.query('BEGIN');

        const itemRes = await pool.query("SELECT * FROM marketplace_items WHERE id = $1 FOR UPDATE", [itemId]);
        if (itemRes.rowCount === 0) throw new Error("Item not found");
        
        const { cost, category, metadata, name } = itemRes.rows[0];

        const userRes = await pool.query("SELECT points FROM users WHERE id = $1 FOR UPDATE", [userId]);
        if (userRes.rows[0].points < cost) {
            await pool.query('ROLLBACK');
            return res.status(400).json({ error: "Insufficient points." });
        }

        await pool.query("UPDATE users SET points = points - $1 WHERE id = $2", [cost, userId]);

        if (category === 'escape') {
            await pool.query("UPDATE users SET status = 'free', jail_days_count = 0 WHERE id = $1", [userId]);
        } else {
            await pool.query(
                "INSERT INTO collected_items (user_id, item_type, item_name, item_data) VALUES ($1, $2, $3, $4)", 
                [userId, category, name, metadata]
            );
        }

        // Optional: Notify partner of a big purchase
        const isSolo = await checkSoloStatus(userId);
        if (!isSolo) {
            const partnerId = await getPartnerId(userId);
            await createNotification(partnerId, userId, 'item_purchased', `Your partner just bought a ${name} from the shop! 🛍️`);
        }

        await pool.query('COMMIT');
        res.json({ success: true, message: `Purchased ${name} successfully!` });
    } catch (err) {
        await pool.query('ROLLBACK');
        console.error("PURCHASE_ERROR:", err.message);
        res.status(500).json({ error: "Purchase failed." });
    }
};

/**
 * 4. USE VAULT ITEM (Includes Jail-Free & Coupons)
 */
exports.useVaultItem = async (req, res) => {
    const { vaultItemId, taskId } = req.body;
    const userId = req.user.id;

    try {
        const itemRes = await pool.query("SELECT * FROM collected_items WHERE id = $1 AND user_id = $2", [vaultItemId, userId]);
        const item = itemRes.rows[0];
        if (!item) return res.status(404).json({ error: "Item not found" });

        const isSolo = await checkSoloStatus(userId);
        const partnerId = !isSolo ? await getPartnerId(userId) : null;

        if (item.item_name === 'Jail-Free Card') {
            await pool.query("UPDATE collected_items SET status = 'used' WHERE id = $1", [vaultItemId]);
            await pool.query("UPDATE users SET status = 'free', jail_days_count = 0 WHERE id = $1", [userId]);
            
            // If they are using it against a specific task
            if (taskId) {
                await pool.query("UPDATE daily_tasks SET status = 'approved', punishment_rolled = 'Used Jail-Free Card' WHERE id = $1", [taskId]);
            }

            if (partnerId) {
                await createNotification(partnerId, userId, 'jail_free_used', "Your partner used a Jail-Free card! They are out of the dungeon. 🎫");
            }

            return res.json({ success: true, message: "🎫 Card used! You are free." });
        }

        // Logic for Coupons/Physical items
        await pool.query("UPDATE collected_items SET status = 'pending_fulfillment' WHERE id = $1", [vaultItemId]);
        
        if (partnerId) {
            await createNotification(partnerId, userId, 'coupon_redeemed', `REWARD TIME! Your partner used their "${item.item_name}" coupon! 🎁`);
            
            // Emit socket so partner's UI shows the reward popup
            req.app.get('socketio').to(`couple_${req.user.couple_id}`).emit('coupon_alert', { 
                item_name: item.item_name,
                user_name: req.user.name 
            });
        }

        res.json({ success: true, message: "Coupon sent to partner! Use Reclaim if they don't do it." });
    } catch (err) { res.status(500).json({ error: err.message }); }
};

/**
 * 5. RECLAIM ITEM
 */
exports.reclaimItem = async (req, res) => {
    const { vaultItemId } = req.body;
    const userId = req.user.id;

    try {
        await pool.query(
            "UPDATE collected_items SET status = 'active' WHERE id = $1 AND user_id = $2",
            [vaultItemId, userId]
        );
        res.json({ success: true, message: "Item reclaimed and added back to your vault!" });
    } catch (err) { res.status(500).json({ error: "Reclaim failed." }); }
};

/**
 * 6. TRADE-IN SYSTEM
 */
exports.tradeInItem = async (req, res) => {
    const { vaultItemId } = req.body;
    const userId = req.user.id;

    try {
        const itemRes = await pool.query("SELECT * FROM collected_items WHERE id = $1 AND user_id = $2", [vaultItemId, userId]);
        if (itemRes.rowCount === 0) return res.status(404).json({ error: "Item not found in vault." });

        const item = itemRes.rows[0];
        const pointValue = (item.item_type === 'mercy') ? 50 : 25;

        await pool.query('BEGIN');
        await pool.query("DELETE FROM collected_items WHERE id = $1", [vaultItemId]);
        await pool.query("UPDATE users SET points = points + $1 WHERE id = $2", [pointValue, userId]);
        await pool.query('COMMIT');

        res.json({ success: true, message: `Exchanged ${item.item_name} for ${pointValue} points! 💰` });
    } catch (err) {
        await pool.query('ROLLBACK');
        res.status(500).json({ error: "Trade-in failed." });
    }
};

// --- HELPER ---
async function getPartnerId(userId) {
    // 1. Get the couple_id for the current user
    const userRes = await pool.query("SELECT couple_id FROM users WHERE id = $1", [userId]);
    const coupleId = userRes.rows[0]?.couple_id;

    if (!coupleId) return null;

    // 2. Find the OTHER user in that same couple
    const partnerRes = await pool.query(
        "SELECT id FROM users WHERE couple_id = $1 AND id != $2 LIMIT 1", 
        [coupleId, userId]
    );
    
    return partnerRes.rows[0]?.id || null;
}