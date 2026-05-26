// src/config/migrate.js
require('dotenv').config();
const { bridgePool } = require('./database');
const logger = require('../utils/logger');

const migrations = [
  {
    name: '001_create_push_log',
    sql: `
      CREATE TABLE IF NOT EXISTS push_log (
        id            BIGSERIAL PRIMARY KEY,
        event_type    VARCHAR(100)  NOT NULL,
        source_model  VARCHAR(200),
        record_ids    INTEGER[],
        payload_size  INTEGER,
        received_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        processed_at  TIMESTAMPTZ,
        status        VARCHAR(20)   NOT NULL DEFAULT 'received',
        error_message TEXT,
        client_ip     INET,
        CONSTRAINT chk_status CHECK (status IN ('received','processed','failed','ignored'))
      );
      CREATE INDEX IF NOT EXISTS idx_push_log_event_type   ON push_log (event_type);
      CREATE INDEX IF NOT EXISTS idx_push_log_received_at  ON push_log (received_at DESC);
      CREATE INDEX IF NOT EXISTS idx_push_log_status       ON push_log (status);
    `,
  },
  {
    name: '002_create_data_cache',
    sql: `
      CREATE TABLE IF NOT EXISTS data_cache (
        cache_key     VARCHAR(255) PRIMARY KEY,
        event_type    VARCHAR(100) NOT NULL,
        payload       JSONB        NOT NULL,
        cached_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        expires_at    TIMESTAMPTZ,
        hit_count     INTEGER      NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_data_cache_event_type ON data_cache (event_type);
      CREATE INDEX IF NOT EXISTS idx_data_cache_expires_at ON data_cache (expires_at);
    `,
  },
  {
    name: '003_create_connected_clients',
    sql: `
      CREATE TABLE IF NOT EXISTS connected_clients (
        socket_id     VARCHAR(100) PRIMARY KEY,
        client_ip     INET,
        subscriptions TEXT[],
        connected_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        last_ping_at  TIMESTAMPTZ
      );
    `,
  },
  {
    name: '004_create_migrations_table',
    sql: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name         VARCHAR(255) PRIMARY KEY,
        applied_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      );
    `,
  },
];

async function runMigrations() {
  const client = await bridgePool.connect();
  try {
    // Create migrations table first
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )
    `);

    for (const migration of migrations) {
      const exists = await client.query(
        'SELECT 1 FROM schema_migrations WHERE name = $1',
        [migration.name]
      );

      if (exists.rowCount === 0) {
        logger.info(`Applying migration: ${migration.name}`);
        await client.query(migration.sql);
        await client.query(
          'INSERT INTO schema_migrations (name) VALUES ($1)',
          [migration.name]
        );
        logger.info(`Migration applied: ${migration.name}`);
      } else {
        logger.debug(`Migration already applied: ${migration.name}`);
      }
    }
    logger.info('All migrations complete');
  } catch (err) {
    logger.error('Migration failed', { error: err.message });
    throw err;
  } finally {
    client.release();
    await bridgePool.end();
  }
}

runMigrations().catch((err) => {
  console.error('Migration error:', err);
  process.exit(1);
});
