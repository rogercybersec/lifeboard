// LifeBoard — Client config endpoint
// Returns Telegram + email config for localStorage auto-setup
// Gemini key is NOT returned — it stays server-side (proxied via /api/gemini)

module.exports = (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const config = {};

  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    config.telegram = JSON.stringify({
      token: process.env.TELEGRAM_BOT_TOKEN,
      chatId: process.env.TELEGRAM_CHAT_ID
    });
  }
  if (process.env.LIFEBOARD_EMAIL_SECRET) {
    config.emailSecret = process.env.LIFEBOARD_EMAIL_SECRET;
  }

  // Signal that Gemini is available via proxy (key never leaves server)
  config.geminiProxy = !!process.env.GEMINI_API_KEY;

  res.status(200).json(config);
};
