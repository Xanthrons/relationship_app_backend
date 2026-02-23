const express = require('express');
const router = express.Router();
const relCtrl = require('../controllers/relationshipController');
const { protect, hasCouple, hasFullCouple } = require('../middlewares/authMiddleware');
const multer = require('multer');

const upload = multer({ storage: multer.memoryStorage() });

// --- PUBLIC ROUTES ---
router.get('/preview/:code', relCtrl.getInvitePreview);

// --- PROTECTED ROUTES (Logged in only) ---
router.use(protect);

// Basic Dashboard access (Controller handles Solo vs Waiting vs Couple modes)
router.get('/dashboard', relCtrl.getDashboard);

// Onboarding & Entry Logic
router.post('/onboard-creator', relCtrl.onboardCreator);
router.post('/pair', relCtrl.pairCouple);

// --- RELATIONSHIP MANAGEMENT (Must have a couple_id, even if waiting) ---
router.post('/submit-answers', hasCouple, relCtrl.submitWelcomeAnswers);
router.post('/unlink', hasCouple, relCtrl.unlinkCouple);
router.post('/toggle-pause', hasCouple, relCtrl.togglePause);
router.post('/relink', hasCouple, relCtrl.relinkCouple);

// --- SHARED FEATURES (Strict: Requires a partner present) ---
router.get('/comparison', hasFullCouple, relCtrl.getWelcomeComparison);
router.post('/reveal-seen', hasFullCouple, relCtrl.markRevealAsSeen);

// Shared Media
router.post('/shared-picture', hasFullCouple, upload.single('image'), relCtrl.upsertSharedPicture);
router.delete('/shared-picture', hasFullCouple, relCtrl.deleteSharedPicture);

module.exports = router;