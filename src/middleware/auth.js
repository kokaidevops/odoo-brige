// src/middleware/auth.js
/**
 * Authentication Middleware
 * ─────────────────────────────────────────────────────────
 * Two authentication layers:
 *
 * 1. ODOO PUSH AUTH  — Validates requests from Odoo 16 push mechanism.
 *    Odoo sends a HMAC-SHA256 token in the X-Odoo-Push-Token header,
 *    computed from: SHA256(secret + timestamp + body).
 *
 * 2. FRONTEND JWT AUTH — Validates JWT tokens for frontend clients
 *    connecting via Socket.io or REST endpoints.
 * ─────────────────────────────────────────────────────────
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const logger = require('../utils/logger');

const PUSH_SECRET = process.env.PUSH_SECRET_KEY;
const JWT_SECRET  = process.env.JWT_SECRET;

// Time window in seconds to accept push requests (prevents replay attacks)
const PUSH_TIMESTAMP_TOLERANCE_SEC = 300; // 5 minutes

/**
 * Middleware: Validate Odoo push token
 *
 * Odoo should send:
 *   Header: X-Odoo-Push-Token: <hmac_hex>
 *   Header: X-Odoo-Timestamp: <unix_timestamp>
 *
 * HMAC is computed as: HMAC-SHA256(PUSH_SECRET_KEY, timestamp + '.' + raw_body)
 */
function validateOdooPush(req, res, next) {
  if (!PUSH_SECRET) {
    logger.error('PUSH_SECRET_KEY is not configured');
    return res.status(500).json({ error: 'Server misconfiguration: push secret not set' });
  }

  const receivedToken = req.headers['x-odoo-push-token'];
  const timestamp     = req.headers['x-odoo-timestamp'];

  if (!receivedToken || !timestamp) {
    logger.warn('Push request missing auth headers', { ip: req.ip });
    return res.status(401).json({ error: 'Missing authentication headers' });
  }

  // Validate timestamp freshness (anti-replay)
  const requestTime = parseInt(timestamp, 10);
  const now = Math.floor(Date.now() / 1000);
  if (isNaN(requestTime) || Math.abs(now - requestTime) > PUSH_TIMESTAMP_TOLERANCE_SEC) {
    logger.warn('Push request timestamp out of tolerance window', {
      ip: req.ip,
      timestamp,
      server_time: now,
      diff_sec: Math.abs(now - requestTime),
    });
    return res.status(401).json({ error: 'Request timestamp expired or invalid' });
  }

  // Compute expected HMAC
  // rawBody is populated by the express.raw() middleware in push routes
  const rawBody = req.rawBody || JSON.stringify(req.body);
  const expected = crypto
    .createHmac('sha256', PUSH_SECRET)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');

  // Constant-time comparison (prevents timing attacks)
  const expectedBuf = Buffer.from(expected, 'hex');
  const receivedBuf = Buffer.from(receivedToken, 'hex');

  let isValid = false;
  if (expectedBuf.length === receivedBuf.length) {
    isValid = crypto.timingSafeEqual(expectedBuf, receivedBuf);
  }

  if (!isValid) {
    logger.warn('Push request invalid HMAC token', { ip: req.ip });
    return res.status(401).json({ error: 'Invalid push token' });
  }

  logger.debug('Push request authenticated', { ip: req.ip });
  next();
}

/**
 * Middleware: Validate frontend JWT
 * Expects: Authorization: Bearer <token>
 */
function validateJWT(req, res, next) {
  if (!JWT_SECRET) {
    logger.error('JWT_SECRET is not configured');
    return res.status(500).json({ error: 'Server misconfiguration' });
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }

  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' });
    }
    logger.warn('Invalid JWT token', { ip: req.ip, error: err.message });
    return res.status(401).json({ error: 'Invalid token' });
  }
}

/**
 * Socket.io middleware: Validate JWT from handshake auth
 * socket.handshake.auth.token OR socket.handshake.headers.authorization
 */
function validateSocketAuth(socket, next) {
  if (!JWT_SECRET) {
    return next(new Error('Server misconfiguration'));
  }

  const token =
    socket.handshake.auth?.token ||
    (socket.handshake.headers.authorization || '').replace('Bearer ', '');

  if (!token) {
    // Allow unauthenticated in development
    if (process.env.NODE_ENV !== 'production') {
      socket.user = { id: 'anonymous', role: 'viewer' };
      return next();
    }
    return next(new Error('Authentication required'));
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    socket.user = payload;
    next();
  } catch (err) {
    logger.warn('Socket auth failed', {
      socketId: socket.id,
      error: err.message,
    });
    next(new Error(err.name === 'TokenExpiredError' ? 'Token expired' : 'Invalid token'));
  }
}

/**
 * Generate a JWT token (for initial auth endpoint)
 */
function generateToken(payload) {
  return jwt.sign(payload, JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '24h',
  });
}

/**
 * Capture raw body for HMAC verification before JSON parsing
 */
function captureRawBody(req, res, buf) {
  req.rawBody = buf.toString('utf8');
}

module.exports = {
  validateOdooPush,
  validateJWT,
  validateSocketAuth,
  generateToken,
  captureRawBody,
};
