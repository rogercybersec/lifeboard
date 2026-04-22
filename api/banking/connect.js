/**
 * LifeBoard — Open Banking Connection (Basiq CDR)
 * POST /api/banking/connect — Create consent link for bank connection
 * GET  /api/banking/connect — Check connection status
 *
 * Basiq is an Australian CDR-compliant aggregator.
 * Flow: Server gets token → creates user → returns consent UI URL
 *
 * Env vars: BASIQ_API_KEY, LIFEBOARD_SYNC_SECRET
 */

const crypto = require('crypto');

const BASIQ_API = 'https://au-api.basiq.io';
let cachedToken = null;
let tokenExpiry = 0;

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function setCors(req, res) {
  const allowedOrigins = [];
  if (process.env.VERCEL_URL) allowedOrigins.push(`https://${process.env.VERCEL_URL}`);
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) allowedOrigins.push(`https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`);
  const origin = req.headers.origin || '';
  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
}

async function getBasiqToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiry) return cachedToken;

  const apiKey = process.env.BASIQ_API_KEY;
  if (!apiKey) throw new Error('BASIQ_API_KEY not configured');

  const resp = await fetch(`${BASIQ_API}/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${apiKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'basiq-version': '3.0'
    },
    body: 'scope=SERVER_ACCESS'
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Basiq token error ${resp.status}: ${err.substring(0, 200)}`);
  }

  const data = await resp.json();
  cachedToken = data.access_token;
  tokenExpiry = now + (data.expires_in * 1000) - 60000; // Refresh 1min early
  return cachedToken;
}

async function createBasiqUser(token, email) {
  const resp = await fetch(`${BASIQ_API}/users`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'basiq-version': '3.0'
    },
    body: JSON.stringify({ email: email || '', mobile: '' })
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Basiq user create error ${resp.status}: ${err.substring(0, 200)}`);
  }

  return resp.json();
}

async function createConsentLink(token, userId) {
  const resp = await fetch(`${BASIQ_API}/users/${userId}/auth_link`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'basiq-version': '3.0'
    },
    body: JSON.stringify({})
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Basiq consent link error ${resp.status}: ${err.substring(0, 200)}`);
  }

  return resp.json();
}

async function getConnections(token, userId) {
  const resp = await fetch(`${BASIQ_API}/users/${userId}/connections`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'basiq-version': '3.0'
    }
  });

  if (!resp.ok) return { data: [] };
  return resp.json();
}

module.exports = async (req, res) => {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Auth
  const secret = process.env.LIFEBOARD_SYNC_SECRET;
  if (secret) {
    const provided = (req.headers.authorization || '').replace('Bearer ', '');
    if (!provided || !timingSafeEqual(provided, secret)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  if (!process.env.BASIQ_API_KEY) {
    return res.status(503).json({ error: 'Open Banking not configured', configured: false });
  }

  try {
    const token = await getBasiqToken();

    if (req.method === 'GET') {
      // Check connection status for an existing user
      const userId = req.query.userId;
      if (!userId || typeof userId !== 'string' || userId.length > 100) {
        return res.status(400).json({ error: 'Missing userId' });
      }

      const connections = await getConnections(token, userId);
      const active = (connections.data || []).filter(c => c.status === 'active');

      return res.status(200).json({
        connected: active.length > 0,
        connections: active.map(c => ({
          id: c.id,
          institution: c.institution?.shortName || c.institution?.name || 'Unknown',
          status: c.status,
          lastUsed: c.lastUsed
        }))
      });
    }

    if (req.method === 'POST') {
      const { email, userId: existingUserId } = req.body || {};

      let userId = existingUserId;

      // Create new Basiq user if no existing ID
      if (!userId) {
        const user = await createBasiqUser(token, email);
        userId = user.id;
      }

      // Generate consent link for bank connection
      const authLink = await createConsentLink(token, userId);

      return res.status(200).json({
        userId,
        consentUrl: authLink.links?.public || authLink.url,
        expiresAt: authLink.expiresAt
      });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('Banking connect error:', e.message);
    return res.status(500).json({ error: 'Banking connection failed' });
  }
};
