const express = require('express');
const router = express.Router();
const authCtrl = require('../controllers/authController');

// Standard Auth
router.post('/register', authCtrl.register);
router.post('/login', authCtrl.login);
router.post('/google', authCtrl.googleAuth);

// Password Management
router.post('/forgot-password', authCtrl.forgotPassword);
router.post('/verify-reset-code', authCtrl.verifyResetCode);
router.post('/reset-password', authCtrl.resetPassword);

module.exports = router;