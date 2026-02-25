/**
 * service-worker.js
 * Handles background Web Push notifications for the Daily Planner PWA.
 * Receives push events from the server and shows browser notifications
 * even when the app tab is closed.
 */

const CACHE_NAME = 'daily-planner-v1';

// ─── Install: skip waiting so new SW activates immediately ──────────────────
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// ─── Push event: show notification ──────────────────────────────────────────
self.addEventListener('push', (e) => {
  let data = { title: '📅 Daily Planner', body: 'You have a new alert.', tag: 'planner' };
  try {
    if (e.data) data = { ...data, ...e.data.json() };
  } catch (_) {}

  e.waitUntil(
    self.registration.showNotification(data.title, {
      body:    data.body,
      icon:    '/icons/icon-192.png',
      badge:   '/icons/badge-72.png',
      tag:     data.tag ?? 'planner',
      renotify: true,
      vibrate: [200, 100, 200],
      data:    { url: data.url ?? '/' },
    })
  );
});

// ─── Notification click: focus or open the app ──────────────────────────────
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = e.notification.data?.url ?? '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    })
  );
});
