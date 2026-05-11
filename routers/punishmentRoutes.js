const router = require('express').Router();
const punishmentController = require('../controllers/punishmentController');
const { protect, hasCouple } = require('../middlewares/authMiddleware');
const upload = require('../middlewares/multer');

router.use(protect);
router.use(hasCouple);

// 1. Record the punishment assignment (e.g., "Do 50 pushups")
router.post('/custom', punishmentController.setCustomPunishment);

// 2. Submit proof (Image upload via Multer)
router.post('/complete', upload.single('image'), punishmentController.completePunishment);

// 3. Judge approves the proof and releases the user
router.post('/mark-done', punishmentController.markPunishmentDone);

module.exports = router;