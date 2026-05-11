const SAVOLOGY_BOARD = [
  { id: 0, name: "Start", reward: 0, type: "neutral", desc: "Collect your daily energy! ✨" },
  { id: 1, name: "Coffee Tax", reward: 5, type: "save", desc: "Caffeine gods demand a $5 sacrifice to the Vault! ☕" },
{ 
    id: 2, 
    name: "{{partner}} Tribute", 
    reward: 10, 
    type: "penalty", 
    desc: "Pay your {{partner_title}} $10 for being patient. 👑" 
  },
  { id: 3, name: "The Dungeon", reward: 0, type: "jail", desc: "No spending today! Locked in the savings zone. ⛓️" },
  { id: 4, name: "Small Treat", reward: 3, type: "save", desc: "A little something for later. Save $3! 🍬" },
  { id: 5, name: "Market Crash", reward: -10, type: "penalty", desc: "Oops! Market volatility. Lose $10 from the fund. 📉" },
  { id: 6, name: "Date Night Fund", reward: 15, type: "save", desc: "Investing in our next dinner. Save $15! 🥂" },
  { id: 7, name: "Surprise Gift", reward: 20, type: "jackpot", desc: "A random act of kindness! Save $20! 🎁" },
  { id: 8, name: "Tax Man", reward: 8, type: "save", desc: "The government (me) says save $8! 💸" },
  { id: 9, name: "The Gym", reward: 2, type: "save", desc: "Workout for the wallet! Save $2. 💪" },
  { id: 10, name: "Luxury Lane", reward: -25, type: "penalty", desc: "You bought something fancy? Fine: pay $25! 👜" },
  { id: 11, name: "Free Parking", reward: 0, type: "neutral", desc: "Just breathe. Nothing happens here. 🧘" },
  { id: 12, name: "Bonus Pay", reward: 30, type: "jackpot", desc: "Your hard work pays off! Save $30! 💰" },
  { id: 13, name: "Fast Food Trap", reward: 12, type: "save", desc: "Cook at home instead! Save the $12 you would've spent. 🍔" },
  { id: 14, name: "The Dungeon", reward: 0, type: "jail", desc: "Locked up again! No spending allowed! ⛓️" },
  { id: 15, name: "Pet Tax", reward: 7, type: "save", desc: "The furball needs treats! Save $7. 🐾" },
  { id: 16, name: "Chance", reward: 0, type: "neutral", desc: "Roll again! Fate is undecided. 🎲" },
  { id: 17, name: "Holiday Savings", reward: 25, type: "save", desc: "Future us will be happy! Save $25. ✈️" },
  { id: 18, name: "The Late Fee", reward: 5, type: "penalty", desc: "You were slow, pay up $5! 🐢" },
  { id: 19, name: "JACKPOT", reward: 50, type: "jackpot", desc: "LUCKY DAY! $50 straight to the trip fund! ✈️" }
];

module.exports = { SAVOLOGY_BOARD };