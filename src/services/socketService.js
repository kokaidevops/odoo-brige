// src/services/socketService.js
/**
 * Socket.io Service
 * ─────────────────────────────────────────────────────────
 * Manages:
 * - Client connections and room subscriptions
 * - Broadcasting events to subscribed clients
 * - Connection health monitoring
 * ─────────────────────────────────────────────────────────
 */

const logger = require('../utils/logger');

// In-memory registry of connected sockets and their subscriptions
// Structure: Map<socketId, { socket, subscriptions: Set<string>, user, connectedAt }>
const connectedClients = new Map();

let _io = null;

/**
 * Initialize the socket service with an io instance
 */
function init(io) {
  _io = io;

  io.on('connection', (socket) => {
    handleConnection(socket);
  });

  logger.info('Socket.io service initialized');
}

/**
 * Handle a new socket connection
 */
function handleConnection(socket) {
  const clientInfo = {
    socket,
    subscriptions: new Set(),
    user: socket.user || { id: 'anonymous' },
    connectedAt: new Date(),
    ip: socket.handshake.address,
  };

  connectedClients.set(socket.id, clientInfo);

  logger.info('Client connected', {
    socketId: socket.id,
    userId: clientInfo.user.id,
    ip: clientInfo.ip,
    totalClients: connectedClients.size,
  });

  // Send initial connection acknowledgement
  socket.emit('bridge:connected', {
    socketId: socket.id,
    serverTime: new Date().toISOString(),
    availableEvents: getAvailableEventTypes(),
  });

  // ── Subscribe to event channels ──────────────────────────
  socket.on('subscribe', (channels, ack) => {
    if (!Array.isArray(channels)) channels = [channels];

    const joined = [];
    for (const channel of channels) {
      if (typeof channel !== 'string') continue;
      const room = sanitizeChannelName(channel);
      socket.join(room);
      clientInfo.subscriptions.add(room);
      joined.push(room);
    }

    logger.debug('Client subscribed', { socketId: socket.id, channels: joined });

    if (typeof ack === 'function') {
      ack({ ok: true, subscribed: joined });
    }
  });

  // ── Unsubscribe from channels ────────────────────────────
  socket.on('unsubscribe', (channels, ack) => {
    if (!Array.isArray(channels)) channels = [channels];

    for (const channel of channels) {
      const room = sanitizeChannelName(channel);
      socket.leave(room);
      clientInfo.subscriptions.delete(room);
    }

    if (typeof ack === 'function') {
      ack({ ok: true });
    }
  });

  // ── Ping/pong health check ───────────────────────────────
  socket.on('ping', (ack) => {
    if (typeof ack === 'function') {
      ack({ pong: true, serverTime: new Date().toISOString() });
    }
  });

  // ── Request last cached data ─────────────────────────────
  socket.on('request:latest', async ({ eventType } = {}, ack) => {
    try {
      const { getCachedData } = require('./cacheService');
      const data = await getCachedData(eventType);
      if (typeof ack === 'function') {
        ack({ ok: true, data });
      }
    } catch (err) {
      logger.error('Error fetching cached data on request', { error: err.message });
      if (typeof ack === 'function') {
        ack({ ok: false, error: 'Failed to fetch data' });
      }
    }
  });

  // ── Disconnect ───────────────────────────────────────────
  socket.on('disconnect', (reason) => {
    connectedClients.delete(socket.id);
    logger.info('Client disconnected', {
      socketId: socket.id,
      reason,
      totalClients: connectedClients.size,
    });
  });

  // ── Error handling ───────────────────────────────────────
  socket.on('error', (err) => {
    logger.error('Socket error', { socketId: socket.id, error: err.message });
  });
}

/**
 * Broadcast an event to all clients subscribed to a channel
 *
 * @param {string} eventType   - Event type (e.g., 'sale.order', 'dashboard.kpi')
 * @param {object} payload     - Data payload
 * @param {object} options     - { room?: string, broadcast?: boolean }
 */
function broadcast(eventType, payload, options = {}) {
  if (!_io) {
    logger.error('Socket.io not initialized — cannot broadcast');
    return;
  }

  const room    = options.room || eventType;
  const emitTo  = options.room ? _io.to(room) : _io;

  const envelope = {
    eventType,
    payload,
    serverTime: new Date().toISOString(),
  };

  // Emit to all clients in the room
  emitTo.emit(`data:${eventType}`, envelope);

  // Always emit to the wildcard "all" channel
  _io.to('all').emit(`data:${eventType}`, envelope);

  const roomSize = _io.sockets.adapter.rooms.get(room)?.size || 0;
  logger.debug('Broadcast sent', {
    eventType,
    room,
    recipientsInRoom: roomSize,
  });
}

/**
 * Broadcast a dashboard-wide refresh signal
 * Used when Odoo pushes bulk data changes
 */
function broadcastRefresh(reason = 'data_update') {
  if (!_io) return;

  _io.emit('bridge:refresh', {
    reason,
    serverTime: new Date().toISOString(),
  });

  logger.debug('Broadcast refresh signal sent', { reason });
}

/**
 * Get stats about current connections
 */
function getConnectionStats() {
  return {
    totalConnected: connectedClients.size,
    clients: Array.from(connectedClients.values()).map((c) => ({
      socketId: c.socket.id,
      userId: c.user.id,
      subscriptions: Array.from(c.subscriptions),
      connectedAt: c.connectedAt,
      ip: c.ip,
    })),
  };
}

/**
 * Sanitize channel name to prevent room injection
 */
function sanitizeChannelName(name) {
  return name.replace(/[^a-zA-Z0-9._\-:]/g, '').slice(0, 100);
}

/**
 * Available event types clients can subscribe to
 */
function getAvailableEventTypes() {
  return [
    'all',               // All events
    'sale.order',        // Sales orders
    'account.move',      // Invoices / Accounting
    'stock.move',        // Inventory movements
    'mrp.production',    // Manufacturing orders
    'dashboard.kpi',     // Aggregated KPI updates
    'dashboard.chart',   // Chart data updates
    'hr.attendance',     // HR attendance
    'purchase.order',    // Purchase orders
  ];
}

module.exports = {
  init,
  broadcast,
  broadcastRefresh,
  getConnectionStats,
  getAvailableEventTypes,
};
