# LifeBoard — Lessons Learned

Every mistake made during development, what caused it, and how to prevent it next time.

---

## 1. `env(safe-area-inset-top)` Unreliable in Standalone Mode

- **Problem:** Header content rendered behind the iOS status bar. `env(safe-area-inset-top)` returned 0 even on notched iPhones.
- **Root Cause:** `env()` values are inconsistent in iOS standalone/PWA mode. They sometimes fail to populate on initial load, or get overridden by framework CSS.
- **Fix:** JavaScript detection of standalone mode (`window.navigator.standalone === true || matchMedia('(display-mode: standalone)')`) then inject `padding-top: 47px !important` via a dynamically created `<style>` tag.
- **Prevention:** Never rely solely on `env(safe-area-inset-top)` for critical layout. Always pair it with JS-based standalone detection as a fallback. Test on a real iPhone in Home Screen mode, not just Safari.

---

## 2. `black-translucent` Status Bar Causes Content Overlap

- **Problem:** App content rendered behind the status bar — clock, battery, and signal icons overlapped the app header. Close buttons were unreachable.
- **Root Cause:** `<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">` makes the status bar transparent and pushes your content behind it. The CSS `env()` fallback that was supposed to compensate didn't fire (see lesson #1).
- **Fix:** Changed to `content="default"`. Content now starts below the status bar automatically.
- **Prevention:** Use `default` unless you have a specific full-bleed design AND have bulletproof JS-based padding in place. Never use `black-translucent` as a "looks cool" choice.

---

## 3. Transparent Modal Background Looks Broken on Mobile

- **Problem:** Modal backgrounds using `rgba(26, 29, 36, 0.95)` showed content bleeding through. On iPhone with status bar and scrolling content behind, the modal looked muddy and unfinished.
- **Root Cause:** Even 5% transparency is visible on mobile screens, especially with bright or varied content scrolling behind the modal. The slight see-through effect that looks "sleek" on desktop looks like a bug on mobile.
- **Fix:** Changed modal background to solid `#1a1d24`. No transparency.
- **Prevention:** All modals on mobile use solid backgrounds. Transparency is only for the overlay behind the modal (`rgba(0,0,0,0.5)`), never for the modal panel itself.

---

## 4. Modal Centered Instead of Bottom-Aligned

- **Problem:** Modals appeared floating in the center of the screen, looking like a desktop dialog on a tiny mobile screen. Felt wrong compared to native apps.
- **Root Cause:** Default `align-items: center` on the flex overlay container. Standard web pattern, wrong for mobile.
- **Fix:** Changed overlay to `align-items: flex-end` and modal to `border-radius: 16px 16px 0 0` (rounded top corners, flat bottom). Modal now slides up from the bottom like Uber/Revolut/Apple Pay.
- **Prevention:** All mobile modals use the slide-up-from-bottom pattern. Never center-float a modal on a phone screen.

---

## 5. Form Stacking / Layout Broken When Keyboard Opens

- **Problem:** When tapping an input field, the iOS keyboard pushed elements around. Fixed-position elements jumped. The layout broke visually.
- **Root Cause:** iOS handles keyboard appearance by resizing the viewport. Fixed-position elements reposition relative to the new viewport. Inputs inside scrollable containers can get pushed off-screen.
- **Fix:** Used `position: sticky` instead of `position: fixed` for in-form elements. Ensured the form container is scrollable. Added `padding-bottom` to account for keyboard height.
- **Prevention:** Never use `position: fixed` on elements that need to be visible during text input. Use scrollable containers. Test every form by actually typing on a real iPhone.

---

## 6. iOS Safari Auto-Zoom on Form Inputs

- **Problem:** Tapping any input field caused Safari to zoom into the input. User had to pinch-zoom back out. App felt broken and amateur.
- **Root Cause:** iOS Safari auto-zooms any input with `font-size` less than 16px. The design system used 14px for inputs.
- **Fix:** Set all `input`, `select`, and `textarea` elements to `font-size: 16px` minimum.
- **Prevention:** Global CSS rule: `input, select, textarea { font-size: 16px; }`. Add to base styles. Never override below 16px.

---

## 7. Config-Bridge: localStorage Not Available Cross-Device

- **Problem:** API keys and config stored in localStorage on the development machine were not available when the app was accessed from a phone. App launched with empty/broken state.
- **Root Cause:** localStorage is per-origin. `http://localhost:3000` and `https://lifeboard.app` are completely separate storage spaces. `file://` is yet another. No cross-origin or cross-device sync exists.
- **Fix:** Implemented a config-bridge pattern — server-side `/api/config` endpoint that returns necessary config values, which the client stores in its own localStorage on first load.
- **Prevention:** Never assume localStorage values will "just be there" on a different device or origin. Always have a bootstrap/config-bridge mechanism. Document which localStorage keys the app depends on and how they get populated.

---

## 8. Service Worker Caching Old Versions

- **Problem:** After deploying a new version, users kept seeing the old version. Hard refresh didn't help. Even closing and reopening the PWA didn't help.
- **Root Cause:** The service worker cached all assets and served them from cache indefinitely. No cache-busting strategy. The old service worker stayed active because `skipWaiting()` wasn't called.
- **Fix:** Added `CACHE_VERSION` constant that changes on every deploy. Service worker calls `self.skipWaiting()` on install and `self.clients.claim()` on activate. Old caches are deleted during activation. Client-side code checks for updates every 60 seconds and reloads when a new service worker activates.
- **Prevention:** Every service worker MUST have: (1) a version string that changes per deploy, (2) `skipWaiting()` + `clients.claim()`, (3) old cache cleanup in the activate handler, (4) client-side update polling.

---

## 9. Double-Tap Zoom Delay Making App Feel Slow

- **Problem:** Buttons and interactive elements had a noticeable delay (~300ms) between tap and response. App felt sluggish compared to native.
- **Root Cause:** iOS waits 300ms after a tap to determine if the user is double-tapping to zoom. Without `touch-action: manipulation`, every tap incurs this delay.
- **Fix:** Added `touch-action: manipulation` to all elements via `* { touch-action: manipulation; }`.
- **Prevention:** Add this to the global CSS reset for any PWA project. No exceptions.

---

## 10. Text Size Auto-Adjustment Breaking Layout

- **Problem:** Text appeared larger than expected on certain screens, breaking carefully designed layouts. Font sizes didn't match what was specified in CSS.
- **Root Cause:** iOS Safari's text size adjustment feature (`-webkit-text-size-adjust`) was "helping" by enlarging text it thought was too small for the viewport.
- **Fix:** Added `html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }`.
- **Prevention:** Include in global CSS reset for all mobile projects.

---

## 11. Two Home Screen Icons = Two Separate Apps

- **Problem:** User added the PWA from both Safari and Chrome (or added twice from Safari). Two icons appeared on Home Screen, each with its own completely separate localStorage, service worker, and state.
- **Root Cause:** Each "Add to Home Screen" action creates an independent app instance. iOS has no mechanism to detect or prevent duplicates.
- **Fix:** Added detection: when running in browser mode, check if a `pwa-installed` cookie exists and show a banner directing user to the existing Home Screen icon. When running in standalone mode, set the cookie.
- **Prevention:** Guide users to add from Safari only. Detect and warn about duplicates. Accept that this is an iOS limitation with no perfect solution.

---

## 12. Missing `viewport-fit=cover` Made Safe Areas Return Zero

- **Problem:** All `env(safe-area-inset-*)` values returned 0px. Notch and home indicator were not accounted for.
- **Root Cause:** Without `viewport-fit=cover` in the viewport meta tag, iOS renders the page in a "safe" rectangle that avoids the notch/home indicator entirely. The `env()` values are all 0 because iOS is already handling the insets by shrinking your viewport.
- **Fix:** Added `viewport-fit=cover` to the viewport meta tag. App now renders edge-to-edge and `env()` values populate correctly.
- **Prevention:** Always include `viewport-fit=cover` in the viewport meta tag for any PWA that needs to handle safe areas. It's the prerequisite for `env()` to work.

---

## Quick Reference: The Checklist

Before shipping any LifeBoard update to production:

1. `viewport-fit=cover` in meta tag
2. `apple-mobile-web-app-status-bar-style` set to `default`
3. JS standalone detection with `!important` padding injection
4. All form inputs at 16px font-size minimum
5. `touch-action: manipulation` globally
6. `-webkit-text-size-adjust: 100%` globally
7. Modals: solid background, bottom-aligned, rounded top corners
8. Bottom tab bar: `env(safe-area-inset-bottom)` padding
9. Service worker: versioned cache, `skipWaiting`, `clients.claim`
10. Config-bridge for any localStorage-dependent values
11. Test on real iPhone in standalone mode
12. Check for duplicate icon guidance
