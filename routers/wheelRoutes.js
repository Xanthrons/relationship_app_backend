const router = require('express').Router();
const wheelController = require('../controllers/wheelController');
const { protect, hasCouple } = require('../middlewares/authMiddleware');

router.use(protect);
router.use(hasCouple);

// Get the list of punishments for the Wheel UI
router.get('/items', wheelController.getWheelItems);

// Save the randomized result (Backend picks the winner)
router.post('/spin-result', wheelController.saveSpinResult);

module.exports = router;