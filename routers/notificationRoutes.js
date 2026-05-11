const router = require('express').Router();
const notificationController = require('../controllers/notificationController');
const { protect, hasCouple } = require('../middlewares/authMiddleware');

router.use(protect);
router.use(hasCouple);

router.get('/', notificationController.getNotifications);
router.put('/read', notificationController.markAsRead);

module.exports = router;