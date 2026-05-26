// src/server.js
/**
 * Odoo Real-time Bridge — Main Server
 * ─────────────────────────────────────────────────────────
 * Tech Stack:
 *   - Node.js + Express (HTTP)
 *   - Socket.io (WebSocket real-time broadcast)
 *   - PostgreSQL (bridge cache + Odoo direct queries)
 *
 * Architecture:
 *   Odoo 16 ──HTTP POST──► Bridge ──Socket.io──► Frontend
 *                           │
 *                           └──Raw SQL──► Odoo PostgreSQL
 * ─────────────────────────────────────────────────────────
 */

require('dotenv').config();

const http    = require('http');
const express = require('express');
const { Server: SocketIO } = require('socket.io');
const helmet  = require('helmet');
const morgan  = require('morgan');

const logger         = require('./utils/logger');
const { corsMiddleware, socketCorsOptions } = require('./middleware/cors');
const { validateSocketAuth, captureRawBody } = require('./middleware/auth');
const { connectDatabases, closeDatabases } = require('./config/database');
const socketService  = require('./services/socketService');
const routes         = require('./routes');

const PORT = parseInt(process.env.PORT || '3000', 10);

async function bootstrap() {
  // ── Express App Setup ──────────────────────────────────
  const app = express();

  // Security headers
  app.use(helmet({
    crossOriginEmbedderPolicy: false, // Needed for Socket.io
    contentSecurityPolicy: false,     // Configure separately if serving HTML
  }));

  // CORS — must be before route handlers
  app.use(corsMiddleware);

  // Handle preflight for all routes
  app.options('*', corsMiddleware);

  // Trust proxy (needed for correct IP detection behind nginx/load balancer)
  app.set('trust proxy', 1);

  // HTTP request logging
  app.use(morgan('combined', {
    stream: { write: (msg) => logger.http(msg.trim()) },
    skip: (req) => req.url === '/api/health', // Don't log health checks
  }));

  // Body parsing — capture raw body for HMAC verification
  app.use(
    express.json({
      limit: '10mb',
      verify: captureRawBody,
    })
  );
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  // API routes
  app.use('/api', routes);

  // 404 handler
  app.use((req, res) => {
    res.status(404).json({ error: `Route ${req.method} ${req.path} not found` });
  });

  // Global error handler
  app.use((err, req, res, _next) => {
    // CORS errors
    if (err.message && err.message.startsWith('CORS:')) {
      logger.warn('CORS error', { message: err.message, origin: req.headers.origin });
      return res.status(403).json({ error: err.message });
    }

    logger.error('Unhandled request error', {
      error: err.message,
      stack: err.stack,
      path: req.path,
    });

    return res.status(err.status || 500).json({
      error: process.env.NODE_ENV === 'production'
        ? 'Internal server error'
        : err.message,
    });
  });

  // ── HTTP Server ────────────────────────────────────────
  const server = http.createServer(app);

  // ── Socket.io Setup ────────────────────────────────────
  const io = new SocketIO(server, {
    cors: socketCorsOptions,

    // Tune for high-throughput dashboard scenarios
    pingTimeout:  20000,
    pingInterval: 10000,

    // Allow both websocket and polling (polling fallback for proxies)
    transports: ['websocket', 'polling'],

    // Limit payload size
    maxHttpBufferSize: 5 * 1024 * 1024, // 5MB

    // Connection state recovery (re-sends missed events on reconnect)
    connectionStateRecovery: {
      maxDisconnectionDuration: 2 * 60 * 1000, // 2 minutes
      skipMiddlewares: false,
    },

    // Path (useful when mounting behind a reverse proxy sub-path)
    path: process.env.SOCKET_PATH || '/socket.io',
  });

  // Attach JWT auth middleware to Socket.io
  io.use(validateSocketAuth);

  // Initialize socket service with io instance
  socketService.init(io);

  // ── Database Connection ────────────────────────────────
  await connectDatabases();

  // ── Start Listening ────────────────────────────────────
  await new Promise((resolve) => server.listen(PORT, resolve));

  logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  logger.info('  Odoo Real-time Bridge is running');
  logger.info(`  PORT:        ${PORT}`);
  logger.info(`  ENV:         ${process.env.NODE_ENV || 'development'}`);
  logger.info(`  REST API:    http://localhost:${PORT}/api`);
  logger.info(`  Socket.io:   ws://localhost:${PORT}/socket.io`);
  logger.info(`  Push endpoint: POST /api/push`);
  logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  return { app, server, io };
}

// ── Graceful Shutdown ──────────────────────────────────────
async function shutdown(signal) {
  logger.info(`Received ${signal}. Starting graceful shutdown...`);

  try {
    await closeDatabases();
    logger.info('Shutdown complete');
    process.exit(0);
  } catch (err) {
    logger.error('Error during shutdown', { error: err.message });
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Promise Rejection', { reason });
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception — forcing shutdown', { error: err.message, stack: err.stack });
  process.exit(1);
});

// ── Start ──────────────────────────────────────────────────
bootstrap().catch((err) => {
  logger.error('Failed to start server', { error: err.message, stack: err.stack });
  process.exit(1);
});
