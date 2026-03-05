const fs = require('fs');
const path = require('path');
const { pool } = require('./db');
// Ensure dotenv is loaded to find your Neon DATABASE_URL
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const seedDatabase = async () => {
    try {
        // 1. Locate the JSON file
        const filePath = path.join(__dirname, 'data', 'quests.json');
        
        if (!fs.existsSync(filePath)) {
            throw new Error(`File not found at: ${filePath}`);
        }

        const rawData = fs.readFileSync(filePath, 'utf8');
        const data = JSON.parse(rawData);

        console.log(`🌱 Found ${data.quests.length} quests and ${data.coupons.length} coupons.`);

        // 2. Clear existing library (Optional: Use if you want a fresh start)
        // await pool.query("TRUNCATE quest_library RESTART IDENTITY");

        // 3. Seed Quests
        console.log("Inserting Quests...");
        for (const q of data.quests) {
            await pool.query(
                `INSERT INTO quest_library (type, title, prompt, points_reward, category, image_required) 
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                ['quest', q.title, q.description, q.points_reward, q.category, false]
            );
        }

        // 4. Seed Coupons
        console.log("Inserting Coupons...");
        for (const c of data.coupons) {
            await pool.query(
                `INSERT INTO quest_library (type, title, prompt, point_cost, category, image_required) 
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                ['coupon', c.title, c.description, c.point_cost, c.category, false]
            );
        }

        console.log("✅ Database seeded successfully to Neon!");
        process.exit();
    } catch (err) {
        console.error("❌ Seeding failed:", err);
        process.exit(1);
    }
};

seedDatabase();