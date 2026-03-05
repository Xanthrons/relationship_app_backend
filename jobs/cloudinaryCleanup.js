const cloudinary = require('../config/cloudinary');
const { pool } = require('../config/db');

const cleanupFailedImages = async () => {
    try {
        // Find tasks from yesterday that were failed/rejected and have a public_id
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const dateStr = yesterday.toISOString().split('T')[0];

        const res = await pool.query(
            `SELECT cloudinary_public_id FROM daily_tasks 
             WHERE scheduled_date = $1 AND status = 'failed' 
             AND cloudinary_public_id IS NOT NULL`,
            [dateStr]
        );

        const publicIds = res.rows.map(row => row.cloudinary_public_id);

        if (publicIds.length > 0) {
            console.log(`🧹 Cleaning up ${publicIds.length} rejected images from Cloudinary...`);
            
            // Cloudinary allows bulk deletion of up to 100 resources
            await cloudinary.api.delete_resources(publicIds);
            
            // Clear the IDs from DB so we don't try to delete them again
            await pool.query(
                "UPDATE daily_tasks SET cloudinary_public_id = NULL WHERE cloudinary_public_id = ANY($1)",
                [publicIds]
            );
        }
    } catch (err) {
        console.error("❌ Cloudinary Cleanup Error:", err);
    }
};

module.exports = cleanupFailedImages;