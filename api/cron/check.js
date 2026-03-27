/**
 * LifeBoard — Daily Cron Payment Reminder
 * Vercel Serverless Function
 *
 * Runs daily at 9:00 AM AEDT (22:00 UTC previous day).
 * Reads synced bills from /tmp/lifeboard-bills.json (written by /api/sync).
 * Sends Telegram messages for bills due within 7/3/1/0 days or overdue.
 *
 * Env vars required: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
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
    const raw = fs.readFileSync(BILLS_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function loadSentKeys() {
  try {
    const raw = fs.readFileSync(SENT_FILE, 'utf-8');
    return JSON.parse(raw);
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
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
    }),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.description || `Telegram HTTP ${resp.status}`);
  }
  return resp.json();
}

module.exports = async function handler(req, res) {
  // Only allow GET (Vercel cron) or POST (manual trigger)
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    return res.status(500).json({
      error: 'Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID env vars',
    });
  }

  const bills = loadBills();
  if (!bills || !Array.isArray(bills) || bills.length === 0) {
    // No bills synced yet — send a heads-up instead of failing silently
    try {
      await sendTelegram(
        token,
        chatId,
        '⚠️ <b>LifeBoard Cron</b>\nNo bills synced yet. Open LifeBoard in your browser to sync bills to the server.'
      );
    } catch {
      // Telegram itself failed — nothing we can do
    }
    return res.status(200).json({
      status: 'no_bills',
      message: 'No bills data found in /tmp. Sync from the app first.',
    });
  }

  const pending = bills.filter((b) => b.status !== 'paid');
  const today = new Date().toISOString().split('T')[0];
  const sent = loadSentKeys();
  const thresholds = [7, 3, 1, 0];
  const results = [];

  for (const bill of pending) {
    const days = daysDiff(bill.dueDate);

    for (const t of thresholds) {
      if (days === t || (days < 0 && t === 0)) {
        const sentKey = `${bill.id}_${t}_${today}`;
        if (sent[sentKey]) {
          results.push({ bill: bill.name, skipped: true, reason: 'already sent today' });
          continue;
        }

        let urgency = '🔔 REMINDER';
        if (days <= 0) urgency = '🚨 URGENT';
        else if (days <= 1) urgency = '⏰ TOMORROW';
        else if (days <= 3) urgency = '⚡ SOON';

        const message = [
          `<b>${urgency}</b>`,
          ``,
          `<b>${bill.name}</b> — $${bill.amount.toFixed(2)}`,
          `Due: ${formatDateLong(bill.dueDate)} (${countdownText(days)})`,
          `Status: ${bill.status.toUpperCase()}`,
          ``,
          `— LifeBoard Secretary`,
        ].join('\n');

        try {
          await sendTelegram(token, chatId, message);
          sent[sentKey] = true;
          results.push({ bill: bill.name, days, urgency: urgency.replace(/[^A-Z]/g, '').trim(), sent: true });
        } catch (e) {
          results.push({ bill: bill.name, days, error: e.message });
        }

        break; // Only fire the most urgent threshold per bill
      }
    }
  }

  saveSentKeys(sent);

  // Summary message if any bills were alerted
  const alertedCount = results.filter((r) => r.sent).length;
  if (alertedCount > 0) {
    const summary = `📊 <b>LifeBoard Daily Summary</b>\n${alertedCount} payment reminder${alertedCount > 1 ? 's' : ''} sent.\n${pending.length} bills pending total.`;
    try {
      await sendTelegram(token, chatId, summary);
    } catch {
      // Non-critical
    }
  }

  return res.status(200).json({
    status: 'ok',
    date: today,
    pendingBills: pending.length,
    results,
  });
};
