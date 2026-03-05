const router = require('express').Router();
const notificationController = require('../controllers/notificationController');
const { protect } = require('../middlewares/authMiddleware');

router.use(protect);

router.get('/', notificationController.getNotifications);
router.put('/read', notificationController.markAsRead);

module.exports = router;