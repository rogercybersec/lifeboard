/**
 * LifeBoard — Budget Goals & Negotiation Suggestions
 * GET  /api/banking/budget — Get budget goals + spending vs budget
 * POST /api/banking/budget — Set/update budget goals
 * POST /api/banking/budget?action=negotiate — Get AI negotiation suggestions
 *
 * Budget goals stored in /tmp (synced from client localStorage)
 * Negotiation suggestions powered by Gemini/Groq
 *
 * Env vars: LIFEBOARD_SYNC_SECRET, GEMINI_API_KEY, GROQ_API_KEY
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const BUDGET_FILE = path.join('/tmp', 'lifeboard-budget.json');
const TX_CACHE_FILE = path.join('/tmp', 'lifeboard-transactions.json');
const RECURRING_FILE = path.join('/tmp', 'lifeboard-recurring.json');

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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
}

function cleanKey(raw) {
  return (raw || '').trim().replace(/^["']|["']$/g, '').replace(/\\n/g, '').replace(/\n/g, '');
}

function readJson(filepath) {
  try {
    return JSON.parse(fs.readFileSync(filepath, 'utf-8'));
  } catch {
    return null;
  }
}

async function getAINegotiationSuggestions(spending, recurring, bills) {
  const geminiKey = cleanKey(process.env.GEMINI_API_KEY);
  const groqKey = cleanKey(process.env.GROQ_API_KEY);
  if (!geminiKey && !groqKey) return null;

  // Build context for AI
  const spendingSummary = Object.entries(spending || {})
    .map(([cat, data]) => `${cat}: $${data.total} (${data.count} transactions)`)
    .join('\n');

  const recurringList = (recurring || []).slice(0, 15)
    .map(r => `${r.description}: $${r.avgAmount} ${r.frequency}`)
    .join('\n');

  const billsList = (bills || []).slice(0, 15)
    .map(b => `${b.name}: $${b.amount} ${b.frequency}`)
    .join('\n');

  const prompt = `You are an Australian financial advisor. Analyse this person's spending and suggest ways to save money.

SPENDING LAST 90 DAYS:
${spendingSummary || 'No data'}

RECURRING PAYMENTS DETECTED:
${recurringList || 'None detected'}

KNOWN BILLS:
${billsList || 'None'}

Provide 3-5 specific, actionable suggestions:
1. Bills that could be negotiated (compare to typical AU rates)
2. Subscriptions that could be cut or downgraded
3. Categories where spending is above AU average
4. Specific providers to switch to for savings
5. Timing strategies (e.g. pay annually vs monthly)

For each suggestion, include:
- What to do
- Estimated annual savings in AUD
- How to do it (e.g. call retention team, use comparison site)

Return as JSON array:
[{"title":"...","description":"...","annualSavings":number,"action":"...","category":"...","difficulty":"easy|medium|hard"}]`;

  let result = null;

  if (geminiKey) {
    try {
      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.4, maxOutputTokens: 1500 }
          })
        }
      );
      if (resp.ok) {
        const data = await resp.json();
        result = data.candidates?.[0]?.content?.parts?.[0]?.text;
      }
    } catch (e) {
      console.error('Gemini negotiate error:', e.message);
    }
  }

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
            { role: 'system', content: 'You are an Australian financial advisor. Return valid JSON arrays only.' },
            { role: 'user', content: prompt }
          ],
          temperature: 0.4,
          max_tokens: 1500
        })
      });
      if (resp.ok) {
        const data = await resp.json();
        result = data.choices?.[0]?.message?.content;
      }
    } catch (e) {
      console.error('Groq negotiate error:', e.message);
    }
  }

  if (!result) return null;

  try {
    const jsonMatch = result.match(/\[[\s\S]*\]/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
  } catch (e) {
    console.error('Negotiate parse error:', e.message);
  }
  return null;
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

  try {
    if (req.method === 'GET') {
      // Return budget goals + spending comparison
      const budget = readJson(BUDGET_FILE) || { goals: {}, totalMonthly: 0 };
      const txCache = readJson(TX_CACHE_FILE);

      // Calculate current month spending by category
      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
      const currentSpending = {};

      if (txCache?.transactions) {
        for (const tx of txCache.transactions) {
          if (tx.direction === 'credit') continue;
          if (tx.postDate < monthStart) continue;
          const cat = tx.category || 'other';
          if (!currentSpending[cat]) currentSpending[cat] = 0;
          currentSpending[cat] += Math.abs(tx.amount);
        }
      }

      // Compare budget vs actual
      const comparison = {};
      const allCategories = new Set([
        ...Object.keys(budget.goals),
        ...Object.keys(currentSpending)
      ]);

      for (const cat of allCategories) {
        const budgeted = budget.goals[cat] || 0;
        const spent = Math.round((currentSpending[cat] || 0) * 100) / 100;
        comparison[cat] = {
          budgeted,
          spent,
          remaining: Math.round((budgeted - spent) * 100) / 100,
          percentUsed: budgeted > 0 ? Math.round((spent / budgeted) * 100) : null,
          overBudget: budgeted > 0 && spent > budgeted
        };
      }

      const totalBudgeted = Object.values(budget.goals).reduce((a, b) => a + b, 0);
      const totalSpent = Object.values(currentSpending).reduce((a, b) => a + b, 0);

      return res.status(200).json({
        goals: budget.goals,
        totalMonthly: budget.totalMonthly || totalBudgeted,
        comparison,
        summary: {
          totalBudgeted: Math.round(totalBudgeted * 100) / 100,
          totalSpent: Math.round(totalSpent * 100) / 100,
          remaining: Math.round((totalBudgeted - totalSpent) * 100) / 100,
          daysLeft: new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate() - now.getDate()
        },
        lastUpdated: budget.lastUpdated
      });
    }

    if (req.method === 'POST') {
      const action = req.query.action;

      // Negotiation suggestions
      if (action === 'negotiate') {
        const txCache = readJson(TX_CACHE_FILE);
        const recurringData = readJson(RECURRING_FILE);
        const billsRaw = readJson(path.join('/tmp', 'lifeboard-bills.json'));

        // Build spending summary from cache
        const spending = {};
        if (txCache?.transactions) {
          for (const tx of txCache.transactions) {
            if (tx.direction === 'credit') continue;
            const cat = tx.category || 'other';
            if (!spending[cat]) spending[cat] = { total: 0, count: 0 };
            spending[cat].total += Math.abs(tx.amount);
            spending[cat].count++;
          }
          for (const cat of Object.keys(spending)) {
            spending[cat].total = Math.round(spending[cat].total * 100) / 100;
          }
        }

        const suggestions = await getAINegotiationSuggestions(
          spending,
          recurringData?.recurring,
          billsRaw
        );

        return res.status(200).json({
          suggestions: suggestions || [],
          generatedAt: new Date().toISOString(),
          dataAvailable: {
            transactions: !!txCache,
            recurring: !!recurringData,
            bills: !!billsRaw
          }
        });
      }

      // Set budget goals
      const { goals, totalMonthly } = req.body || {};
      if (!goals || typeof goals !== 'object') {
        return res.status(400).json({ error: 'Missing goals object' });
      }

      // Validate goals (category -> monthly amount)
      const validCategories = ['housing', 'telecom', 'transport', 'utilities', 'insurance', 'subscriptions', 'groceries', 'dining', 'health', 'entertainment', 'shopping', 'fees', 'other'];
      const sanitizedGoals = {};

      for (const [cat, amount] of Object.entries(goals)) {
        if (validCategories.includes(cat) && typeof amount === 'number' && amount >= 0 && amount <= 999999) {
          sanitizedGoals[cat] = Math.round(amount * 100) / 100;
        }
      }

      const budgetData = {
        goals: sanitizedGoals,
        totalMonthly: typeof totalMonthly === 'number' ? totalMonthly : Object.values(sanitizedGoals).reduce((a, b) => a + b, 0),
        lastUpdated: new Date().toISOString()
      };

      fs.writeFileSync(BUDGET_FILE, JSON.stringify(budgetData), 'utf-8');

      return res.status(200).json({ status: 'saved', ...budgetData });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('Budget error:', e.message);
    return res.status(500).json({ error: 'Budget operation failed' });
  }
};
