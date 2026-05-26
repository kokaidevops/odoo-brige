// src/middleware/cors.js
/**
 * CORS Middleware
 * ─────────────────────────────────────────────────────────
 * Handles Cross-Origin Resource Sharing for:
 *  - HTTP REST endpoints (Express middleware)
 *  - Socket.io handshake (passed to socket.io server options)
 *
 * Origins are configurable via CORS_ORIGINS env variable.
 * In development, all origins are allowed if CORS_ORIGINS is not set.
 * ─────────────────────────────────────────────────────────
 */

const cors = require('cors');
const logger = require('../utils/logger');

/**
 * Parse allowed origins from environment variable
 */
function getAllowedOrigins() {
  const raw = process.env.CORS_ORIGINS;

  if (!raw) {
    if (process.env.NODE_ENV === 'production') {
      logger.warn('CORS_ORIGINS not set in production! Denying all cross-origin requests.');
      return [];
    }
    logger.warn('CORS_ORIGINS not set — allowing all origins (development mode)');
    return '*';
  }

  const origins = raw
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  logger.info('CORS allowed origins configured', { origins });
  return origins;
}

const allowedOrigins = getAllowedOrigins();

/**
 * Dynamic origin validation function
 */
function originValidator(origin, callback) {
  // Allow requests with no origin (mobile apps, curl, Postman, server-to-server)
  if (!origin) {
    return callback(null, true);
  }

  if (allowedOrigins === '*') {
    return callback(null, true);
  }

  if (allowedOrigins.includes(origin)) {
    return callback(null, true);
  }

  logger.warn('CORS: Blocked request from unauthorized origin', { origin });
  return callback(new Error(`CORS: Origin '${origin}' is not allowed`));
}

/**
 * Express CORS middleware options
 */
const corsOptions = {
  origin: originValidator,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Requested-With',
    'X-Odoo-Push-Token',  // Custom header for Odoo push authentication
    'X-Bridge-Api-Key',
  ],
  exposedHeaders: ['X-Request-Id'],
  credentials: true,
  maxAge: 86400, // Cache preflight for 24h
  optionsSuccessStatus: 200,
};

/**
 * Socket.io CORS options (same policy, different format)
 */
const socketCorsOptions = {
  origin: allowedOrigins === '*' ? '*' : allowedOrigins,
  methods: ['GET', 'POST'],
  allowedHeaders: ['Authorization', 'X-Bridge-Api-Key'],
  credentials: true,
};

module.exports = {
  corsMiddleware: cors(corsOptions),
  socketCorsOptions,
  corsOptions,
};
