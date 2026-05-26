// src/controllers/pushController.js
/**
 * Push Controller
 * ─────────────────────────────────────────────────────────
 * Handles incoming POST requests from Odoo 16 that push
 * data updates to this bridge.
 *
 * Odoo sends data via HTTP POST (configured via ir.cron or
 * a custom module using requests/urllib in Python).
 * ─────────────────────────────────────────────────────────
 */

const { v4: uuidv4 } = require('uuid');
const socketService  = require('../services/socketService');
const cacheService   = require('../services/cacheService');
const { bridgeQuery } = require('../config/database');
const logger         = require('../utils/logger');

/**
 * POST /api/push
 *
 * Odoo pushes an event payload. The bridge:
 *  1. Validates the payload structure
 *  2. Logs the push to push_log table
 *  3. Caches the latest data
 *  4. Broadcasts to subscribed frontend clients
 */
async function handlePush(req, res) {
  const requestId = uuidv4();
  const clientIp  = req.ip || req.socket?.remoteAddress;

  // Acknowledge immediately to Odoo (prevent timeout)
  res.status(202).json({
    ok: true,
    requestId,
    received: new Date().toISOString(),
  });

  // Process asynchronously after responding
  processPushPayload(req.body, requestId, clientIp).catch((err) => {
    logger.error('Push processing error (async)', {
      requestId,
      error: err.message,
    });
  });
}

/**
 * POST /api/push/bulk
 *
 * Handle bulk push — Odoo sends multiple event types at once.
 * Useful for initial dashboard load or batch sync.
 */
async function handleBulkPush(req, res) {
  const requestId = uuidv4();
  const clientIp  = req.ip || req.socket?.remoteAddress;

  const { events } = req.body;

  if (!Array.isArray(events) || events.length === 0) {
    return res.status(400).json({ error: 'events array is required' });
  }

  if (events.length > 50) {
    return res.status(400).json({ error: 'Maximum 50 events per bulk push' });
  }

  // Acknowledge immediately
  res.status(202).json({
    ok: true,
    requestId,
    eventCount: events.length,
    received: new Date().toISOString(),
  });

  // Process each event in parallel (non-blocking)
  Promise.allSettled(
    events.map((event) => processPushPayload(event, `${requestId}-${uuidv4()}`, clientIp))
  ).then((results) => {
    const failed = results.filter((r) => r.status === 'rejected');
    if (failed.length > 0) {
      logger.warn('Bulk push: some events failed', {
        total: events.length,
        failed: failed.length,
      });
    }
  });
}

/**
 * GET /api/push/status
 *
 * Health check endpoint for Odoo to verify bridge is alive
 */
async function getStatus(req, res) {
  try {
    const result = await bridgeQuery(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'processed' THEN 1 ELSE 0 END) AS processed,
              SUM(CASE WHEN status = 'failed'    THEN 1 ELSE 0 END) AS failed
       FROM push_log
       WHERE received_at > NOW() - INTERVAL '1 hour'`
    );

    const stats = result.rows[0];
    const { getConnectionStats } = require('../services/socketService');
    const socketStats = getConnectionStats();

    return res.json({
      ok: true,
      bridge: 'online',
      serverTime: new Date().toISOString(),
      lastHour: {
        totalPushes:     parseInt(stats.total || 0),
        processedPushes: parseInt(stats.processed || 0),
        failedPushes:    parseInt(stats.failed || 0),
      },
      connectedClients: socketStats.totalConnected,
    });
  } catch (err) {
    logger.error('Status check error', { error: err.message });
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
}

// ─────────────────────────────────────────────────────────
// INTERNAL HELPERS
// ─────────────────────────────────────────────────────────

/**
 * Validate push payload structure
 */
function validatePayload(body) {
  const errors = [];

  if (!body || typeof body !== 'object') {
    errors.push('Body must be a JSON object');
    return errors;
  }

  if (!body.eventType || typeof body.eventType !== 'string') {
    errors.push('eventType (string) is required');
  }

  if (body.eventType && body.eventType.length > 100) {
    errors.push('eventType must be <= 100 characters');
  }

  if (!body.data) {
    errors.push('data field is required');
  }

  return errors;
}

/**
 * Core push processing logic
 */
async function processPushPayload(body, requestId, clientIp) {
  // Validate
  const errors = validatePayload(body);
  if (errors.length > 0) {
    logger.warn('Push payload validation failed', { requestId, errors });
    await logPushEvent({
      eventType: body?.eventType || 'unknown',
      sourceModel: body?.sourceModel,
      recordIds: body?.recordIds,
      payloadSize: JSON.stringify(body).length,
      status: 'failed',
      errorMessage: errors.join('; '),
      clientIp,
    });
    return;
  }

  const {
    eventType,
    data,
    sourceModel,
    recordIds,
    meta = {},
  } = body;

  const payloadSize = JSON.stringify(data).length;

  // Log the push event
  const logId = await logPushEvent({
    eventType,
    sourceModel,
    recordIds,
    payloadSize,
    status: 'received',
    clientIp,
  });

  try {
    // Enrich payload with bridge metadata
    const enrichedPayload = {
      ...data,
      _bridge: {
        eventType,
        sourceModel,
        recordIds,
        requestId,
        pushedAt: new Date().toISOString(),
        meta,
      },
    };

    // Cache the latest data
    const cacheTtl = meta.cacheTtl || 300; // default 5 min
    await cacheService.setCachedData(eventType, enrichedPayload, cacheTtl);

    // Broadcast to subscribed frontend clients
    socketService.broadcast(eventType, enrichedPayload, { room: eventType });

    // Update log status to processed
    await bridgeQuery(
      'UPDATE push_log SET status = $1, processed_at = NOW() WHERE id = $2',
      ['processed', logId]
    );

    logger.info('Push processed and broadcast', {
      requestId,
      eventType,
      payloadSize,
      sourceModel,
      recordCount: Array.isArray(recordIds) ? recordIds.length : null,
    });
  } catch (err) {
    await bridgeQuery(
      'UPDATE push_log SET status = $1, error_message = $2 WHERE id = $3',
      ['failed', err.message, logId]
    );
    throw err;
  }
}

/**
 * Insert a row into push_log and return its ID
 */
async function logPushEvent({ eventType, sourceModel, recordIds, payloadSize, status, errorMessage, clientIp }) {
  try {
    const result = await bridgeQuery(
      `INSERT INTO push_log
         (event_type, source_model, record_ids, payload_size, status, error_message, client_ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7::inet)
       RETURNING id`,
      [eventType, sourceModel, recordIds, payloadSize, status, errorMessage, clientIp]
    );
    return result.rows[0]?.id;
  } catch (err) {
    logger.warn('Failed to write push log', { error: err.message });
    return null;
  }
}

module.exports = {
  handlePush,
  handleBulkPush,
  getStatus,
};
