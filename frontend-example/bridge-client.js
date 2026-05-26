// frontend-example/bridge-client.js
/**
 * Bridge Client — Frontend Integration Example
 * ─────────────────────────────────────────────────────────
 * Shows how a frontend dashboard connects to the bridge.
 * Compatible with any JS framework (React, Vue, vanilla).
 *
 * Install: npm install socket.io-client
 * ─────────────────────────────────────────────────────────
 */

import { io } from 'socket.io-client';

const BRIDGE_URL = import.meta.env.VITE_BRIDGE_URL || 'http://localhost:3000';

class BridgeClient {
  constructor() {
    this.socket     = null;
    this.token      = null;
    this.listeners  = new Map();
    this.isConnected = false;
  }

  /**
   * Step 1: Authenticate and get JWT token
   */
  async authenticate(clientId, clientSecret) {
    const res = await fetch(`${BRIDGE_URL}/api/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, clientSecret }),
    });

    if (!res.ok) throw new Error('Authentication failed');
    const { token } = await res.json();
    this.token = token;
    return token;
  }

  /**
   * Step 2: Connect to Socket.io
   */
  connect() {
    this.socket = io(BRIDGE_URL, {
      auth: { token: this.token },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 30000,
    });

    this.socket.on('connect', () => {
      this.isConnected = true;
      console.log('Bridge connected:', this.socket.id);

      // Re-subscribe to all channels on reconnect
      if (this._subscriptions?.length) {
        this.subscribe(this._subscriptions);
      }
    });

    this.socket.on('disconnect', (reason) => {
      this.isConnected = false;
      console.log('Bridge disconnected:', reason);
    });

    this.socket.on('bridge:refresh', ({ reason }) => {
      console.log('Bridge refresh signal:', reason);
      this.emit('refresh', { reason });
    });

    this.socket.on('connect_error', (err) => {
      console.error('Bridge connection error:', err.message);
    });

    return this;
  }

  /**
   * Step 3: Subscribe to event channels
   */
  subscribe(channels) {
    if (!Array.isArray(channels)) channels = [channels];
    this._subscriptions = [...new Set([...(this._subscriptions || []), ...channels])];

    if (!this.isConnected) return this;

    this.socket.emit('subscribe', channels, ({ ok, subscribed }) => {
      if (ok) {
        console.log('Subscribed to:', subscribed);

        // Attach data listeners for each channel
        for (const channel of subscribed) {
          this.socket.on(`data:${channel}`, (envelope) => {
            this.emit(channel, envelope);
          });
        }
      }
    });

    return this;
  }

  /**
   * Register a handler for a channel's data events
   */
  on(channel, handler) {
    if (!this.listeners.has(channel)) {
      this.listeners.set(channel, new Set());
    }
    this.listeners.get(channel).add(handler);
    return () => this.off(channel, handler); // Returns unsubscribe function
  }

  off(channel, handler) {
    this.listeners.get(channel)?.delete(handler);
  }

  emit(channel, data) {
    this.listeners.get(channel)?.forEach((handler) => {
      try { handler(data); } catch (e) { console.error('Handler error:', e); }
    });
  }

  /**
   * Request latest cached data for an event type
   */
  requestLatest(eventType) {
    return new Promise((resolve, reject) => {
      this.socket.emit('request:latest', { eventType }, ({ ok, data, error }) => {
        if (ok) resolve(data);
        else reject(new Error(error));
      });
    });
  }

  disconnect() {
    this.socket?.disconnect();
  }
}

// ── Usage Example ─────────────────────────────────────────

const bridge = new BridgeClient();

async function initDashboard() {
  // Authenticate
  await bridge.authenticate('dashboard-app', 'your-client-secret');

  // Connect and subscribe
  bridge
    .connect()
    .subscribe(['all', 'dashboard.kpi', 'sale.order', 'stock.alert']);

  // Listen for KPI updates
  bridge.on('dashboard.kpi', ({ payload }) => {
    console.log('New KPI data:', payload);
    updateKPICards(payload);
  });

  // Listen for sales order updates
  bridge.on('sale.order', ({ payload }) => {
    console.log('Sale order update:', payload._bridge.recordIds);
    refreshSalesChart(payload.orders);
  });

  // Listen for stock alerts
  bridge.on('stock.alert', ({ payload }) => {
    console.log('Stock alert:', payload.count, 'products');
    showStockAlerts(payload.alerts);
  });

  // Listen for bridge-wide refresh signal
  bridge.on('refresh', ({ reason }) => {
    console.log('Dashboard refresh requested:', reason);
    window.location.reload();
  });

  // Fetch initial data from REST (before any push arrives)
  const kpiRes  = await fetch(`${BRIDGE_URL}/api/dashboard/kpi`);
  const kpiData = await kpiRes.json();
  updateKPICards(kpiData.data);
}

// Placeholder UI update functions
function updateKPICards(data) { /* update your chart library */ }
function refreshSalesChart(orders) { /* update chart */ }
function showStockAlerts(alerts) { /* show notifications */ }

export { BridgeClient, bridge };
