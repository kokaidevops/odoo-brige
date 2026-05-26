// src/controllers/authController.js
/**
 * Auth Controller
 * ─────────────────────────────────────────────────────────
 * Issues JWT tokens for frontend clients.
 * In production, this should integrate with your identity
 * provider (LDAP, Odoo session, SSO, etc.)
 * ─────────────────────────────────────────────────────────
 */

const { generateToken } = require('../middleware/auth');
const logger = require('../utils/logger');

/**
 * POST /api/auth/token
 *
 * Body: { clientId: string, clientSecret: string }
 *
 * In production, validate against a real credential store.
 * Here we validate against env variables for simplicity.
 */
async function issueToken(req, res) {
  const { clientId, clientSecret } = req.body;

  if (!clientId || !clientSecret) {
    return res.status(400).json({ error: 'clientId and clientSecret are required' });
  }

  // ── Simple validation against env (replace with DB lookup in production) ──
  const validClients = parseValidClients();
  const client = validClients.find(
    (c) => c.id === clientId && c.secret === clientSecret
  );

  if (!client) {
    logger.warn('Auth: Invalid client credentials', { clientId, ip: req.ip });
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = generateToken({
    id:   clientId,
    role: client.role || 'viewer',
  });

  logger.info('Auth: Token issued', { clientId, role: client.role });

  return res.json({
    ok: true,
    token,
    expiresIn: process.env.JWT_EXPIRES_IN || '24h',
  });
}

/**
 * GET /api/auth/verify
 * Verify a JWT token is still valid (useful for frontend session checks)
 */
function verifyToken(req, res) {
  // req.user is populated by validateJWT middleware
  return res.json({
    ok: true,
    user: req.user,
    serverTime: new Date().toISOString(),
  });
}

/**
 * Parse valid clients from env variable
 * Format: CLIENT_CREDENTIALS=id1:secret1:role1,id2:secret2:role2
 */
function parseValidClients() {
  const raw = process.env.CLIENT_CREDENTIALS || '';
  if (!raw) {
    logger.warn('CLIENT_CREDENTIALS not set — no frontend clients can authenticate');
    return [];
  }

  return raw.split(',').map((entry) => {
    const [id, secret, role = 'viewer'] = entry.trim().split(':');
    return { id, secret, role };
  });
}

module.exports = { issueToken, verifyToken };
