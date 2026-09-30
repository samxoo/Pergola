/**
 * Push notifications for this browser: on, off, and whether it can at all.
 *
 * The permission is the browser's and the subscription is this device's; the
 * server only keeps the address to send to. So "on" means all three agree, and
 * anything short of that reads as off, with one tap to fix it.
 */

export type PushState =
  /** No service worker or push here — an iPhone outside the home screen, say. */
  | "unsupported"
  /** The person said no, and only the browser's site settings can undo that. */
  | "denied"
  | "off"
  | "on";

const supported = () =>
  "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

/** iOS allows push only to a web app opened from the home screen. */
export const isIosBrowser = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) &&
  !(navigator as { standalone?: boolean }).standalone;

/**
 * Register the worker on every visit, push or no push: it is what turns a tap
 * on a notification into the right card in a window that is already open.
 */
export function registerWorker(): void {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("/sw.js").catch((err: unknown) => {
    console.warn("[push] service worker not registered:", err);
  });
}

async function subscription(): Promise<PushSubscription | null> {
  const reg = await navigator.serviceWorker.getRegistration();
  return (await reg?.pushManager.getSubscription()) ?? null;
}

export async function pushState(): Promise<PushState> {
  if (!supported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  if (Notification.permission !== "granted") return "off";
  return (await subscription()) ? "on" : "off";
}

const tell = (sub: PushSubscription) =>
  fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(sub.toJSON()),
  });

/** The server's key, as the bytes `subscribe` wants. */
async function serverKey(): Promise<Uint8Array<ArrayBuffer>> {
  const { key } = (await (await fetch("/api/push/key")).json()) as { key: string };
  const b64 = key.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(key.length / 4) * 4, "=");
  return Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
}

const sameKey = (a: ArrayBuffer | null, b: Uint8Array) =>
  a !== null && a.byteLength === b.byteLength && new Uint8Array(a).every((x, i) => x === b[i]);

/**
 * Ask, subscribe, and hand the address to the server. Call from a tap.
 *
 * Then the server sends `confirmation` to this device, so the person sees push
 * work end to end. If that fails the subscription stays — pressing again
 * retries — but the error says so rather than leaving a switch that lies.
 */
export async function enablePush(confirmation: { title: string; body: string }): Promise<PushState> {
  if (!supported()) return "unsupported";
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return permission === "denied" ? "denied" : "off";

  const reg = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
  const key = await serverKey();

  // A subscription made against another key (a reset database, say) cannot be
  // sent to, and the browser refuses a second one until the first is gone.
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub.options.applicationServerKey, key)) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });

  const res = await tell(sub);
  if (!res.ok) {
    await sub.unsubscribe();
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message ?? "The server did not accept this browser for notifications");
  }

  const test = await fetch("/api/push/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpoint: sub.endpoint, ...confirmation }),
  });
  if (!test.ok) {
    const body = (await test.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message ?? "The test notification did not go out");
  }
  return "on";
}

/** Stop pushes to this device, for this person and the browser both. */
export async function disablePush(): Promise<void> {
  const sub = supported() ? await subscription() : null;
  if (!sub) return;
  await forget(sub);
  await sub.unsubscribe();
}

const forget = (sub: PushSubscription) =>
  fetch("/api/push/unsubscribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpoint: sub.endpoint }),
  }).catch(() => undefined);

/**
 * On arrival: if this browser already has push on, make sure the server has it
 * for whoever is signed in now. Cheap, idempotent, and it is what makes push
 * follow the person after a sign-out and back in.
 */
export async function syncPush(): Promise<void> {
  if (!supported() || Notification.permission !== "granted") return;
  const sub = await subscription();
  if (sub) await tell(sub).catch(() => undefined);
}

/**
 * On sign-out: stop sending this person's notifications here, but keep the
 * browser's permission and subscription, so whoever signs in next on this
 * device is picked up by `syncPush` without asking again.
 */
export async function leavePush(): Promise<void> {
  if (!supported()) return;
  const sub = await subscription();
  if (sub) await forget(sub);
}
