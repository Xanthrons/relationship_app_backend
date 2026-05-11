const router = require('express').Router();
const highlightController = require('../controllers/highlightController');
const { protect, hasCouple } = require('../middlewares/authMiddleware');

router.use(protect);
router.use(hasCouple);

// Save or update today's highlight/gratitude
router.post('/save',  highlightController.upsertHighlightGratitude);

// Get today's entries for the couple
router.get('/today', highlightController.getDailyHighlights);

module.exports = router;