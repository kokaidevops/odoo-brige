// src/services/cacheService.js
/**
 * Cache Service
 * ─────────────────────────────────────────────────────────
 * Stores the latest payload per event type in PostgreSQL.
 * Provides fast retrieval for clients that connect after
 * data was pushed (they can request the last known state).
 *
 * Also maintains an in-process LRU-style memory cache to
 * avoid hitting the DB on every cache read.
 * ─────────────────────────────────────────────────────────
 */

const { bridgeQuery } = require('../config/database');
const logger = require('../utils/logger');

// In-memory cache layer: Map<cacheKey, { payload, cachedAt }>
const memoryCache = new Map();
const MAX_MEMORY_CACHE = 100;   // max distinct keys
const MEMORY_TTL_MS   = 30_000; // 30 seconds

/**
 * Store/update cached data for an event type
 *
 * @param {string} eventType
 * @param {object} payload
 * @param {number} ttlSeconds  - 0 means no expiry
 */
async function setCachedData(eventType, payload, ttlSeconds = 300) {
  const cacheKey = `event:${eventType}`;
  const expiresAt = ttlSeconds > 0
    ? new Date(Date.now() + ttlSeconds * 1000)
    : null;

  // Write to memory cache
  memoryCache.set(cacheKey, {
    payload,
    cachedAt: Date.now(),
  });

  // Evict oldest entries if over limit
  if (memoryCache.size > MAX_MEMORY_CACHE) {
    const oldestKey = memoryCache.keys().next().value;
    memoryCache.delete(oldestKey);
  }

  // Persist to PostgreSQL (upsert)
  try {
    await bridgeQuery(
      `INSERT INTO data_cache (cache_key, event_type, payload, cached_at, expires_at)
       VALUES ($1, $2, $3, NOW(), $4)
       ON CONFLICT (cache_key) DO UPDATE
         SET payload    = EXCLUDED.payload,
             cached_at  = EXCLUDED.cached_at,
             expires_at = EXCLUDED.expires_at,
             hit_count  = data_cache.hit_count`,
      [cacheKey, eventType, JSON.stringify(payload), expiresAt]
    );
  } catch (err) {
    logger.warn('Cache write to DB failed (memory cache still valid)', { error: err.message });
  }
}

/**
 * Retrieve cached data for an event type
 *
 * @param {string} eventType  - null to get all cached events
 * @returns {object|null}
 */
async function getCachedData(eventType = null) {
  if (eventType) {
    const cacheKey = `event:${eventType}`;

    // Check memory cache first
    const memEntry = memoryCache.get(cacheKey);
    if (memEntry && Date.now() - memEntry.cachedAt < MEMORY_TTL_MS) {
      logger.debug('Cache hit (memory)', { cacheKey });
      return { [eventType]: memEntry.payload };
    }

    // Fall back to DB
    try {
      const result = await bridgeQuery(
        `UPDATE data_cache
         SET hit_count = hit_count + 1
         WHERE cache_key = $1
           AND (expires_at IS NULL OR expires_at > NOW())
         RETURNING payload, cached_at`,
        [cacheKey]
      );

      if (result.rows.length === 0) return null;

      const { payload, cached_at } = result.rows[0];
      // Refresh memory cache
      memoryCache.set(cacheKey, { payload, cachedAt: Date.now() });

      logger.debug('Cache hit (DB)', { cacheKey });
      return { [eventType]: payload, cachedAt: cached_at };
    } catch (err) {
      logger.warn('Cache read from DB failed', { error: err.message });
      return null;
    }
  }

  // Return all cached event types
  try {
    const result = await bridgeQuery(
      `SELECT event_type, payload, cached_at
       FROM data_cache
       WHERE expires_at IS NULL OR expires_at > NOW()
       ORDER BY cached_at DESC`
    );

    return result.rows.reduce((acc, row) => {
      acc[row.event_type] = { data: row.payload, cachedAt: row.cached_at };
      return acc;
    }, {});
  } catch (err) {
    logger.warn('Failed to fetch all cached data', { error: err.message });
    return {};
  }
}

/**
 * Invalidate cache for a specific event type
 */
async function invalidateCache(eventType) {
  const cacheKey = `event:${eventType}`;
  memoryCache.delete(cacheKey);

  try {
    await bridgeQuery('DELETE FROM data_cache WHERE cache_key = $1', [cacheKey]);
    logger.debug('Cache invalidated', { cacheKey });
  } catch (err) {
    logger.warn('Cache invalidation DB error', { error: err.message });
  }
}

/**
 * Clean expired entries from DB (run periodically)
 */
async function cleanExpiredCache() {
  try {
    const result = await bridgeQuery(
      'DELETE FROM data_cache WHERE expires_at IS NOT NULL AND expires_at < NOW()'
    );
    if (result.rowCount > 0) {
      logger.info('Expired cache entries cleaned', { count: result.rowCount });
    }
  } catch (err) {
    logger.warn('Cache cleanup failed', { error: err.message });
  }
}

// Run cleanup every 5 minutes
setInterval(cleanExpiredCache, 5 * 60 * 1000);

module.exports = {
  setCachedData,
  getCachedData,
  invalidateCache,
  cleanExpiredCache,
};
