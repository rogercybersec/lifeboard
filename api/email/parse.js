/**
 * LifeBoard — Email Bill Parser
 * POST /api/email/parse
 *
 * Receives email data from Google Apps Script.
 * Uses AI (Gemini primary, Groq fallback) to extract bill details.
 * Returns structured bills for the client to add to localStorage.
 */

function cleanKey(raw) {
  return (raw || '').trim().replace(/^["']|["']$/g, '').replace(/\\n/g, '').replace(/\n/g, '');
}

async function askAI(prompt) {
  // Try Gemini first
  const geminiKey = cleanKey(process.env.GEMINI_API_KEY);
  if (geminiKey) {
    try {
      const resp = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + geminiKey,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.1, maxOutputTokens: 500 },
          }),
        }
      );
      if (resp.ok) {
        const data = await resp.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) return text;
      }
    } catch {}
  }

  // Fallback: Groq
  const groqKey = cleanKey(process.env.GROQ_API_KEY);
  if (groqKey) {
    try {
      const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + groqKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [
            { role: 'system', content: 'You extract bill data from emails. Reply ONLY valid JSON, no markdown.' },
            { role: 'user', content: prompt }
          ],
          temperature: 0.1, max_tokens: 500
        })
      });
      if (resp.ok) {
        const data = await resp.json();
        return data.choices?.[0]?.message?.content || null;
      }
    } catch {}
  }

  return null;
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  const crypto = require('crypto');
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function sanitize(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/<[^>]*>/g, '').replace(/[<>"'&]/g, c => {
    return { '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '&': '&amp;' }[c] || c;
  }).slice(0, 5000);
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const secret = (process.env.LIFEBOARD_EMAIL_SECRET || '').replace(/\\n/g,'').replace(/\n/g,'').trim();
  if (!secret) return res.status(503).json({ error: 'LIFEBOARD_EMAIL_SECRET not configured' });

  const provided = (req.headers.authorization || '').replace('Bearer ', '') || req.body?.secret || '';
  if (!provided || !timingSafeEqual(provided, secret)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { emails } = req.body;
  if (!emails || !Array.isArray(emails) || emails.length === 0) {
    return res.status(400).json({ error: 'Missing "emails" array' });
  }

  const batch = emails.slice(0, 10);
  const results = [];

  for (const email of batch) {
    const from = sanitize(email.from);
    const subject = sanitize(email.subject);
    const body = sanitize(email.body);
    const date = sanitize(email.date);

    if (!subject && !body) {
      results.push({ skipped: true, reason: 'No content' });
      continue;
    }

    const parsed = await askAI(
      'Extract bill/invoice details from this email. Reply ONLY valid JSON (no markdown):\n' +
      '{"is_bill":true,"name":"Company Name","amount":123.45,"due_date":"YYYY-MM-DD","category":"telecom","frequency":"monthly"}\n' +
      'Categories: telecom,housing,transport,utilities,insurance,subscriptions,other\n' +
      'If NOT a bill, set is_bill to false. If amount/date unknown, set null.\n\n' +
      'From: ' + from + '\nSubject: ' + subject + '\nDate: ' + date + '\nBody: ' + body.slice(0, 2000)
    );

    if (!parsed) {
      results.push({ from, subject, error: 'AI parse failed' });
      continue;
    }

    let data;
    try {
      data = JSON.parse(parsed.replace(/```json\n?|\n?```/g, '').trim());
    } catch {
      results.push({ from, subject, error: 'Invalid JSON' });
      continue;
    }

    if (!data.is_bill) {
      results.push({ from, subject, skipped: true, reason: 'Not a bill' });
      continue;
    }

    const crypto = require('crypto');
    results.push({
      created: true,
      bill: {
        id: Date.now().toString(36) + crypto.randomBytes(4).toString('hex'),
        name: data.name || subject || 'Unknown Bill',
        amount: data.amount || 0,
        dueDate: data.due_date || '',
        frequency: data.frequency || 'monthly',
        category: data.category || 'other',
        status: 'pending',
        notes: 'Auto-detected from email on ' + new Date().toLocaleDateString('en-AU'),
        source: 'email'
      }
    });
  }

  return res.status(200).json({
    status: 'ok',
    processed: batch.length,
    bills: results.filter(r => r.created).map(r => r.bill),
    skipped: results.filter(r => r.skipped).length,
  });
};
