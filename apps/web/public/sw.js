/*
 * Pergola's service worker.
 *
 * It does one job: show a push, and take whoever taps it to the card it is
 * about. It caches nothing on purpose — the board is live data, and an app
 * shell served stale from a cache is worse than a moment's spinner.
 */

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }

  event.waitUntil(
    (async () => {
      await self.registration.showNotification(data.title || "Pergola", {
        body: data.body || "",
        tag: data.tag,
        // One tag per card keeps the tray tidy, but a new message under the
        // same tag must still buzz, or it arrives in silence.
        renotify: Boolean(data.tag),
        icon: "/icon-192.png",
        badge: "/badge-96.png",
        data: { url: data.url || "/" },
      });
      // An open Pergola updates its bell now rather than on its next poll.
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const w of windows) w.postMessage({ type: "pergola:notification" });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || "/", self.location.origin);

  event.waitUntil(
    (async () => {
      // Reuse a window that is already open instead of stacking up tabs.
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const open = windows.find((w) => new URL(w.url).origin === url.origin);
      if (open) {
        open.postMessage({ type: "pergola:open", url: url.pathname + url.search });
        return open.focus();
      }
      return self.clients.openWindow(url.href);
    })(),
  );
});

/*
 * The push service rotated this browser's subscription. Hand the new one to
 * the server, or pushes to this device stop with nobody the wiser.
 */
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      const { key } = await (await fetch("/api/push/key")).json();
      const sub = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: key,
      });
      await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(sub.toJSON()),
      });
    })(),
  );
});
