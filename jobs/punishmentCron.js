const cron = require('node-cron');
const { pool } = require('../config/db');
const { createNotification } = require('../services/notificationService');
const cleanupFailedImages = require('./cloudinaryCleanup');

const initPunishmentCron = () => {
    // Runs at 00:01 every day
    cron.schedule('1 0 * * *', async () => {
        console.log('Running Midnight Punishment Audit... 🕒');
        
        try {
            const yesterday = new Date();
            yesterday.setDate(yesterday.getDate() - 1);
            const dateStr = yesterday.toISOString().split('T')[0];

            // 1. Find tasks that were 'failed' (rejected by partner) 
            // but the user never completed the resulting punishment.
            const slackers = await pool.query(
                `SELECT * FROM daily_tasks 
                 WHERE scheduled_date = $1 
                 AND status = 'failed' 
                 AND punishment_completed = false`,
                [dateStr]
            );

            for (const row of slackers.rows) {
                // If they already had a punishment name, double it. 
                // If they hadn't even spun the wheel yet, give them a 'System Default' punishment.
                const currentPunishment = row.punishment_rolled || "Default: 20 Pushups";
                const doubledMessage = `DOUBLED: ${currentPunishment}`;

                await pool.query(
                    `UPDATE daily_tasks 
                     SET punishment_rolled = $1, 
                         punishment_completed = false 
                     WHERE id = $2`,
                    [doubledMessage, row.id]
                );

                // Notify the user they are in trouble
                await createNotification({
                    recipientId: row.user_id,
                    senderId: 0, // System ID
                    type: 'punishment_doubled',
                    message: `⚠️ Midnight deadline passed! Your punishment was doubled: ${doubledMessage}`,
                    link: '/wheel'
                });

                // Notify the partner so they can enjoy the justice
                const partnerRes = await pool.query(
                    "SELECT id FROM users WHERE couple_id = $1 AND id != $2",
                    [row.couple_id, row.user_id]
                );
                
                if (partnerRes.rows[0]) {
                    await createNotification({
                        recipientId: partnerRes.rows[0].id,
                        senderId: 0,
                        type: 'partner_slacking',
                        message: `Your partner ignored their debt. The system has doubled their punishment! 😈`
                    });
                }
            }

            // 2. Clean up the rejected photos from yesterday to save Cloudinary space
            await cleanupFailedImages();

            console.log(`✅ Audit complete. Processed ${slackers.rowCount} slackers.`);
        } catch (err) {
            console.error('Cron Job Error:', err);
        }
    });
};

module.exports = initPunishmentCron;