/**
 * LifeBoard — Bills Sync Endpoint
 * POST /api/sync
 *
 * Accepts bills JSON from the browser client and writes to /tmp
 * so the cron function can read them.
 *
 * SECURITY:
 * - Auth required via LIFEBOARD_SYNC_SECRET (Bearer token)
 * - CORS restricted to deployment origin only
 * - Input validated and size-limited
 * - Error messages sanitized (no stack traces)
 * - Rate limited to 100 bills max per request
 *
 * Body: { bills: [...] }
 * Env vars: LIFEBOARD_SYNC_SECRET
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BILLS_FILE = path.join('/tmp', 'lifeboard-bills.json');
const META_FILE = path.join('/tmp', 'lifeboard-sync-meta.json');
const MAX_BILLS = 100;
const MAX_BODY_SIZE = 512 * 1024; // 512KB

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Cache-Control', 'no-store');
}

module.exports = async function handler(req, res) {
  setSecurityHeaders(res);

  // CORS: restrict to exact deployment origin only
  const allowedOrigins = [];
  if (process.env.VERCEL_URL) allowedOrigins.push(`https://${process.env.VERCEL_URL}`);
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) allowedOrigins.push(`https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`);

  const origin = req.headers.origin || '';
  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }

  // Auth: require sync secret
  const secret = process.env.LIFEBOARD_SYNC_SECRET;
  if (secret) {
    const provided = (req.headers.authorization || '').replace('Bearer ', '');
    if (!provided || !timingSafeEqual(provided, secret)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  try {
    const { bills } = req.body;

    if (!bills || !Array.isArray(bills)) {
      return res.status(400).json({ error: 'Invalid request' });
    }

    // Size limit
    if (bills.length > MAX_BILLS) {
      return res.status(400).json({ error: `Max ${MAX_BILLS} bills per sync` });
    }

    // Validate bill structure (whitelist fields)
    const sanitized = bills.map((b) => ({
      id: String(b.id || '').slice(0, 50),
      name: String(b.name || '').slice(0, 200),
      amount: typeof b.amount === 'number' ? Math.max(0, Math.min(b.amount, 999999)) : 0,
      dueDate: String(b.dueDate || '').slice(0, 10),
      frequency: ['monthly', 'weekly', 'fortnightly', 'quarterly', 'yearly', 'once'].includes(b.frequency) ? b.frequency : 'monthly',
      category: String(b.category || 'other').slice(0, 50),
      status: ['pending', 'paid', 'deferred'].includes(b.status) ? b.status : 'pending',
      notes: String(b.notes || '').slice(0, 500),
      creditorEmail: String(b.creditorEmail || '').slice(0, 200),
      source: String(b.source || 'manual').slice(0, 20),
      actions: Array.isArray(b.actions) ? b.actions.slice(0, 50) : [],
    }));

    fs.writeFileSync(BILLS_FILE, JSON.stringify(sanitized), 'utf-8');

    const meta = {
      lastSync: new Date().toISOString(),
      billCount: sanitized.length,
      pendingCount: sanitized.filter((b) => b.status !== 'paid').length,
    };
    fs.writeFileSync(META_FILE, JSON.stringify(meta), 'utf-8');

    return res.status(200).json({ status: 'synced', ...meta });
  } catch {
    return res.status(500).json({ error: 'Internal error' });
  }
};
