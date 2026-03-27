/**
 * LifeBoard — Smart Daily Secretary (Gemini-powered)
 * Vercel Serverless Function
 *
 * Runs daily at 9:00 AM AEDT (22:00 UTC previous day).
 * Reads synced bills from /tmp, uses Gemini AI to compose an intelligent
 * daily digest instead of spamming individual threshold notifications.
 * Falls back to threshold-based alerts if Gemini is unavailable.
 *
 * Env vars: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, GEMINI_API_KEY (optional)
 */

const fs = require('fs');
const path = require('path');

const BILLS_FILE = path.join('/tmp', 'lifeboard-bills.json');
const SENT_FILE = path.join('/tmp', 'lifeboard-cron-sent.json');

function daysDiff(dateStr) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(dateStr);
  due.setHours(0, 0, 0, 0);
  return Math.round((due - today) / (1000 * 60 * 60 * 24));
}

function formatDateLong(dateStr) {
  return new Date(dateStr).toLocaleDateString('en-AU', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

function countdownText(days) {
  if (days < 0) return `${Math.abs(days)}d overdue`;
  if (days === 0) return 'Due today';
  if (days === 1) return 'Tomorrow';
  return `${days}d`;
}

function loadBills() {
  try {
    return JSON.parse(fs.readFileSync(BILLS_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

function loadSentKeys() {
  try {
    return JSON.parse(fs.readFileSync(SENT_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function saveSentKeys(sent) {
  fs.writeFileSync(SENT_FILE, JSON.stringify(sent), 'utf-8');
}

async function sendTelegram(token, chatId, text) {
  const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.description || `Telegram HTTP ${resp.status}`);
  }
  return resp.json();
}

async function askGemini(prompt) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  try {
    const resp = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + key,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.4, maxOutputTokens: 400 },
        }),
      }
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || null;
  } catch {
    return null;
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    return res.status(500).json({ error: 'Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID' });
  }

  const bills = loadBills();
  if (!bills || !Array.isArray(bills) || bills.length === 0) {
    try {
      await sendTelegram(token, chatId,
        '<b>LifeBoard Secretary</b>\nNo bills synced. Open LifeBoard to sync your data.');
    } catch {}
    return res.status(200).json({ status: 'no_bills' });
  }

  const pending = bills.filter((b) => b.status !== 'paid');
  const today = new Date().toISOString().split('T')[0];
  const sent = loadSentKeys();
  const results = [];

  // Identify which bills need attention today
  const needsAttention = [];
  for (const bill of pending) {
    const days = daysDiff(bill.dueDate);
    const thresholds = [7, 3, 1, 0];
    for (const t of thresholds) {
      if (days === t || (days < 0 && t === 0)) {
        const sentKey = `${bill.id}_${t}_${today}`;
        if (!sent[sentKey]) {
          needsAttention.push({ bill, days, threshold: t, sentKey });
        }
        break;
      }
    }
  }

  if (needsAttention.length === 0) {
    return res.status(200).json({ status: 'ok', date: today, pendingBills: pending.length, results: [] });
  }

  // Try Gemini smart digest first (1 API call instead of N messages)
  const billSummary = needsAttention.map(({ bill, days }) =>
    `${bill.name}: $${bill.amount.toFixed(2)}, ${countdownText(days)}, ${bill.category}${bill.notes ? ' (' + bill.notes + ')' : ''}`
  ).join('\n');

  let smartDigest = await askGemini(
    'You are LifeBoard Secretary sending a Telegram morning briefing. ' +
    'Write a concise daily payment digest (under 150 words, HTML format for Telegram). ' +
    'Prioritise: overdue first, then due today, then upcoming. ' +
    'Be direct, actionable, Australian English. Include dollar amounts. ' +
    'Start with a one-line status summary. Do NOT repeat the same advice every day — ' +
    'vary your language and focus on what\'s CHANGED since yesterday. ' +
    'Today: ' + new Date().toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long' }) +
    '\n\nBills needing attention:\n' + billSummary +
    '\n\nTotal pending: ' + pending.length + ' bills, $' +
    pending.reduce((s, b) => s + b.amount, 0).toFixed(2) + ' total'
  );

  if (smartDigest) {
    // Send single smart digest
    try {
      await sendTelegram(token, chatId, smartDigest);
      // Mark all as sent
      for (const { sentKey, bill, days } of needsAttention) {
        sent[sentKey] = true;
        results.push({ bill: bill.name, days, sent: true, method: 'smart_digest' });
      }
    } catch (e) {
      results.push({ error: 'Smart digest failed: ' + e.message });
      smartDigest = null; // Fall through to individual alerts
    }
  }

  // Fallback: individual threshold-based alerts
  if (!smartDigest) {
    for (const { bill, days, sentKey } of needsAttention) {
      let urgency = 'REMINDER';
      if (days <= 0) urgency = 'URGENT';
      else if (days <= 1) urgency = 'TOMORROW';
      else if (days <= 3) urgency = 'SOON';

      const message = [
        `<b>${days <= 0 ? '🚨' : days <= 1 ? '⏰' : days <= 3 ? '⚡' : '🔔'} ${urgency}</b>`,
        ``,
        `<b>${bill.name}</b> — $${bill.amount.toFixed(2)}`,
        `Due: ${formatDateLong(bill.dueDate)} (${countdownText(days)})`,
        ``,
        `— LifeBoard Secretary`,
      ].join('\n');

      try {
        await sendTelegram(token, chatId, message);
        sent[sentKey] = true;
        results.push({ bill: bill.name, days, sent: true, method: 'threshold' });
      } catch (e) {
        results.push({ bill: bill.name, error: e.message });
      }
    }
  }

  saveSentKeys(sent);

  return res.status(200).json({
    status: 'ok',
    date: today,
    pendingBills: pending.length,
    method: smartDigest ? 'gemini_digest' : 'threshold_fallback',
    results,
  });
};
