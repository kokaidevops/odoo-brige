// src/controllers/dashboardController.js
/**
 * Dashboard Controller
 * ─────────────────────────────────────────────────────────
 * REST endpoints for frontend clients to fetch dashboard data.
 * Combines cached push data + direct Odoo DB queries.
 * ─────────────────────────────────────────────────────────
 */

const odooQueryService = require('../services/odooQueryService');
const cacheService     = require('../services/cacheService');
const logger           = require('../utils/logger');

/**
 * GET /api/dashboard/kpi
 * Returns aggregated KPIs for the main dashboard
 */
async function getKPIs(req, res) {
  try {
    const { companyId } = req.query;

    // Try cache first
    const cached = await cacheService.getCachedData('dashboard.kpi');
    if (cached?.['dashboard.kpi']?.data) {
      return res.json({
        ok: true,
        source: 'cache',
        data: cached['dashboard.kpi'].data,
        cachedAt: cached['dashboard.kpi'].cachedAt,
      });
    }

    // Query directly from Odoo DB
    const kpis = await odooQueryService.getDashboardKPIs({
      companyId: companyId ? parseInt(companyId) : null,
    });

    // Cache for 2 minutes
    await cacheService.setCachedData('dashboard.kpi', kpis, 120);

    return res.json({
      ok: true,
      source: 'direct',
      data: kpis,
    });
  } catch (err) {
    logger.error('Dashboard KPI error', { error: err.message });
    return res.status(500).json({ ok: false, error: 'Failed to fetch KPIs' });
  }
}

/**
 * GET /api/dashboard/sales
 * Returns sales revenue chart data
 */
async function getSalesChart(req, res) {
  try {
    const {
      period    = 'month',
      limit     = '12',
      companyId,
    } = req.query;

    const validPeriods = ['day', 'week', 'month', 'quarter', 'year'];
    if (!validPeriods.includes(period)) {
      return res.status(400).json({ error: `period must be one of: ${validPeriods.join(', ')}` });
    }

    const rows = await odooQueryService.getSalesRevenueByPeriod({
      period,
      limit: Math.min(parseInt(limit) || 12, 60),
      companyId: companyId ? parseInt(companyId) : null,
    });

    return res.json({ ok: true, data: rows });
  } catch (err) {
    logger.error('Sales chart error', { error: err.message });
    return res.status(500).json({ ok: false, error: 'Failed to fetch sales data' });
  }
}

/**
 * GET /api/dashboard/products
 * Returns top selling products
 */
async function getTopProducts(req, res) {
  try {
    const { limit = '10', dateFrom, dateTo } = req.query;

    const rows = await odooQueryService.getTopProducts({
      limit: Math.min(parseInt(limit) || 10, 50),
      dateFrom: dateFrom || null,
      dateTo:   dateTo   || null,
    });

    return res.json({ ok: true, data: rows });
  } catch (err) {
    logger.error('Top products error', { error: err.message });
    return res.status(500).json({ ok: false, error: 'Failed to fetch products data' });
  }
}

/**
 * GET /api/dashboard/stock
 * Returns stock levels and alerts
 */
async function getStockLevels(req, res) {
  try {
    const { locationId, limit = '50' } = req.query;

    const rows = await odooQueryService.getStockLevels({
      locationId: locationId ? parseInt(locationId) : null,
      limit: Math.min(parseInt(limit) || 50, 200),
    });

    return res.json({ ok: true, data: rows });
  } catch (err) {
    logger.error('Stock levels error', { error: err.message });
    return res.status(500).json({ ok: false, error: 'Failed to fetch stock data' });
  }
}

/**
 * GET /api/dashboard/ar-aging
 * Returns accounts receivable aging summary
 */
async function getARAgingSummary(req, res) {
  try {
    const { companyId } = req.query;

    const rows = await odooQueryService.getARAgingSummary({
      companyId: companyId ? parseInt(companyId) : null,
    });

    return res.json({ ok: true, data: rows });
  } catch (err) {
    logger.error('AR aging error', { error: err.message });
    return res.status(500).json({ ok: false, error: 'Failed to fetch AR aging data' });
  }
}

/**
 * GET /api/dashboard/cache
 * Returns all currently cached event data (debug/admin endpoint)
 */
async function getCachedData(req, res) {
  try {
    const data = await cacheService.getCachedData();
    return res.json({ ok: true, data });
  } catch (err) {
    logger.error('Cache fetch error', { error: err.message });
    return res.status(500).json({ ok: false, error: 'Failed to fetch cache' });
  }
}

/**
 * GET /api/dashboard/stream/sales
 * Server-Sent Events: streams large sale order line dataset
 * Useful for export or detailed analytics without WebSocket
 */
async function streamSalesData(req, res) {
  const { dateFrom, dateTo } = req.query;

  if (!dateFrom || !dateTo) {
    return res.status(400).json({ error: 'dateFrom and dateTo are required' });
  }

  // Set up SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
  res.flushHeaders();

  let totalRows = 0;

  try {
    await odooQueryService.streamSaleOrderLines({
      dateFrom,
      dateTo,
      batchSize: 200,
      onBatch: async (rows, runningTotal) => {
        totalRows = runningTotal;
        const event = `data: ${JSON.stringify({ rows, runningTotal })}\n\n`;
        res.write(event);
      },
    });

    res.write(`event: complete\ndata: ${JSON.stringify({ totalRows })}\n\n`);
    res.end();

    logger.info('SSE stream completed', { dateFrom, dateTo, totalRows });
  } catch (err) {
    logger.error('SSE stream error', { error: err.message });
    res.write(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  }
}

module.exports = {
  getKPIs,
  getSalesChart,
  getTopProducts,
  getStockLevels,
  getARAgingSummary,
  getCachedData,
  streamSalesData,
};
