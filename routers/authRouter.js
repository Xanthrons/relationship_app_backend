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

// 1. User Profile & Core Auth
router.get('/me', protect, authController.getMe); // Used by TrafficController
router.put('/update-profile', protect, authController.updateProfile); 
router.delete('/delete-account', protect, authController.deleteAccount);

// 2. Dashboard Logic
// This new route provides the specific "Partner Status" data for the Dashboard UI
router.get('/dashboard-details', protect, authController.getDashboardDetails); 
// Existing route (if you still use it for general stats)
router.get('/dashboard', protect, authController.getDashboard);

// 3. The Onboarding & Coupling Logic
router.post('/onboard-creator', protect, authController.onboardCreator); 
router.get('/invite-details', protect, authController.getInviteDetails); 
router.post('/pair', protect, authController.pairCouple);
router.post('/unlink', protect, authController.unlinkCouple);

// 4. Welcome Questions & Joint Setup
// Updated path to be more descriptive, but you can keep /submit-answers 
// as long as the controller sets user.onboarded = true
router.post('/submit-answers', protect, authController.submitWelcomeAnswers); 

// 5. Shared Media
router.post('/upsert-shared-picture', protect, upload.single('image'), authController.upsertSharedPicture);
router.delete('/delete-shared-picture', protect, authController.deleteSharedPicture);

module.exports = router;