const express = require('express');
const router = express.Router();
const dailyController = require('../controllers/dailyController');
const { protect, hasCouple } = require('../middlewares/authMiddleware');

// The order matters! protect first, then hasCouple, then the controller
router.post('/answer', protect, hasCouple, dailyController.submitAnswer);
router.get('/task', protect, dailyController.getDailyTask);
router.get('/status', protect, hasCouple, dailyController.getDailyStatus);

module.exports = router;