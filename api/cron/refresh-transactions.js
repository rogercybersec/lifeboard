/**
 * LifeBoard — Scheduled Transaction Refresh
 * Vercel Cron Function
 *
 * Runs every 6 hours. Fetches latest transactions from connected banks,
 * re-categorises with AI, detects new recurring payments, and caches
 * results for the main transaction API and daily digest cron.
 *
 * Env vars: BASIQ_API_KEY, GEMINI_API_KEY, GROQ_API_KEY, CRON_SECRET,
 *           TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID (optional — for alerts)
 */

const fs = require('fs');
const path = require('path');

const BASIQ_API = 'https://au-api.basiq.io';
const TX_CACHE_FILE = path.join('/tmp', 'lifeboard-transactions.json');
const RECURRING_FILE = path.join('/tmp', 'lifeboard-recurring.json');
const USERS_FILE = path.join('/tmp', 'lifeboard-connected-users.json');
const REFRESH_LOG_FILE = path.join('/tmp', 'lifeboard-refresh-log.json');

let cachedToken = null;
let tokenExpiry = 0;

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
  if (fromDate) {
    params.set('filter', `transaction.postDate.bt('${fromDate}','${toDate}')`);
  }
  params.set('limit', '500');

  const resp = await fetch(`${BASIQ_API}/users/${userId}/transactions?${params}`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'basiq-version': '3.0'
    }
  });

  if (!resp.ok) {
    throw new Error(`Basiq transactions ${resp.status}`);
  }
  return resp.json();
}

function cleanKey(raw) {
  return (raw || '').trim().replace(/^["']|["']$/g, '').replace(/\\n/g, '').replace(/\n/g, '');
}

async function categoriseWithAI(transactions) {
  const geminiKey = cleanKey(process.env.GEMINI_API_KEY);
  if (!geminiKey) return transactions;

  const uncategorised = transactions.filter(t => !t.category || t.category === 'other');
  if (uncategorised.length === 0) return transactions;

  const txList = uncategorised.slice(0, 50).map(t =>
    `${t.description} | $${Math.abs(t.amount).toFixed(2)} | ${t.direction}`
  ).join('\n');

  const prompt = `Categorise these Australian bank transactions. Return ONLY a JSON array of category strings.
Categories: housing, telecom, transport, utilities, insurance, subscriptions, groceries, dining, health, entertainment, shopping, income, transfer, fees, other

Transactions:
${txList}

Return ONLY a JSON array like ["housing","groceries","dining",...] with one category per line, in order.`;

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
      const result = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (result) {
        const jsonMatch = result.match(/\[[\s\S]*?\]/);
        if (jsonMatch) {
          const categories = JSON.parse(jsonMatch[0]);
          const valid = ['housing', 'telecom', 'transport', 'utilities', 'insurance', 'subscriptions', 'groceries', 'dining', 'health', 'entertainment', 'shopping', 'income', 'transfer', 'fees', 'other'];
          uncategorised.forEach((tx, i) => {
            if (categories[i] && valid.includes(categories[i])) {
              tx.category = categories[i];
              tx.categorySource = 'ai';
            }
          });
        }
      }
    }
  } catch (e) {
    console.error('[refresh-tx] AI categorise error:', e.message);
  }

  return transactions;
}

function detectRecurring(transactions) {
  const groups = {};
  for (const tx of transactions) {
    if (tx.direction === 'credit') continue;
    const key = tx.description
      .toLowerCase()
      .replace(/[0-9]{2,}/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 50);

    if (!groups[key]) groups[key] = [];
    groups[key].push(tx);
  }

  const recurring = [];

  for (const [key, txs] of Object.entries(groups)) {
    if (txs.length < 2) continue;
    txs.sort((a, b) => new Date(a.postDate) - new Date(b.postDate));

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
      const nextDate = new Date(lastTx.postDate);
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

  recurring.sort((a, b) => b.confidence - a.confidence);
  return recurring;
}

async function sendTelegramAlert(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' })
    });
  } catch { /* best effort */ }
}

function loadConnectedUsers() {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

module.exports = async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Auth
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const provided = (req.headers.authorization || '').replace('Bearer ', '');
    if (!provided || provided !== cronSecret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  if (!process.env.BASIQ_API_KEY) {
    return res.status(200).json({ status: 'skipped', reason: 'BASIQ_API_KEY not configured' });
  }

  const users = loadConnectedUsers();
  if (users.length === 0) {
    return res.status(200).json({ status: 'skipped', reason: 'No connected users' });
  }

  const results = [];
  const toDate = new Date().toISOString().split('T')[0];
  const fromDate = new Date(Date.now() - 90 * 86400000).toISOString().split('T')[0];

  for (const user of users) {
    const userId = typeof user === 'string' ? user : user.id;
    try {
      const token = await getBasiqToken();
      const rawTxData = await fetchTransactions(token, userId, fromDate, toDate);

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

      transactions = await categoriseWithAI(transactions);
      const recurring = detectRecurring(transactions);

      // Cache results
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

      results.push({
        userId,
        transactionCount: transactions.length,
        recurringFound: recurring.length,
        status: 'ok'
      });

      // Alert on new large transactions (> $500)
      const recentLarge = transactions.filter(t => {
        if (t.direction === 'credit') return false;
        const txDate = new Date(t.postDate);
        const sixHoursAgo = new Date(Date.now() - 6 * 3600000);
        return Math.abs(t.amount) > 500 && txDate > sixHoursAgo;
      });

      if (recentLarge.length > 0) {
        const alertLines = recentLarge.map(t =>
          `- ${t.description}: $${Math.abs(t.amount).toFixed(2)}`
        ).join('\n');
        await sendTelegramAlert(
          `<b>LifeBoard Alert</b>\n${recentLarge.length} large transaction(s) detected:\n${alertLines}`
        );
      }
    } catch (e) {
      console.error(`[refresh-tx] Error for user ${userId}:`, e.message);
      results.push({ userId, status: 'error', error: e.message });
    }
  }

  // Save refresh log
  const log = {
    lastRefresh: new Date().toISOString(),
    usersProcessed: results.length,
    results
  };
  fs.writeFileSync(REFRESH_LOG_FILE, JSON.stringify(log), 'utf-8');

  return res.status(200).json({
    status: 'ok',
    refreshedAt: log.lastRefresh,
    results
  });
};
