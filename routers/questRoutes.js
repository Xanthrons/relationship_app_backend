const router = require('express').Router();
const questController = require('../controllers/questController');
const wheelController = require('../controllers/wheelController');
const { protect, hasCouple } = require('../middlewares/authMiddleware');
const upload = require('../middlewares/multer');

// Apply protection and couple-check to all quest routes
router.use(protect);
router.use(hasCouple); 

// --- CORE QUEST LOGIC ---

// Get today's task (Rolls for Savology, Quest, or Coupon if it's the first login)
router.get('/today', questController.getTodayQuest);

// Partner submits 'approved' or 'failed' for a Quest
router.post('/verdict', questController.submitVerdict);

// User appeals a 'failed' verdict
router.post('/appeal', questController.submitAppeal);

// Partner decides the final fate after an appeal
router.post('/finalize', questController.finalizeVerdict);

// Partner sets a custom quest (for 'Partner Choice' days)
router.post('/set-custom', questController.setCustomQuest);


// --- SAVOLOGY LOGIC ---

// The dice roll for the Monopoly board
router.post('/savology-roll', questController.rollSavology);


// --- COUPON LOGIC ---

// Claim the coupon reward when it appears as the daily task
router.post('/redeem-coupon', questController.redeemCoupon);

// --- WHEEL & PUNISHMENT ROUTES ---

// Get the list of punishments for the Wheel UI
router.get('/wheel/items', wheelController.getWheelItems);

// Save what the user landed on
router.post('/wheel/spin-result', wheelController.saveSpinResult);

// Final step: User proves they did the punishment
router.post('/wheel/complete', upload.single('image'), questController.completePunishment);

module.exports = router;