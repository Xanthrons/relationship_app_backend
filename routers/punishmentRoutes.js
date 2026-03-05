const router = require('express').Router();
const punishmentController = require('../controllers/punishmentController');
const { protect } = require('../middlewares/authMiddleware');

router.use(protect);

// Record the result of the wheel spin
router.post('/roll', punishmentController.recordPunishment);

// Partner confirms the punishment was actually performed
router.post('/confirm', punishmentController.markPunishmentDone);

module.exports = router;