# PIIProtect: The Blind Pipeline — How AI Controls Your Screen Without Seeing Your Secrets

**LifeBoard Security Mentor Doc — 27 March 2026**
**By: LifeBoard DevSecOps Team**

---

## The Problem

When an AI assistant (Claude, GPT, etc.) controls your machine — clicking buttons, filling forms, pasting API keys — every piece of text it processes gets sent to the AI company's servers.

This means if Claude types your Telegram bot token into a form field, **Anthropic can see that token** in the conversation logs.

For LifeBoard — a financial app handling bill data, bank integrations, and notification credentials — this is unacceptable.

## The Solution: Blind Pipeline

A **blind pipeline** ensures secrets flow from source to destination **without ever appearing in the AI's input/output stream**.

### How Data Flows in Claude Code

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│  Your Mac   │────>│  Anthropic   │────>│  Claude AI  │
│  (Bash cmd) │<────│  Servers     │<────│  (Thinking) │
└─────────────┘     └──────────────┘     └─────────────┘
     stdout ──────────> sent to servers ──────> Claude sees it
     (no stdout) ─────> nothing sent ──────> Claude sees nothing
```

**Key insight:** Only the **stdout/stderr** of a bash command is sent to Anthropic. If a command produces zero output, Claude literally cannot see what happened.

### The Blind Pipeline Pattern

```bash
# STEP 1: Read secrets silently (variable assignment = no stdout)
TOKEN=$(grep "API_KEY=" env.txt | cut -d'=' -f2-)
# Result: $TOKEN holds the value, but NOTHING was printed

# STEP 2: Write to disk without printing
node build-bridge.js  # Reads env file, writes HTML — stdout says only "done"

# STEP 3: Open in browser
open -a "Google Chrome" bridge.html  # Browser runs JS locally

# STEP 4: Cleanup
rm -f bridge.html env.txt  # Secrets gone from disk
```

### What Claude Sees

| Step | What happens | Claude sees |
|------|-------------|-------------|
| `TOKEN=$(grep ...)` | Token assigned to bash variable | Nothing (no stdout) |
| `node build-bridge.js` | Script reads file, writes HTML | "Bridge built (42 chars)" |
| `open bridge.html` | Chrome runs JS, sets localStorage | Nothing |
| `rm -f bridge.html` | Files deleted | Nothing |

**At no point does Claude see your actual API key, token, or password.**

## Real Example: LifeBoard Settings Configuration

### What We Needed
- Telegram Bot Token (from @BotFather)
- Telegram Chat ID (your user ID)
- Gemini API Key (from Google AI Studio)
- Email Secret (for Gmail integration)

### Step-by-Step

**1. Pull encrypted values from Vercel (blind)**
```bash
vercel env pull /tmp/env.txt --environment production
# Output: "Created /tmp/env.txt file [305ms]"
# Claude sees: just the success message, not the file contents
```

**2. Build config bridge with Node.js**
```javascript
// /tmp/build-bridge.js
const fs = require('fs');
const envText = fs.readFileSync('/tmp/env.txt', 'utf8');
const env = {};
envText.split('\n').forEach(line => {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2];
});

// Build HTML that sets localStorage
const html = `<script>
localStorage.setItem('lifeboard_telegram', '${escapeForJS(JSON.stringify({
  token: env.TELEGRAM_BOT_TOKEN,
  chatId: env.TELEGRAM_CHAT_ID
}))}');
localStorage.setItem('lifeboard_gemini_key', '${escapeForJS(env.GEMINI_API_KEY)}');
setTimeout(() => location.href = 'index.html', 1500);
</script>`;

fs.writeFileSync('config-bridge.html', html);
console.log('Bridge built'); // ONLY this goes to Claude
```

**3. Open bridge in Chrome**
```bash
open -a "Google Chrome" config-bridge.html
# Chrome loads it → JS runs → localStorage set → redirects to app
```

**4. Cleanup**
```bash
rm -f config-bridge.html /tmp/env.txt /tmp/build-bridge.js
```

### Verification: How Do We Know It Worked?

1. **Check lengths, not values:** `echo "${#TOKEN} chars"` → shows "46 chars" without showing the token
2. **Screenshot the masked fields:** The Settings page shows `•••••••••` for the Gemini key — confirming it's stored but not visible
3. **Test the integration:** Click "Test Notification" — if Telegram receives the message, the token is correct

## PIIProtect Hook: The Last Line of Defense

Even if a developer accidentally `echo`s a secret, the PIIProtect hook catches it:

```javascript
// ~/.claude/hooks/computer-use-guardrail.js
// Runs BEFORE every tool use

// 1. Blocks screencapture when sensitive apps are in foreground
//    (Keychain, 1Password, banking apps)

// 2. Detects sensitive patterns in typed input
//    (sk-, pk-, JWT tokens, private keys)

// 3. Prevents Claude from viewing password managers
```

### Three Layers of Protection

```
Layer 1: BLIND PIPELINE
├── No echo, no cat, no Read on secret files
├── Variable assignment (no stdout)
└── Pipe directly to destination

Layer 2: COMPUTER-USE GUARDRAIL HOOK
├── Blocks screencapture on sensitive apps
├── Detects secret patterns in typed text
└── Prevents keystroke logging on password fields

Layer 3: PRIVACY RULES (CLAUDE.md)
├── "NEVER read .env files with real credentials"
├── "NEVER include sensitive data in prompts"
└── "If file contains secrets, acknowledge but DO NOT read"
```

## For PIIProtect Customers

This pattern can be packaged as a **PIIProtect SDK** for any AI-assisted workflow:

```javascript
const pii = require('@piiprotect/blind-pipeline');

// Wraps any AI tool call in a blind pipeline
await pii.blindExec({
  source: 'vault://my-api-key',     // Where the secret lives
  destination: 'localStorage',       // Where it needs to go
  field: 'myapp_api_key',           // The key name
  ai: 'claude',                     // Which AI is controlling
  audit: true                       // Log the operation (not the value)
});

// Claude sees: "piiprotect: 1 secret transferred (46 chars, sha256: a1b2c3...)"
// Claude does NOT see: the actual API key
```

### Business Value

- **Compliance:** GDPR, CCPA, SOC2 — prove that AI assistants never access PII
- **Audit trail:** Every blind pipeline operation is logged with hash + timestamp
- **Zero trust:** Even if the AI is compromised, it physically cannot leak secrets it never saw
- **Universal:** Works with any AI (Claude, GPT, Gemini, Copilot)

## Key Takeaways

1. **stdout = visible to AI.** No stdout = invisible to AI.
2. **Variable assignment** (`X=$(...)`) produces zero stdout — the safest way to handle secrets
3. **Bridge files** on disk are temporary — write, execute, delete
4. **Verify by length/hash**, never by printing the value
5. **Three layers:** blind pipeline + guardrail hook + policy rules
6. **This is a sellable product.** No one else does AI-controlled secret handling this way.

---

*Built during LifeBoard DevSecOps audit, 27 March 2026*
*Proven working: Configured 4 secrets via Claude computer-use with zero leakage*
