# Building a Proper iPhone PWA — The Hard Way (So You Don't Have To)

**Episode: "Why Does My App Look Broken on iPhone?"**

---

## The Setup

You built a web app. It looks great in Chrome DevTools mobile simulator. You deploy it, add it to your iPhone Home Screen, tap it... and it looks like garbage. The status bar overlaps your header. The bottom tab bar sits on top of the home indicator. Modals have a weird transparent background. Forms zoom in when you tap them.

Welcome to iOS PWA development. None of this is documented well. You learn it by shipping broken things and fixing them at 2am.

This doc is everything I learned building LifeBoard as a proper iPhone PWA. Every section is a real problem that happened, not theoretical.

---

## 1. The Viewport Meta Tag — Get This Right First

```html
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
```

Every single property matters:

- **`width=device-width`** — match the phone's screen width, not some arbitrary 980px default
- **`initial-scale=1.0`** — start at 1:1 zoom
- **`maximum-scale=1.0`** — prevent pinch zoom (you want this for an app-like experience)
- **`user-scalable=no`** — belt and suspenders with maximum-scale
- **`viewport-fit=cover`** — THIS IS THE BIG ONE. Without it, iOS adds white bars around your app to avoid the notch and home indicator. With it, your app goes edge-to-edge, and YOU control the safe areas.

If you forget `viewport-fit=cover`, none of the `env(safe-area-inset-*)` values will work. They'll all return 0. You'll spend an hour debugging CSS when the problem is in your HTML head.

---

## 2. The Status Bar Trap: `apple-mobile-web-app-status-bar-style`

```html
<meta name="apple-mobile-web-app-status-bar-style" content="default">
```

Three options. Only one is safe for most apps:

### `default`
- White/light status bar area
- Your content starts BELOW the status bar
- Safest option. Predictable behavior.

### `black`
- Black status bar area
- Your content still starts BELOW the status bar
- Fine if your header is dark anyway

### `black-translucent`
- Status bar becomes transparent
- Your content renders BEHIND the status bar
- The clock, battery, signal icons float on top of YOUR content

**The trap:** `black-translucent` sounds cool — "my app goes full edge-to-edge!" But what actually happens is your header text sits behind the status bar text. Your close buttons are unreachable. Everything at the top of your app is broken.

If you use `black-translucent`, you MUST add padding-top equal to the status bar height on every screen. And that height varies by device. And `env(safe-area-inset-top)` is supposed to handle it but... read the next section.

**Rule: Use `default` unless you have a specific reason not to.** If you want a colored status bar area, set your `<meta name="theme-color">` and use `default`.

---

## 3. The Safe Area Problem — Why `env()` Isn't Enough

In theory, this should work:

```css
.header {
  padding-top: env(safe-area-inset-top, 20px);
}
```

In practice, on iOS Safari in standalone mode (added to Home Screen), `env(safe-area-inset-top)` sometimes returns 0 even when there IS a notch. Or it returns the right value but your CSS specificity gets overridden. Or it works on first load but not after navigation.

### The Bulletproof Fix: JavaScript Detection

```javascript
function isStandalonePWA() {
  return (
    window.navigator.standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches
  );
}

if (isStandalonePWA()) {
  document.documentElement.style.setProperty('--safe-top', '47px');
  // Or inject a style tag:
  const style = document.createElement('style');
  style.textContent = `
    .app-header {
      padding-top: 47px !important;
    }
    .modal-overlay {
      padding-top: 47px !important;
    }
  `;
  document.head.appendChild(style);
}
```

Why this works:
- `window.navigator.standalone` is iOS Safari's proprietary flag — `true` when launched from Home Screen
- `matchMedia('(display-mode: standalone)')` is the standard way, works on Android too
- Injecting styles with `!important` guarantees they win over any framework CSS
- You hardcode the value (47px for modern iPhones with notch) because you KNOW the device has a notch if it's running standalone

**The 47px number:** Modern iPhones (X and later) have a 47px status bar area. Older iPhones (8 and earlier) have 20px. If you need to support both, you can check `screen.height` or just use `env(safe-area-inset-top, 47px)` as a fallback chain — but the JS injection is what makes it reliable.

---

## 4. Bottom Tab Bar — The Uber/Revolut/Wise Pattern

Every fintech and ride-sharing app has this: a fixed bottom navigation bar with 3-5 icons.

```css
.bottom-tab-bar {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  display: flex;
  justify-content: space-around;
  align-items: center;
  height: 56px;
  padding-bottom: env(safe-area-inset-bottom, 0px);
  background: #1a1d24;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  z-index: 100;
}
```

Key details:

- **`padding-bottom: env(safe-area-inset-bottom)`** — on iPhones with the home indicator (the little white bar at the bottom), this adds ~34px of padding so your tab icons don't sit on top of the gesture area. This one actually works reliably, unlike the top inset.
- **Fixed height of 56px** — this is the standard. Uber uses 56px. Revolut uses 56px. Don't go smaller (tap targets too small) or bigger (wastes screen space).
- **Solid background, not transparent** — you need content to scroll behind it without showing through.
- **`z-index: 100`** — high enough to stay on top of everything except modals.

Don't forget to add bottom padding to your main content area so the last items aren't hidden behind the tab bar:

```css
.main-content {
  padding-bottom: calc(56px + env(safe-area-inset-bottom, 0px) + 16px);
}
```

---

## 5. Modal Slide-Up Pattern — Mobile Done Right

Desktop modals float in the center of the screen. Mobile modals slide up from the bottom. Every major app does this — Apple Pay, Uber destination picker, Revolut transaction details.

```css
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: flex-end;  /* THIS is the key — pushes modal to bottom */
  justify-content: center;
  z-index: 200;
}

.modal-content {
  width: 100%;
  max-height: 85vh;
  background: #1a1d24;  /* SOLID — never transparent */
  border-radius: 16px 16px 0 0;
  padding: 24px;
  padding-bottom: calc(24px + env(safe-area-inset-bottom, 0px));
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
}
```

### The Mistakes I Made (So You Don't):

**Mistake 1: Transparent modal background.** I used `rgba(26, 29, 36, 0.95)` thinking the slight transparency looked slick. On iPhone, with the status bar and content scrolling behind it, it looked muddy and broken. **Use solid colors.** `#1a1d24`, not `rgba()`.

**Mistake 2: `align-items: center` on the overlay.** Modal floated in the middle of the screen like a desktop dialog. On a 390px-wide phone screen, it looked ridiculous. `align-items: flex-end` pins it to the bottom where mobile users expect it.

**Mistake 3: Forgetting the bottom safe area.** The modal's bottom padding needs to account for the home indicator, or your last button/field sits right on the gesture bar.

**Mistake 4: No `-webkit-overflow-scrolling: touch`.** Without this, scrolling inside the modal feels janky on iOS — no momentum, no rubber-banding.

---

## 6. Form Inputs: The 16px Rule

This one will waste an hour of your life if you don't know it:

**On iOS Safari, if a form input has a font-size smaller than 16px, Safari will auto-zoom into the input when the user taps it.**

The zoom is jarring, the user has to pinch to zoom back out, and your layout is now broken.

```css
/* BAD — Safari will zoom */
input, select, textarea {
  font-size: 14px;
}

/* GOOD — no zoom */
input, select, textarea {
  font-size: 16px;
}
```

This applies to `<input>`, `<textarea>`, `<select>`, and any element with `contenteditable`. 16px minimum. Not 15px. Not 15.9px. **16px.**

If your design system uses 14px for inputs, you have two choices:
1. Change the design system (recommended)
2. Use `maximum-scale=1.0` in your viewport meta (which you already should have)

Even with `maximum-scale=1.0`, some iOS versions still zoom. Just use 16px.

---

## 7. Touch Behavior Fixes

### Prevent Double-Tap Zoom

```css
* {
  touch-action: manipulation;
}
```

Without this, iOS waits 300ms after a tap to see if you're going to double-tap. Your app feels sluggish. `touch-action: manipulation` tells the browser "this element only needs pan and pinch, no double-tap" — so taps fire immediately.

Apply it to everything (`*`). There's no downside for an app-like PWA.

### Prevent Text Size Adjustments

```css
html {
  -webkit-text-size-adjust: 100%;
  text-size-adjust: 100%;
}
```

iOS Safari tries to "help" by auto-adjusting text sizes when it thinks the layout is too narrow. This breaks your carefully designed type scale. `100%` means "don't adjust anything, I know what I'm doing."

### Prevent Pull-to-Refresh (Optional)

```css
body {
  overscroll-behavior-y: none;
}
```

In a PWA, pull-to-refresh usually just reloads your app and loses state. Disable it unless you've built custom pull-to-refresh.

---

## 8. Service Worker Auto-Update Pattern

The biggest PWA footgun: you deploy a new version, but users keep seeing the old one because the service worker cached everything.

### The Pattern That Works

```javascript
// In your service worker (sw.js):
const CACHE_VERSION = 'v1.2.3'; // Change this on every deploy

self.addEventListener('install', (event) => {
  // Skip waiting immediately — don't wait for old tabs to close
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => {
      return cache.addAll([
        '/',
        '/index.html',
        '/app.js',
        '/styles.css'
      ]);
    })
  );
});

self.addEventListener('activate', (event) => {
  // Delete ALL old caches
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_VERSION)
            .map((key) => caches.delete(key))
      );
    }).then(() => {
      // Take control of all tabs immediately
      return self.clients.claim();
    })
  );
});
```

```javascript
// In your main app code:
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').then((reg) => {
    // Check for updates every 60 seconds
    setInterval(() => reg.update(), 60000);

    reg.addEventListener('updatefound', () => {
      const newWorker = reg.installing;
      newWorker.addEventListener('statechange', () => {
        if (newWorker.state === 'activated') {
          // New version is active — reload to get fresh content
          window.location.reload();
        }
      });
    });
  });
}
```

The key insight: `skipWaiting()` + `clients.claim()` together mean the new service worker takes over immediately. No "close all tabs and reopen" nonsense.

**For development:** Add a cache-busting query parameter to your script tags (`app.js?v=1.2.3`) or use a build tool that hashes filenames.

---

## 9. localStorage Is Per-Origin

This catches everyone once:

- `https://lifeboard.app` has its own localStorage
- `http://lifeboard.app` has its own localStorage (different!)
- `file:///Users/roger/lifeboard/index.html` has its own localStorage
- `http://localhost:3000` has its own localStorage

If you develop on `localhost:3000` and set localStorage values, then deploy to `lifeboard.app`, those values don't exist. Your users open the app and it's blank.

This matters for:
- API keys stored in localStorage
- User preferences
- Auth tokens
- Any "remember me" state

Each origin is a completely isolated world. There is no cross-origin localStorage access (and there shouldn't be, for security).

---

## 10. The Config-Bridge Pattern

Problem: You have secrets (API keys, tokens) that your client-side app needs, but you can't hardcode them in your JavaScript (they'd be visible in source). And you can't use a `.env` file because the browser can't read the filesystem.

Solution: A config-bridge — a small server endpoint or build step that injects secrets into the browser's localStorage.

### Pattern 1: API Endpoint Bridge

```javascript
// Server-side: /api/config (protected by auth)
app.get('/api/config', requireAuth, (req, res) => {
  res.json({
    apiKey: process.env.GEMINI_API_KEY,
    features: process.env.FEATURE_FLAGS
  });
});

// Client-side: on app startup
async function loadConfig() {
  const stored = localStorage.getItem('app-config');
  if (stored) return JSON.parse(stored);

  const res = await fetch('/api/config');
  const config = await res.json();
  localStorage.setItem('app-config', JSON.stringify(config));
  return config;
}
```

### Pattern 2: Build-Time Injection

```javascript
// During build, your bundler replaces process.env references:
const CONFIG = {
  apiKey: process.env.GEMINI_API_KEY,  // replaced at build time
};

// On first run, store in localStorage for offline access:
if (!localStorage.getItem('app-config')) {
  localStorage.setItem('app-config', JSON.stringify(CONFIG));
}
```

### Pattern 3: QR Code / Deep Link Bridge (Cross-Device)

For transferring config from one device to another (like from your laptop to your phone):

```javascript
// On laptop: generate a one-time URL with encrypted config
const configToken = encrypt(JSON.stringify(config), oneTimeKey);
const url = `https://yourapp.com/bridge?token=${configToken}`;
// Show as QR code

// On phone: scan QR, app reads token, decrypts, stores in localStorage
const params = new URLSearchParams(location.search);
const config = decrypt(params.get('token'), oneTimeKey);
localStorage.setItem('app-config', JSON.stringify(config));
```

The point: localStorage doesn't sync between devices or origins. You need a bridge mechanism to get data in there, and the bridge must be secure.

---

## 11. The Two Icons Problem

When a user adds your PWA to their Home Screen, iOS creates an icon. But:

- If they add it from **Safari** AND **Chrome**, they get TWO icons — each is a separate "app" with separate localStorage, separate service workers, separate everything
- If they add it **twice from Safari** (maybe they forgot they already did), same problem — two icons, two separate instances
- If you change your `manifest.json` icon or name, existing Home Screen icons DON'T update

### What Happens

User adds from Safari: Icon A, with localStorage A.
User adds from Chrome: Icon B, with localStorage B.
User sets up their preferences in A. Opens B. Empty. Confused. Angry.

### Prevention

1. **Detect standalone mode and show a "You're already using the app" message** if they visit your site in a browser while the PWA is installed:

```javascript
if (window.matchMedia('(display-mode: browser)').matches) {
  // They're in a regular browser tab
  if (document.cookie.includes('pwa-installed=true')) {
    showBanner("You already have this app installed! Use the Home Screen icon.");
  }
}

// When running as PWA, set the cookie
if (isStandalonePWA()) {
  document.cookie = 'pwa-installed=true; max-age=31536000';
}
```

2. **Use your manifest.json `name` and `short_name` consistently** — if users see the same name on both icons, they'll know to delete one.

3. **Document it for your users** — "Add to Home Screen from Safari only. If you see two icons, delete one."

There's no programmatic way to prevent a user from adding your app twice. You can only detect and guide.

---

## Summary: The iPhone PWA Checklist

```
[ ] viewport meta: width=device-width, initial-scale=1.0, maximum-scale=1.0,
    user-scalable=no, viewport-fit=cover
[ ] apple-mobile-web-app-status-bar-style: default (not black-translucent)
[ ] JS detection for standalone mode → inject safe-area padding with !important
[ ] Bottom tab bar: fixed, 56px height, env(safe-area-inset-bottom) padding
[ ] Modals: align-items: flex-end, solid background, 16px 16px 0 0 radius
[ ] All form inputs: font-size 16px minimum
[ ] touch-action: manipulation on all elements
[ ] -webkit-text-size-adjust: 100%
[ ] Service worker: skipWaiting + clients.claim + version-based cache busting
[ ] Config bridge for secrets → localStorage
[ ] Test on ACTUAL iPhone, not just simulator
[ ] Test in standalone mode (Home Screen), not just Safari
```

Every item on this list is something that broke in production and had to be fixed. Don't skip any of them.
