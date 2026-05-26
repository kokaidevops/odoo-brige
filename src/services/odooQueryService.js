// src/services/odooQueryService.js
/**
 * Odoo Direct Query Service
 * ─────────────────────────────────────────────────────────
 * BYPASS ORM: Executes raw SQL queries directly against
 * the Odoo 16 PostgreSQL database using a READ-ONLY pool.
 *
 * This is used when:
 *  - Datasets are too large for Odoo's JSON-RPC API
 *  - Dashboard aggregations need custom SQL (GROUP BY, CTEs)
 *  - Real-time performance is critical
 *
 * IMPORTANT: These queries are IDEMPOTENT read operations.
 *            Never write to the Odoo database from here.
 * ─────────────────────────────────────────────────────────
 */

const { odooQuery, odooQueryStream } = require('../config/database');
const logger = require('../utils/logger');

// ─────────────────────────────────────────────────────────
// SALES DASHBOARD QUERIES
// ─────────────────────────────────────────────────────────

/**
 * Get sales revenue aggregated by period
 * Replaces: Odoo sale.report model (slow for large datasets)
 */
async function getSalesRevenueByPeriod({ period = 'month', limit = 12, companyId = null } = {}) {
  const truncFn = {
    day:     "DATE_TRUNC('day', so.date_order)",
    week:    "DATE_TRUNC('week', so.date_order)",
    month:   "DATE_TRUNC('month', so.date_order)",
    quarter: "DATE_TRUNC('quarter', so.date_order)",
    year:    "DATE_TRUNC('year', so.date_order)",
  }[period] || "DATE_TRUNC('month', so.date_order)";

  const params = [];
  const companyFilter = companyId
    ? (() => { params.push(companyId); return `AND so.company_id = $${params.length}`; })()
    : '';

  params.push(limit);

  const sql = `
    SELECT
      ${truncFn}                        AS period_start,
      COUNT(so.id)                      AS order_count,
      SUM(so.amount_total)              AS revenue_total,
      SUM(so.amount_untaxed)            AS revenue_untaxed,
      AVG(so.amount_total)              AS avg_order_value,
      rc.name                           AS currency
    FROM sale_order so
    JOIN res_currency rc ON so.currency_id = rc.id
    WHERE so.state IN ('sale', 'done')
      ${companyFilter}
    GROUP BY period_start, rc.name
    ORDER BY period_start DESC
    LIMIT $${params.length}
  `;

  const result = await odooQuery(sql, params);
  return result.rows;
}

/**
 * Get top selling products with revenue
 */
async function getTopProducts({ limit = 10, dateFrom = null, dateTo = null } = {}) {
  const params = [];
  const dateFilters = [];

  if (dateFrom) {
    params.push(dateFrom);
    dateFilters.push(`so.date_order >= $${params.length}`);
  }
  if (dateTo) {
    params.push(dateTo);
    dateFilters.push(`so.date_order <= $${params.length}`);
  }

  const whereClause = dateFilters.length
    ? `AND ${dateFilters.join(' AND ')}`
    : '';

  params.push(limit);

  const sql = `
    SELECT
      pt.name                           AS product_name,
      pt.id                             AS product_id,
      pc.name                           AS category,
      SUM(sol.product_uom_qty)          AS qty_sold,
      SUM(sol.price_subtotal)           AS revenue,
      COUNT(DISTINCT so.id)             AS order_count
    FROM sale_order_line sol
    JOIN sale_order      so  ON sol.order_id    = so.id
    JOIN product_product pp  ON sol.product_id  = pp.id
    JOIN product_template pt ON pp.product_tmpl_id = pt.id
    LEFT JOIN product_category pc ON pt.categ_id = pc.id
    WHERE so.state IN ('sale', 'done')
      ${whereClause}
    GROUP BY pt.id, pt.name, pc.name
    ORDER BY revenue DESC
    LIMIT $${params.length}
  `;

  const result = await odooQuery(sql, params);
  return result.rows;
}

// ─────────────────────────────────────────────────────────
// INVENTORY / STOCK QUERIES
// ─────────────────────────────────────────────────────────

/**
 * Get current stock levels with low-stock alerts
 */
async function getStockLevels({ locationId = null, limit = 50 } = {}) {
  const params = [];
  const locationFilter = locationId
    ? (() => { params.push(locationId); return `AND sq.location_id = $${params.length}`; })()
    : `AND sl.usage = 'internal'`;

  params.push(limit);

  const sql = `
    SELECT
      pt.id                             AS product_id,
      pt.name                           AS product_name,
      pc.name                           AS category,
      SUM(sq.quantity)                  AS qty_on_hand,
      SUM(sq.reserved_quantity)         AS qty_reserved,
      SUM(sq.quantity - sq.reserved_quantity) AS qty_available,
      pt.reordering_min_qty             AS min_qty,
      pt.reordering_max_qty             AS max_qty,
      CASE
        WHEN SUM(sq.quantity - sq.reserved_quantity) <= COALESCE(pt.reordering_min_qty, 0)
        THEN TRUE ELSE FALSE
      END                               AS low_stock_alert,
      uom.name                          AS uom_name
    FROM stock_quant     sq
    JOIN stock_location  sl  ON sq.location_id   = sl.id
    JOIN product_product pp  ON sq.product_id    = pp.id
    JOIN product_template pt ON pp.product_tmpl_id = pt.id
    LEFT JOIN product_category pc  ON pt.categ_id    = pc.id
    LEFT JOIN uom_uom          uom ON pt.uom_id       = uom.id
    WHERE 1=1
      ${locationFilter}
    GROUP BY pt.id, pt.name, pc.name, pt.reordering_min_qty, pt.reordering_max_qty, uom.name
    HAVING SUM(sq.quantity) > 0
    ORDER BY qty_available ASC
    LIMIT $${params.length}
  `;

  const result = await odooQuery(sql, params);
  return result.rows;
}

// ─────────────────────────────────────────────────────────
// FINANCIAL / ACCOUNTING QUERIES
// ─────────────────────────────────────────────────────────

/**
 * Get accounts receivable aging summary
 */
async function getARAgingSummary({ companyId = null } = {}) {
  const params = [];
  const companyFilter = companyId
    ? (() => { params.push(companyId); return `AND am.company_id = $${params.length}`; })()
    : '';

  const sql = `
    SELECT
      rp.name                                   AS partner_name,
      rp.id                                     AS partner_id,
      SUM(aml.amount_residual)                  AS total_outstanding,
      SUM(CASE WHEN (CURRENT_DATE - am.invoice_date_due) BETWEEN 0  AND 30  THEN aml.amount_residual ELSE 0 END) AS due_0_30,
      SUM(CASE WHEN (CURRENT_DATE - am.invoice_date_due) BETWEEN 31 AND 60  THEN aml.amount_residual ELSE 0 END) AS due_31_60,
      SUM(CASE WHEN (CURRENT_DATE - am.invoice_date_due) BETWEEN 61 AND 90  THEN aml.amount_residual ELSE 0 END) AS due_61_90,
      SUM(CASE WHEN (CURRENT_DATE - am.invoice_date_due) > 90               THEN aml.amount_residual ELSE 0 END) AS due_over_90,
      COUNT(DISTINCT am.id)                     AS invoice_count
    FROM account_move_line aml
    JOIN account_move    am  ON aml.move_id     = am.id
    JOIN res_partner     rp  ON aml.partner_id  = rp.id
    JOIN account_account aa  ON aml.account_id  = aa.id
    WHERE am.move_type IN ('out_invoice', 'out_refund')
      AND am.state = 'posted'
      AND aml.amount_residual != 0
      AND aa.account_type = 'asset_receivable'
      ${companyFilter}
    GROUP BY rp.id, rp.name
    ORDER BY total_outstanding DESC
    LIMIT 50
  `;

  const result = await odooQuery(sql, params);
  return result.rows;
}

// ─────────────────────────────────────────────────────────
// KPI AGGREGATION (DASHBOARD SUMMARY)
// ─────────────────────────────────────────────────────────

/**
 * Get all KPIs in a single optimized query using CTEs
 * Replaces multiple Odoo API calls with one round-trip
 */
async function getDashboardKPIs({ companyId = null } = {}) {
  const params = [];
  const companyFilter = companyId
    ? (() => { params.push(companyId); return `AND company_id = $${params.length}`; })()
    : '';

  const sql = `
    WITH
    -- Sales KPIs
    sales_today AS (
      SELECT
        COUNT(id)          AS orders_today,
        COALESCE(SUM(amount_total), 0) AS revenue_today
      FROM sale_order
      WHERE state IN ('sale','done')
        AND DATE_TRUNC('day', date_order) = CURRENT_DATE
        ${companyFilter}
    ),
    sales_month AS (
      SELECT
        COUNT(id)          AS orders_month,
        COALESCE(SUM(amount_total), 0) AS revenue_month
      FROM sale_order
      WHERE state IN ('sale','done')
        AND DATE_TRUNC('month', date_order) = DATE_TRUNC('month', CURRENT_DATE)
        ${companyFilter}
    ),
    -- Invoice KPIs
    invoices_unpaid AS (
      SELECT
        COUNT(id)          AS unpaid_invoices,
        COALESCE(SUM(amount_residual), 0) AS total_ar
      FROM account_move
      WHERE move_type = 'out_invoice'
        AND state = 'posted'
        AND payment_state IN ('not_paid','partial')
        ${companyFilter}
    ),
    -- Stock KPIs
    stock_alerts AS (
      SELECT COUNT(DISTINCT pp.id) AS low_stock_products
      FROM stock_quant     sq
      JOIN stock_location  sl ON sq.location_id     = sl.id
      JOIN product_product pp ON sq.product_id      = pp.id
      JOIN product_template pt ON pp.product_tmpl_id = pt.id
      WHERE sl.usage = 'internal'
        AND sq.quantity - sq.reserved_quantity <= COALESCE(pt.reordering_min_qty, 0)
        AND sq.quantity > 0
    ),
    -- New customers this month
    new_customers AS (
      SELECT COUNT(id) AS new_customers_month
      FROM res_partner
      WHERE customer_rank > 0
        AND DATE_TRUNC('month', create_date) = DATE_TRUNC('month', CURRENT_DATE)
    )
    SELECT
      st.orders_today,
      st.revenue_today,
      sm.orders_month,
      sm.revenue_month,
      iu.unpaid_invoices,
      iu.total_ar,
      sa.low_stock_products,
      nc.new_customers_month,
      NOW() AS computed_at
    FROM sales_today st, sales_month sm, invoices_unpaid iu, stock_alerts sa, new_customers nc
  `;

  const result = await odooQuery(sql, params);
  return result.rows[0] || {};
}

// ─────────────────────────────────────────────────────────
// LARGE DATASET STREAMING (BYPASS ORM MEMORY LIMITS)
// ─────────────────────────────────────────────────────────

/**
 * Stream all sale order lines for a date range.
 * Uses PostgreSQL cursor-based streaming to handle millions of rows
 * without loading everything into Node.js memory.
 *
 * @param {Function} onBatch - called with (rows[], totalSoFar) per batch
 */
async function streamSaleOrderLines({ dateFrom, dateTo, onBatch, batchSize = 500 }) {
  const sql = `
    SELECT
      sol.id,
      so.name        AS order_ref,
      so.date_order,
      pt.name        AS product_name,
      sol.product_uom_qty AS qty,
      sol.price_unit,
      sol.price_subtotal,
      rp.name        AS customer,
      so.state
    FROM sale_order_line sol
    JOIN sale_order      so  ON sol.order_id     = so.id
    JOIN product_product pp  ON sol.product_id   = pp.id
    JOIN product_template pt ON pp.product_tmpl_id = pt.id
    JOIN res_partner     rp  ON so.partner_id    = rp.id
    WHERE so.state IN ('sale','done')
      AND so.date_order BETWEEN $1 AND $2
    ORDER BY so.date_order, sol.id
  `;

  const totalRows = await odooQueryStream(
    sql,
    [dateFrom, dateTo],
    onBatch,
    batchSize
  );

  return totalRows;
}

module.exports = {
  getSalesRevenueByPeriod,
  getTopProducts,
  getStockLevels,
  getARAgingSummary,
  getDashboardKPIs,
  streamSaleOrderLines,
};
