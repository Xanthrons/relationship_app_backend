const fs = require('fs');
const path = require('path');
// This ensures it finds the .env in your root folder regardless of where you run the script from
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const {pool} = require('./db');

const seedDatabase = async () => {
    try {
        // 1. Read the JSON file
        const filePath = path.join(__dirname, 'data', 'dailyQuestions.json');
        const rawData = fs.readFileSync(filePath, 'utf8');
        const jsonData = JSON.parse(rawData);
        const questions = jsonData.data;

        console.log(`Starting seed: ${questions.length} questions found.`);

        // 2. Loop and Insert
        for (const q of questions) {
            await pool.query(
                `INSERT INTO daily_questions (id, month, day, theme, question)
                 VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (id) 
                 DO UPDATE SET 
                    month = EXCLUDED.month, 
                    day = EXCLUDED.day, 
                    theme = EXCLUDED.theme, 
                    question = EXCLUDED.question`,
                [q.ID, q.Month, q.Day, q.Theme, q.Question]
            );
        }

        console.log('✅ Database seeded successfully!');
        process.exit(0);
    } catch (err) {
        console.error('❌ Error seeding database:', err);
        process.exit(1);
    }
};

seedDatabase();