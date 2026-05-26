// src/routes/index.js
const express   = require('express');
const rateLimit = require('express-rate-limit');

const pushController      = require('../controllers/pushController');
const dashboardController = require('../controllers/dashboardController');
const authController      = require('../controllers/authController');
const { validateOdooPush, validateJWT } = require('../middleware/auth');
const socketService = require('../services/socketService');

const router = express.Router();

// ─────────────────────────────────────────────────────────
// RATE LIMITERS
// ─────────────────────────────────────────────────────────

const pushLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000'),
  max: 500,  // Odoo can push up to 500 times/min
  message: { error: 'Too many push requests' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
});

const apiLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000'),
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '200'),
  message: { error: 'Rate limit exceeded' },
  standardHeaders: true,
  legacyHeaders: false,
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max: 20,
  message: { error: 'Too many auth requests' },
});

// ─────────────────────────────────────────────────────────
// HEALTH CHECK (no auth required)
// ─────────────────────────────────────────────────────────

router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'odoo-realtime-bridge',
    serverTime: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
  });
});

// ─────────────────────────────────────────────────────────
// AUTH ROUTES
// ─────────────────────────────────────────────────────────

router.post('/auth/token', authLimiter, authController.issueToken);
router.get('/auth/verify', validateJWT, authController.verifyToken);

// ─────────────────────────────────────────────────────────
// ODOO PUSH ROUTES (secured with HMAC token)
// ─────────────────────────────────────────────────────────

router.get('/push/status',        pushLimiter, pushController.getStatus);
router.post('/push',              pushLimiter, validateOdooPush, pushController.handlePush);
router.post('/push/bulk',         pushLimiter, validateOdooPush, pushController.handleBulkPush);

// ─────────────────────────────────────────────────────────
// DASHBOARD DATA ROUTES (secured with JWT)
// ─────────────────────────────────────────────────────────

// Allow unauthenticated in development
const dashboardAuth = (req, res, next) => {
  if (process.env.NODE_ENV !== 'production') return next();
  return validateJWT(req, res, next);
};

router.get('/dashboard/kpi',            apiLimiter, dashboardAuth, dashboardController.getKPIs);
router.get('/dashboard/sales',          apiLimiter, dashboardAuth, dashboardController.getSalesChart);
router.get('/dashboard/products',       apiLimiter, dashboardAuth, dashboardController.getTopProducts);
router.get('/dashboard/stock',          apiLimiter, dashboardAuth, dashboardController.getStockLevels);
router.get('/dashboard/ar-aging',       apiLimiter, dashboardAuth, dashboardController.getARAgingSummary);
router.get('/dashboard/cache',          apiLimiter, dashboardAuth, dashboardController.getCachedData);
router.get('/dashboard/stream/sales',   apiLimiter, dashboardAuth, dashboardController.streamSalesData);

// ─────────────────────────────────────────────────────────
// ADMIN ROUTES (JWT required in all environments)
// ─────────────────────────────────────────────────────────

router.get('/admin/connections', validateJWT, (req, res) => {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin role required' });
  }
  const stats = socketService.getConnectionStats();
  res.json({ ok: true, ...stats });
});

router.post('/admin/broadcast', validateJWT, (req, res) => {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin role required' });
  }
  const { eventType, payload } = req.body;
  if (!eventType || !payload) {
    return res.status(400).json({ error: 'eventType and payload required' });
  }
  socketService.broadcast(eventType, payload);
  res.json({ ok: true, message: `Broadcast sent for ${eventType}` });
});

module.exports = router;
