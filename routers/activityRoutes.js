const router = require('express').Router();
const activityController = require('../controllers/activityController');
const { protect, hasCouple } = require('../middlewares/authMiddleware');

router.use(protect);
router.use(hasCouple);

// --- DAILY ORCHESTRATION ---
// Get today's state (Quest, Savology, or Coupon)
router.get('/today', activityController.getTodayActivity);

// --- QUEST & TRIAL FLOW ---
// Partner submits 'approved' or 'failed'
router.post('/verdict', activityController.submitVerdict);
// User appeals a 'failed' verdict
router.post('/appeal', activityController.submitAppeal);
// Partner decides final fate after appeal
router.post('/finalize', activityController.finalizeVerdict);

// --- SAVOLOGY & CUSTOM ---
// The dice roll for the board
router.post('/savology-roll', activityController.rollSavology);
router.post('/get-board', activityController.getBoard);
// Partner sets custom quest text
router.post('/set-custom', activityController.setCustomQuest);
// Claim rare coupon rewards
router.post('/redeem-coupon', activityController.redeemCoupon);

module.exports = router;