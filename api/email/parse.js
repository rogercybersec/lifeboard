/**
 * LifeBoard — Email Bill Parser
 * POST /api/email/parse
 *
 * Receives email data from Google Apps Script (running in user's Gmail).
 * Uses Gemini AI to extract bill details (name, amount, due date, category).
 * Returns structured bill data that the Apps Script writes back to LifeBoard.
 *
 * Auth: Simple shared secret (LIFEBOARD_EMAIL_SECRET env var).
 * The user sets this same secret in their Apps Script config.
 *
 * Env vars: GEMINI_API_KEY, LIFEBOARD_EMAIL_SECRET
 */

const fs = require('fs');
const path = require('path');

const BILLS_FILE = path.join('/tmp', 'lifeboard-bills.json');

function loadBills() {
  try {
    return JSON.parse(fs.readFileSync(BILLS_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function saveBills(bills) {
  fs.writeFileSync(BILLS_FILE, JSON.stringify(bills), 'utf-8');
}

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
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
          generationConfig: { temperature: 0.1, maxOutputTokens: 500 },
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
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  // Auth check
  const secret = process.env.LIFEBOARD_EMAIL_SECRET;
  if (secret) {
    const provided = req.headers.authorization?.replace('Bearer ', '') || req.body?.secret;
    if (provided !== secret) {
      return res.status(401).json({ error: 'Invalid secret' });
    }
  }

  const { emails } = req.body;
  if (!emails || !Array.isArray(emails) || emails.length === 0) {
    return res.status(400).json({ error: 'Missing "emails" array. Each item: { from, subject, body, date }' });
  }

  // Rate limit: max 10 emails per request
  const batch = emails.slice(0, 10);
  const bills = loadBills();
  const results = [];

  for (const email of batch) {
    const { from, subject, body, date } = email;
    if (!subject && !body) {
      results.push({ skipped: true, reason: 'No subject or body' });
      continue;
    }

    // Ask Gemini to extract bill data
    const emailText = [
      `From: ${from || 'unknown'}`,
      `Subject: ${subject || ''}`,
      `Date: ${date || ''}`,
      `Body (first 2000 chars): ${(body || '').slice(0, 2000)}`,
    ].join('\n');

    const parsed = await askGemini(
      'Extract bill/invoice details from this email. Reply ONLY valid JSON (no markdown):\n' +
      '{"is_bill":true/false,"name":"Company Name","amount":123.45,"due_date":"YYYY-MM-DD","category":"telecom","account_ref":"ACC123","creditor_email":"billing@co.com"}\n' +
      'Categories: telecom,housing,transport,utilities,insurance,subscriptions,medical,government,other\n' +
      'If this is NOT a bill/invoice/payment reminder, set is_bill to false.\n' +
      'If amount or due_date cannot be determined, set them to null.\n' +
      'Extract the creditor email from the "from" address.\n\n' +
      emailText
    );

    if (!parsed) {
      results.push({ from, subject, error: 'Gemini parse failed' });
      continue;
    }

    let data;
    try {
      data = JSON.parse(parsed.replace(/```json\n?|\n?```/g, '').trim());
    } catch {
      results.push({ from, subject, error: 'Invalid JSON from Gemini', raw: parsed.slice(0, 200) });
      continue;
    }

    if (!data.is_bill) {
      results.push({ from, subject, skipped: true, reason: 'Not a bill' });
      continue;
    }

    // Check if bill already exists (by name + similar due date)
    const existing = bills.find(b =>
      b.name.toLowerCase() === (data.name || '').toLowerCase() &&
      b.dueDate === data.due_date
    );

    if (existing) {
      results.push({ name: data.name, skipped: true, reason: 'Already exists' });
      continue;
    }

    // Create new bill
    const newBill = {
      id: genId(),
      name: data.name || subject || 'Unknown Bill',
      amount: data.amount || 0,
      dueDate: data.due_date || '',
      frequency: 'monthly',
      category: data.category || 'other',
      status: 'pending',
      notes: data.account_ref ? `Ref: ${data.account_ref}` : '',
      creditorEmail: data.creditor_email || from || '',
      source: 'email',
      emailDate: date || new Date().toISOString(),
      actions: [{ type: 'auto_detected', date: new Date().toISOString(), from: from || '' }],
    };

    bills.push(newBill);
    results.push({ name: newBill.name, amount: newBill.amount, dueDate: newBill.dueDate, created: true });
  }

  saveBills(bills);

  return res.status(200).json({
    status: 'ok',
    processed: batch.length,
    created: results.filter(r => r.created).length,
    skipped: results.filter(r => r.skipped).length,
    results,
  });
};
