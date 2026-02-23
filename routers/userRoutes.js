const express = require('express');
const router = express.Router();
const userCtrl = require('../controllers/userController');
const { protect } = require('../middlewares/authMiddleware');

// All user routes are protected
router.use(protect);

router.get('/me', userCtrl.getMe);
router.put('/update', userCtrl.updateProfile);
router.delete('/delete', userCtrl.deleteAccount);

module.exports = router;