const router = require('express').Router();
const moodController = require('../controllers/moodController');
const { protect, hasCouple } = require('../middlewares/authMiddleware');

router.use(protect);
router.use(hasCouple);

router.post('/', moodController.upsertMood);
router.get('/today', moodController.getTodayMood);
router.get('/partner-summary', moodController.getPartnerSummary);

module.exports = router;