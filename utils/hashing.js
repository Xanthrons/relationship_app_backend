// backend/src/utils/hashing.js
const bcrypt = require('bcryptjs');

// Hash password with a salt round of 12 (Industry Standard)
const hashPassword = async (password) => {
    return await bcrypt.hash(password, 12);
};

// Compare plain text password with hashed one from DB
const comparePassword = async (password, hashedPassword) => {
    return await bcrypt.compare(password, hashedPassword);
};

module.exports = { hashPassword, comparePassword };