const router = require('express').Router();
const highlightController = require('../controllers/highlightController');
const { protect } = require('../middlewares/authMiddleware');

router.use(protect);

// Save or update today's highlight/gratitude
router.post('/',  highlightController.upsertHighlightGratitude);

// Get today's entries for the couple
router.get('/today', highlightController.getDailyHighlights);

module.exports = router;