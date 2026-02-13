const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { protect } = require('../middlewares/authMiddleware');
const multer = require('multer');

// Configure Multer for Shared Memory storage
const upload = multer({ storage: multer.memoryStorage() });

// --- PUBLIC ROUTES ---
router.post('/register', authController.register);
router.post('/login', authController.login);
router.post('/google', authController.googleAuth);
router.get('/invite-preview/:code', authController.getInvitePreview);

// Password Reset Flow
router.post('/forgot-password', authController.forgotPassword);
router.post('/verify-reset-code', authController.verifyResetCode);
router.post('/reset-password', authController.resetPassword);

// --- PROTECTED ROUTES (Requires Token) ---

// 1. User Profile & Account
router.get('/me', protect, authController.getMe);
router.get('/dashboard', protect, authController.getDashboard);
router.put('/update-profile', protect, authController.updateProfile); 
router.delete('/delete-account', protect, authController.deleteAccount);

// 2. The Smart Onboarding & Coupling Logic
// REPLACED: 'create-invite' with 'onboard-creator'
router.post('/onboard-creator', protect, authController.onboardCreator); 
router.get('/invite-details', protect, authController.getInviteDetails); 
router.post('/pair', protect, authController.pairCouple);
router.post('/unlink', protect, authController.unlinkCouple);

// 3. Shared Features
router.post('/submit-answers', protect, authController.submitWelcomeAnswers); 
router.post('/upsert-shared-picture', protect, upload.single('image'), authController.upsertSharedPicture);
router.delete('/delete-shared-picture', protect, upload.single('image'), authController.deleteSharedPicture);

module.exports = router;