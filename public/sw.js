/**
 * LifeBoard — Service Worker
 *
 * Provides background bill checking and Telegram notifications
 * even when the browser tab is closed (as long as the browser process
 * is running). Uses periodic background sync where supported,
 * with a fallback interval when the page is open.
 *
 * Bills and Telegram settings are stored in IndexedDB, synced
 * from the main thread via postMessage.
 */

const CACHE_NAME = 'lifeboard-v2';
const DB_NAME = 'lifeboard-sw';
const DB_VERSION = 1;
const STORE_BILLS = 'bills';
const STORE_CONFIG = 'config';
const STORE_SENT = 'sent';
const CHECK_TAG = 'lifeboard-bill-check';

// ============================================================
// IndexedDB helpers
// ============================================================
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_BILLS)) {
        db.createObjectStore(STORE_BILLS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_CONFIG)) {
        db.createObjectStore(STORE_CONFIG, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(STORE_SENT)) {
        db.createObjectStore(STORE_SENT, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbGetAll(db, storeName) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbGet(db, storeName, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbPut(db, storeName, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const req = store.put(value);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbClear(db, storeName) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const req = store.clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// ============================================================
// Bill checking logic (mirrors client-side secretary)
// ============================================================
function daysDiff(dateStr) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(dateStr);
  due.setHours(0, 0, 0, 0);
  return Math.round((due - today) / (1000 * 60 * 60 * 24));
}

function countdownText(days) {
  if (days < 0) return `${Math.abs(days)}d overdue`;
  if (days === 0) return 'Due today';
  if (days === 1) return 'Tomorrow';
  return `${days}d`;
}

function formatDateShort(dateStr) {
  return new Date(dateStr).toLocaleDateString('en-AU', {
    day: 'numeric',
    month: 'short',
  });
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
}

async function checkBills() {
  let db;
  try {
    db = await openDB();
  } catch {
    return;
  }

  const bills = await dbGetAll(db, STORE_BILLS);
  const configRow = await dbGet(db, STORE_CONFIG, 'telegram');
  const tg = configRow ? configRow.value : null;

  if (!bills.length) return;

  const pending = bills.filter((b) => b.status !== 'paid');
  const today = new Date().toISOString().split('T')[0];
  const thresholds = [7, 3, 1, 0];
  let alertCount = 0;

  for (const bill of pending) {
    const days = daysDiff(bill.dueDate);

    for (const t of thresholds) {
      if (days === t || (days < 0 && t === 0)) {
        const sentKey = `${bill.id}_${t}_${today}`;
        const existing = await dbGet(db, STORE_SENT, sentKey);
        if (existing) continue;

        let urgency = 'REMINDER';
        if (days <= 0) urgency = 'URGENT';
        else if (days <= 1) urgency = 'TOMORROW';
        else if (days <= 3) urgency = 'SOON';

        // Browser push notification
        try {
          await self.registration.showNotification(`LifeBoard: ${bill.name}`, {
            body: `$${bill.amount.toFixed(2)} — ${countdownText(days)}`,
            icon: '/icon-192.png',
            badge: '/icon-192.png',
            tag: `bill-${bill.id}-${t}`,
            data: { billId: bill.id },
            vibrate: [200, 100, 200],
          });
        } catch {
          // Notification permission may not be granted
        }

        // Telegram notification
        if (tg && tg.token && tg.chatId) {
          const message = [
            `<b>${urgency === 'URGENT' ? '🚨' : urgency === 'TOMORROW' ? '⏰' : urgency === 'SOON' ? '⚡' : '🔔'} PAYMENT ${urgency}</b>`,
            ``,
            `<b>${bill.name}</b> — $${bill.amount.toFixed(2)}`,
            `Due: ${formatDateShort(bill.dueDate)} (${countdownText(days)})`,
            ``,
            `— LifeBoard Secretary`,
          ].join('\n');

          try {
            await sendTelegram(tg.token, tg.chatId, message);
          } catch {
            // Telegram failed — notification still shown locally
          }
        }

        await dbPut(db, STORE_SENT, { key: sentKey, date: today });
        alertCount++;
        break;
      }
    }
  }

  // Notify the main thread about check completion
  const clients = await self.clients.matchAll({ type: 'window' });
  for (const client of clients) {
    client.postMessage({
      type: 'BILL_CHECK_COMPLETE',
      alertCount,
      timestamp: new Date().toISOString(),
    });
  }
}

// ============================================================
// Service Worker lifecycle
// ============================================================
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    }).then(() => self.clients.claim())
  );
});

// ============================================================
// Periodic Background Sync (Chrome 80+)
// Fires even when all tabs are closed, as long as the browser
// is running and the site has sufficient engagement score.
// ============================================================
self.addEventListener('periodicsync', (event) => {
  if (event.tag === CHECK_TAG) {
    event.waitUntil(checkBills());
  }
});

// ============================================================
// Push notifications (for future FCM integration)
// ============================================================
self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : {};
  event.waitUntil(
    self.registration.showNotification(data.title || 'LifeBoard', {
      body: data.body || 'Payment reminder',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: data.payload || {},
    })
  );
});

// ============================================================
// Notification click — open the app
// ============================================================
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      // Focus existing tab if open
      for (const client of clients) {
        if (client.url.includes('/') && 'focus' in client) {
          return client.focus();
        }
      }
      // Otherwise open a new tab
      return self.clients.openWindow('/');
    })
  );
});

// ============================================================
// Message handler — receives bills data from main thread
// ============================================================
self.addEventListener('message', (event) => {
  const { type, bills, telegram } = event.data || {};

  if (type === 'SYNC_BILLS') {
    event.waitUntil(
      (async () => {
        const db = await openDB();
        await dbClear(db, STORE_BILLS);
        for (const bill of bills || []) {
          await dbPut(db, STORE_BILLS, bill);
        }
        if (telegram) {
          await dbPut(db, STORE_CONFIG, { key: 'telegram', value: telegram });
        }
      })()
    );
  }

  if (type === 'RUN_CHECK') {
    event.waitUntil(checkBills());
  }
});
