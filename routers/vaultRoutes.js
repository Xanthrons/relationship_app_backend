const router = require('express').Router();
const vaultController = require('../controllers/vaultController');
const { protect, hasCouple } = require('../middlewares/authMiddleware');

router.use(protect);
router.use(hasCouple);

// Browse the shop
router.get('/marketplace', vaultController.getMarketplace);

// View personal vault/inventory
router.get('/inventory', vaultController.getVaultItems);

// Buy an item (points deducted here)
router.post('/purchase', vaultController.purchaseMarketplaceItem);

module.exports = router;