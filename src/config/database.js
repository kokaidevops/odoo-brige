// src/config/database.js
const { Pool } = require('pg');
const logger = require('../utils/logger');

// ─────────────────────────────────────────────────────────────
// BRIDGE LOCAL DATABASE POOL
// Used for: caching aggregated data, audit logs, push history
// ─────────────────────────────────────────────────────────────
const bridgePool = new Pool({
  host: process.env.PG_HOST || 'localhost',
  port: parseInt(process.env.PG_PORT || '5432'),
  database: process.env.PG_DATABASE || 'odoo_bridge',
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
  max: parseInt(process.env.PG_POOL_MAX || '20'),
  idleTimeoutMillis: parseInt(process.env.PG_POOL_IDLE_TIMEOUT || '30000'),
  connectionTimeoutMillis: parseInt(process.env.PG_POOL_CONNECTION_TIMEOUT || '5000'),
  ssl: process.env.PG_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

bridgePool.on('connect', () => {
  logger.debug('Bridge DB: New client connected to pool');
});

bridgePool.on('error', (err) => {
  logger.error('Bridge DB: Unexpected pool error', { error: err.message });
});

// ─────────────────────────────────────────────────────────────
// ODOO 16 DIRECT DATABASE POOL
// BYPASS ORM: Raw SQL queries for high-volume data reads.
// Use READ-ONLY credentials — NEVER write to Odoo DB directly.
// ─────────────────────────────────────────────────────────────
const odooPool = new Pool({
  host: process.env.ODOO_PG_HOST || 'localhost',
  port: parseInt(process.env.ODOO_PG_PORT || '5432'),
  database: process.env.ODOO_PG_DATABASE,
  user: process.env.ODOO_PG_USER,
  password: process.env.ODOO_PG_PASSWORD,
  max: parseInt(process.env.ODOO_PG_POOL_MAX || '10'),
  idleTimeoutMillis: parseInt(process.env.ODOO_PG_POOL_IDLE_TIMEOUT || '30000'),
  connectionTimeoutMillis: 5000,
  ssl: process.env.ODOO_PG_SSL === 'true' ? { rejectUnauthorized: false } : false,
  // Enforce read-only at connection level
  options: '-c default_transaction_read_only=on',
});

odooPool.on('connect', (client) => {
  // Extra safety: enforce read-only at session level
  client.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY').catch(() => {});
  logger.debug('Odoo DB: New read-only client connected to pool');
});

odooPool.on('error', (err) => {
  logger.error('Odoo DB: Unexpected pool error', { error: err.message });
});

/**
 * Verify both database connections on startup
 */
async function connectDatabases() {
  // Test bridge DB
  try {
    const client = await bridgePool.connect();
    const result = await client.query('SELECT NOW() as now, current_database() as db');
    logger.info('Bridge DB connected', {
      database: result.rows[0].db,
      time: result.rows[0].now,
    });
    client.release();
  } catch (err) {
    logger.error('Bridge DB connection failed', { error: err.message });
    throw err;
  }

  // Test Odoo DB
  try {
    const client = await odooPool.connect();
    const result = await client.query('SELECT NOW() as now, current_database() as db');
    logger.info('Odoo DB (direct) connected', {
      database: result.rows[0].db,
      time: result.rows[0].now,
    });
    client.release();
  } catch (err) {
    // Non-fatal: Odoo DB might not always be needed
    logger.warn('Odoo DB (direct) connection failed — direct queries unavailable', {
      error: err.message,
    });
  }
}

/**
 * Helper: execute a query on bridge DB with automatic client release
 */
async function bridgeQuery(text, params = []) {
  const start = Date.now();
  try {
    const result = await bridgePool.query(text, params);
    const duration = Date.now() - start;
    logger.debug('Bridge DB query executed', { duration_ms: duration, rows: result.rowCount });
    return result;
  } catch (err) {
    logger.error('Bridge DB query error', { error: err.message, query: text });
    throw err;
  }
}

/**
 * Helper: execute a query on Odoo DB with automatic client release
 * All queries are read-only by pool config.
 */
async function odooQuery(text, params = []) {
  const start = Date.now();
  try {
    const result = await odooPool.query(text, params);
    const duration = Date.now() - start;
    logger.debug('Odoo DB query executed', { duration_ms: duration, rows: result.rowCount });
    return result;
  } catch (err) {
    logger.error('Odoo DB query error', { error: err.message, query: text });
    throw err;
  }
}

/**
 * Helper: run streaming cursor for very large datasets (bypass memory limits)
 * Uses pg-cursor pattern via callbacks
 */
async function odooQueryStream(text, params = [], onBatch, batchSize = 500) {
  const client = await odooPool.connect();
  try {
    // Use PostgreSQL cursors for large result sets
    await client.query('BEGIN');
    await client.query(`DECLARE bridge_cursor CURSOR FOR ${text}`, params);

    let totalRows = 0;
    while (true) {
      const result = await client.query(`FETCH ${batchSize} FROM bridge_cursor`);
      if (result.rows.length === 0) break;
      totalRows += result.rows.length;
      await onBatch(result.rows, totalRows);
    }

    await client.query('CLOSE bridge_cursor');
    await client.query('COMMIT');
    logger.info('Odoo DB stream query completed', { total_rows: totalRows });
    return totalRows;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Odoo DB stream query error', { error: err.message });
    throw err;
  } finally {
    client.release();
  }
}

async function closeDatabases() {
  await Promise.allSettled([bridgePool.end(), odooPool.end()]);
  logger.info('Database pools closed');
}

module.exports = {
  bridgePool,
  odooPool,
  connectDatabases,
  closeDatabases,
  bridgeQuery,
  odooQuery,
  odooQueryStream,
};
