/**
 * LifeBoard — Transaction Fetch + AI Categorisation
 * GET /api/banking/transactions — Fetch transactions from connected banks
 *
 * Features:
 * - Fetches transactions from Basiq CDR
 * - AI-categorises uncategorised transactions via Gemini
 * - Detects recurring payments automatically
 * - Returns enriched transaction data
 *
 * Env vars: BASIQ_API_KEY, GEMINI_API_KEY, GROQ_API_KEY, LIFEBOARD_SYNC_SECRET
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const BASIQ_API = 'https://au-api.basiq.io';
const TX_CACHE_FILE = path.join('/tmp', 'lifeboard-transactions.json');
const RECURRING_FILE = path.join('/tmp', 'lifeboard-recurring.json');

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
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
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

  if (!resp.ok) throw new Error(`Basiq token error ${resp.status}`);
  const data = await resp.json();
  cachedToken = data.access_token;
  tokenExpiry = now + (data.expires_in * 1000) - 60000;
  return cachedToken;
}

async function fetchTransactions(token, userId, fromDate, toDate) {
  const params = new URLSearchParams();
  if (fromDate) params.set('filter', `transaction.postDate.bt('${fromDate}','${toDate || new Date().toISOString().split('T')[0]}')`);
  params.set('limit', '500');

  const url = `${BASIQ_API}/users/${userId}/transactions?${params.toString()}`;
  const resp = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'basiq-version': '3.0'
    }
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Basiq transactions error ${resp.status}: ${err.substring(0, 200)}`);
  }

  return resp.json();
}

function cleanKey(raw) {
  return (raw || '').trim().replace(/^["']|["']$/g, '').replace(/\\n/g, '').replace(/\n/g, '');
}

async function categoriseWithAI(transactions) {
  const geminiKey = cleanKey(process.env.GEMINI_API_KEY);
  const groqKey = cleanKey(process.env.GROQ_API_KEY);

  if (!geminiKey && !groqKey) return transactions;

  // Batch uncategorised transactions for AI
  const uncategorised = transactions.filter(t => !t.category || t.category === 'other');
  if (uncategorised.length === 0) return transactions;

  // Build compact prompt
  const txList = uncategorised.slice(0, 50).map(t =>
    `${t.description} | $${Math.abs(t.amount).toFixed(2)} | ${t.direction}`
  ).join('\n');

  const prompt = `Categorise these Australian bank transactions. For each line, return ONLY a JSON array of category strings.
Categories: housing, telecom, transport, utilities, insurance, subscriptions, groceries, dining, health, entertainment, shopping, income, transfer, fees, other

Transactions:
${txList}

Return ONLY a JSON array like ["housing","groceries","dining",...] with one category per line, in order.`;

  let result = null;

  // Try Gemini first
  if (geminiKey) {
    try {
      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.1, maxOutputTokens: 1000 }
          })
        }
      );
      if (resp.ok) {
        const data = await resp.json();
        result = data.candidates?.[0]?.content?.parts?.[0]?.text;
      }
    } catch (e) {
      console.error('Gemini categorise error:', e.message);
    }
  }

  // Fallback to Groq
  if (!result && groqKey) {
    try {
      const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${groqKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [
            { role: 'system', content: 'You categorise bank transactions. Return only valid JSON arrays.' },
            { role: 'user', content: prompt }
          ],
          temperature: 0.1,
          max_tokens: 1000
        })
      });
      if (resp.ok) {
        const data = await resp.json();
        result = data.choices?.[0]?.message?.content;
      }
    } catch (e) {
      console.error('Groq categorise error:', e.message);
    }
  }

  if (!result) return transactions;

  // Parse AI response
  try {
    const jsonMatch = result.match(/\[[\s\S]*?\]/);
    if (!jsonMatch) return transactions;

    const categories = JSON.parse(jsonMatch[0]);
    const validCategories = ['housing', 'telecom', 'transport', 'utilities', 'insurance', 'subscriptions', 'groceries', 'dining', 'health', 'entertainment', 'shopping', 'income', 'transfer', 'fees', 'other'];

    uncategorised.forEach((tx, i) => {
      if (categories[i] && validCategories.includes(categories[i])) {
        tx.category = categories[i];
        tx.categorySource = 'ai';
      }
    });
  } catch (e) {
    console.error('AI category parse error:', e.message);
  }

  return transactions;
}

function detectRecurring(transactions) {
  // Group by merchant/description (normalised)
  const groups = {};
  for (const tx of transactions) {
    if (tx.direction === 'credit') continue; // Skip income
    const key = tx.description
      .toLowerCase()
      .replace(/[0-9]{2,}/g, '') // Remove dates/numbers
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 50);

    if (!groups[key]) groups[key] = [];
    groups[key].push(tx);
  }

  const recurring = [];

  for (const [key, txs] of Object.entries(groups)) {
    if (txs.length < 2) continue;

    // Sort by date
    txs.sort((a, b) => new Date(a.postDate) - new Date(b.postDate));

    // Calculate intervals between transactions
    const intervals = [];
    for (let i = 1; i < txs.length; i++) {
      const days = Math.round(
        (new Date(txs[i].postDate) - new Date(txs[i - 1].postDate)) / (1000 * 60 * 60 * 24)
      );
      if (days > 0) intervals.push(days);
    }

    if (intervals.length === 0) continue;

    const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    const variance = intervals.reduce((sum, d) => sum + Math.pow(d - avgInterval, 2), 0) / intervals.length;
    const stdDev = Math.sqrt(variance);

    // If consistent interval (low standard deviation relative to mean)
    if (stdDev <= avgInterval * 0.3) {
      let frequency = 'monthly';
      if (avgInterval <= 8) frequency = 'weekly';
      else if (avgInterval <= 16) frequency = 'fortnightly';
      else if (avgInterval <= 35) frequency = 'monthly';
      else if (avgInterval <= 100) frequency = 'quarterly';
      else frequency = 'yearly';

      const amounts = txs.map(t => Math.abs(t.amount));
      const avgAmount = amounts.reduce((a, b) => a + b, 0) / amounts.length;
      const lastTx = txs[txs.length - 1];

      // Predict next payment date
      const lastDate = new Date(lastTx.postDate);
      const nextDate = new Date(lastDate);
      nextDate.setDate(nextDate.getDate() + Math.round(avgInterval));

      recurring.push({
        description: lastTx.description,
        normalizedKey: key,
        frequency,
        avgAmount: Math.round(avgAmount * 100) / 100,
        lastAmount: Math.abs(lastTx.amount),
        lastDate: lastTx.postDate,
        nextExpectedDate: nextDate.toISOString().split('T')[0],
        occurrences: txs.length,
        avgIntervalDays: Math.round(avgInterval),
        category: lastTx.category || 'other',
        confidence: Math.max(0, Math.min(1, 1 - (stdDev / avgInterval)))
      });
    }
  }

  // Sort by confidence desc
  recurring.sort((a, b) => b.confidence - a.confidence);
  return recurring;
}

module.exports = async (req, res) => {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'GET only' });
  }

  // Auth
  const secret = process.env.LIFEBOARD_SYNC_SECRET;
  if (secret) {
    const provided = (req.headers.authorization || '').replace('Bearer ', '');
    if (!provided || !timingSafeEqual(provided, secret)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  const userId = req.query.userId;
  if (!userId || typeof userId !== 'string' || userId.length > 100) {
    return res.status(400).json({ error: 'Missing userId' });
  }

  if (!process.env.BASIQ_API_KEY) {
    return res.status(503).json({ error: 'Open Banking not configured' });
  }

  try {
    const token = await getBasiqToken();

    // Default: last 90 days
    const toDate = new Date().toISOString().split('T')[0];
    const fromDate = req.query.from || new Date(Date.now() - 90 * 86400000).toISOString().split('T')[0];

    const rawTxData = await fetchTransactions(token, userId, fromDate, toDate);

    // Normalize Basiq transaction format
    let transactions = (rawTxData.data || []).map(tx => ({
      id: tx.id,
      description: tx.description || '',
      amount: parseFloat(tx.amount) || 0,
      direction: tx.direction || (parseFloat(tx.amount) >= 0 ? 'credit' : 'debit'),
      postDate: tx.postDate || tx.transactionDate,
      account: tx.account?.name || tx.accountId,
      institution: tx.connection?.institution?.shortName || '',
      category: tx.subClass?.title || tx.class?.title || null,
      categorySource: tx.subClass?.title ? 'bank' : null,
      status: tx.status
    }));

    // AI categorisation for uncategorised transactions
    transactions = await categoriseWithAI(transactions);

    // Detect recurring payments
    const recurring = detectRecurring(transactions);

    // Cache to /tmp for cron access
    const cacheData = {
      lastFetch: new Date().toISOString(),
      userId,
      transactionCount: transactions.length,
      transactions: transactions.slice(0, 500)
    };
    fs.writeFileSync(TX_CACHE_FILE, JSON.stringify(cacheData), 'utf-8');

    if (recurring.length > 0) {
      fs.writeFileSync(RECURRING_FILE, JSON.stringify({
        lastDetected: new Date().toISOString(),
        recurring
      }), 'utf-8');
    }

    // Spending summary by category
    const spending = {};
    for (const tx of transactions) {
      if (tx.direction === 'credit') continue;
      const cat = tx.category || 'other';
      if (!spending[cat]) spending[cat] = { total: 0, count: 0 };
      spending[cat].total += Math.abs(tx.amount);
      spending[cat].count++;
    }

    // Round totals
    for (const cat of Object.keys(spending)) {
      spending[cat].total = Math.round(spending[cat].total * 100) / 100;
    }

    return res.status(200).json({
      transactions: transactions.slice(0, 200), // Limit response size
      recurring,
      spending,
      period: { from: fromDate, to: toDate },
      totalTransactions: transactions.length
    });
  } catch (e) {
    console.error('Transactions fetch error:', e.message);
    return res.status(500).json({ error: 'Failed to fetch transactions' });
  }
};
