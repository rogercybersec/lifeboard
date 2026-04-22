// LifeBoard — Dual AI Proxy (Gemini primary + Groq fallback)
// Keys stay server-side. Client never sees them.
// Auto-recovery: always tries Gemini first, falls back to Groq

const rateLimitMap = new Map();
let geminiDown = false;
let geminiLastCheck = 0;
const GEMINI_RETRY_MS = 120000; // Re-check Gemini every 2 minutes

function cleanKey(raw) {
  return (raw || '').trim().replace(/^["']|["']$/g, '').replace(/\\n/g, '').replace(/\n/g, '');
}

// System prompt that makes Groq behave as smart as possible
const SYSTEM_PROMPT = `You are LifeBoard Secretary — a smart, proactive Australian financial assistant.
RULES:
- Keep responses under 80 words, conversational tone, no markdown/bullet points (response is read aloud)
- When user wants to ADD a bill: extract details and include EXACTLY this JSON: \`\`\`json\n{"action":"add","name":"...","amount":number,"dueDate":"YYYY-MM-DD","category":"housing|telecom|transport|utilities|insurance|subscriptions|other","frequency":"weekly|fortnightly|monthly|quarterly|yearly|once"}\n\`\`\`
- When user says they PAID something: \`\`\`json\n{"action":"paid","name":"partial name"}\n\`\`\`
- Understand Australian slang: "five hundred"=500, "a grand"=1000, "fortnightly"=every 2 weeks
- Categories: rent/mortgage=housing, phone/internet=telecom, car/fuel/rego=transport, power/gas/water=utilities, netflix/spotify=subscriptions
- ALWAYS include the JSON block for add/paid actions. The app parses it.`;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    const gk = cleanKey(process.env.GEMINI_API_KEY);
    const groqk = cleanKey(process.env.GROQ_API_KEY);
    return res.status(200).json({
      gemini: gk ? 'configured' : 'missing',
      groq: groqk ? 'configured' : 'missing',
      geminiDown,
      provider: geminiDown ? 'groq (fallback)' : 'gemini (primary)'
    });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Rate limit — 10 req/min per IP
  const ip = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || 'unknown';
  const now = Date.now();
  if (!rateLimitMap.has(ip)) rateLimitMap.set(ip, []);
  const timestamps = rateLimitMap.get(ip).filter(t => t > now - 60000);
  if (timestamps.length >= 10) {
    return res.status(429).json({ error: 'Rate limited. Try again in a minute.' });
  }
  timestamps.push(now);
  rateLimitMap.set(ip, timestamps);

  const { prompt, temperature, maxTokens } = req.body || {};
  if (!prompt || typeof prompt !== 'string' || prompt.length < 2) {
    return res.status(400).json({ error: 'Missing or invalid prompt' });
  }
  if (prompt.length > 10000) {
    return res.status(400).json({ error: 'Prompt too long' });
  }

  const temp = Math.min(Math.max(temperature || 0.3, 0), 1);
  const tokens = Math.min(maxTokens || 500, 2000);
  const geminiKey = cleanKey(process.env.GEMINI_API_KEY);
  const groqKey = cleanKey(process.env.GROQ_API_KEY);

  // Auto-recovery: if Gemini was down, re-check every 2 minutes
  const shouldTryGemini = geminiKey && (!geminiDown || (now - geminiLastCheck > GEMINI_RETRY_MS));

  // 1. Try Gemini (primary — smarter, faster for simple tasks)
  if (shouldTryGemini) {
    try {
      const resp = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + geminiKey,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: temp, maxOutputTokens: tokens }
          })
        }
      );

      if (resp.ok) {
        const data = await resp.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || null;
        if (text) {
          geminiDown = false; // Gemini is back!
          return res.status(200).json({ text, provider: 'gemini' });
        }
      }

      if (resp.status === 429) {
        geminiDown = true;
        geminiLastCheck = now;
        console.warn('Gemini rate limited, switching to Groq. Will retry in 2min.');
      } else if (!resp.ok) {
        const err = await resp.text();
        console.error('Gemini error:', resp.status, err.substring(0, 300));
      }
    } catch (e) {
      console.error('Gemini fetch error:', e.message);
      geminiDown = true;
      geminiLastCheck = now;
    }
  }

  // 2. Fallback: Groq (Llama 3.3 70B) with system prompt for smarter behavior
  if (groqKey) {
    try {
      const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + groqKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: prompt }
          ],
          temperature: temp,
          max_tokens: tokens
        })
      });

      if (resp.ok) {
        const data = await resp.json();
        const text = data.choices?.[0]?.message?.content || null;
        if (text) return res.status(200).json({ text, provider: 'groq' });
      }

      const err = await resp.text();
      console.error('Groq error:', resp.status, err.substring(0, 300));
    } catch (e) {
      console.error('Groq fetch error:', e.message);
    }
  }

  if (!geminiKey && !groqKey) {
    return res.status(500).json({ error: 'No AI keys configured' });
  }
  res.status(502).json({ error: 'AI temporarily unavailable. Try again in a moment.' });
};
