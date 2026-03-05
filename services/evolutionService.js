const APP_LEVELS = {
    1: { name: "Tiny Seed", icon: "🌱" },
    2: { name: "Blooming Daisy", icon: "🌼" },
    3: { name: "Playful Puppy", icon: "🐶" },
    4: { name: "Cuddly Bunny", icon: "🐰" },
    5: { name: "Graceful Kitten", icon: "🐱" },
    6: { name: "Happy Panda", icon: "🐼" },
    7: { name: "Social Butterfly", icon: "🦋" },
    8: { name: "Magic Unicorn", icon: "🦄" },
    9: { name: "Golden Dragon", icon: "🐉" },
    10: { name: "Eternal Soulmates", icon: "👑" },
};

const getEvolutionProgress = (streak_high, streak_steady) => {
    const highProgress = (streak_high / 5) * 100;   // 5 days of "Elite/Radiant"
    const steadyProgress = (streak_steady / 8) * 100; // 8 days of "Good/Chilled"
    return Math.min(Math.max(highProgress, steadyProgress), 100);
};

const calculateNextStats = (user, currentScore) => {
    let { streak_high = 0, streak_steady = 0, streak_low = 0, level = 1 } = user;

    // 1. Convert 10-point scale to Streaks
    if (currentScore >= 9) { 
        // Radiant (9) or Elite (10)
        streak_high += 1;
        streak_steady += 1;
        streak_low = 0;
    } else if (currentScore >= 6) { 
        // Good (6), Chilled (7), or High Vibe (8)
        streak_steady += 1;
        streak_high = 0;
        streak_low = 0;
    } else if (currentScore <= 3) {
        // Exhausted (1), Low (2), or Meh (3)
        streak_low += 1;
        streak_high = 0;
        streak_steady = 0;
    } else {
        // Neutral (4) or Okay (5) - Maintain steady streak without incrementing
        streak_high = 0;
    }

    // 2. Level Up Logic
    let didLevelUp = false;
    if (level < 10 && (streak_high >= 5 || streak_steady >= 8)) {
        level += 1;
        streak_high = 0; 
        streak_steady = 0;
        didLevelUp = true;
    }

    const currentLevelData = APP_LEVELS[level] || APP_LEVELS[1];
    const nextProgress = getEvolutionProgress(streak_high, streak_steady);

    return { 
        streak_high, 
        streak_steady, 
        streak_low, 
        level, 
        didLevelUp, 
        progress: nextProgress,
        levelName: currentLevelData.name,
        levelIcon: currentLevelData.icon
    };
};

module.exports = { calculateNextStats, getEvolutionProgress, APP_LEVELS };