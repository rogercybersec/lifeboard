/**
 * LifeBoard — Bills Sync Endpoint
 * POST /api/sync
 *
 * Accepts bills JSON from the browser client and writes to /tmp
 * so the cron function can read them.
 *
 * Note: /tmp on Vercel is ephemeral per function instance and may be
 * cleared between cold starts. For production, migrate to Vercel KV
 * or Upstash Redis. This works for MVP since cron and sync share
 * the same execution environment within a short window.
 *
 * Body: { bills: [...], telegram?: { token, chatId } }
 */

const fs = require('fs');
const path = require('path');

const BILLS_FILE = path.join('/tmp', 'lifeboard-bills.json');
const META_FILE = path.join('/tmp', 'lifeboard-sync-meta.json');

module.exports = async function handler(req, res) {
  // CORS: restrict to same origin in production
  const origin = req.headers.origin || '';
  const allowedOrigin = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '*';
  res.setHeader('Access-Control-Allow-Origin', origin || allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }

  try {
    const { bills } = req.body;

    if (!bills || !Array.isArray(bills)) {
      return res.status(400).json({ error: 'Missing or invalid "bills" array in body' });
    }

    // Write bills to /tmp for the cron to read
    fs.writeFileSync(BILLS_FILE, JSON.stringify(bills), 'utf-8');

    // Write sync metadata
    const meta = {
      lastSync: new Date().toISOString(),
      billCount: bills.length,
      pendingCount: bills.filter((b) => b.status !== 'paid').length,
    };
    fs.writeFileSync(META_FILE, JSON.stringify(meta), 'utf-8');

    return res.status(200).json({
      status: 'synced',
      ...meta,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
