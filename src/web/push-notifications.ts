import type { BrowserPushSubscription } from "../shared/types";
import type { Locale } from "./i18n";

export type BrowserNotificationPermission = NotificationPermission | "unsupported";

export interface BrowserPushState {
  supported: boolean;
  permission: BrowserNotificationPermission;
  subscribed: boolean;
}

export class BrowserPushError extends Error {
  readonly code: "permission-denied" | "subscription-failed" | "unsupported";

  constructor(
    code: BrowserPushError["code"],
    message: string,
  ) {
    super(message);
    this.code = code;
  }
}

export async function getBrowserPushState(): Promise<BrowserPushState> {
  if (!supportsBrowserPush()) {
    return { supported: false, permission: "unsupported", subscribed: false };
  }

  try {
    const registration = await navigator.serviceWorker.getRegistration("/");
    const subscription = await registration?.pushManager.getSubscription();
    return {
      supported: true,
      permission: Notification.permission,
      subscribed: Boolean(subscription),
    };
  } catch {
    return {
      supported: true,
      permission: Notification.permission,
      subscribed: false,
    };
  }
}

export async function createBrowserPushSubscription(
  vapidPublicKey: string,
  locale: Locale,
): Promise<BrowserPushSubscription> {
  if (!supportsBrowserPush()) {
    throw new BrowserPushError("unsupported", "This browser does not support push notifications.");
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new BrowserPushError(
      "permission-denied",
      "Notifications are blocked in this browser.",
    );
  }

  try {
    const registration = await navigator.serviceWorker.register(`/sw.js?lang=${locale}`, { scope: "/" });
    await navigator.serviceWorker.ready;
    const applicationServerKey = base64urlToUint8Array(vapidPublicKey);
    let subscription = await registration.pushManager.getSubscription();

    if (
      subscription &&
      !sameApplicationServerKey(subscription.options.applicationServerKey, applicationServerKey)
    ) {
      await subscription.unsubscribe();
      subscription = null;
    }

    subscription ??= await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey,
    });
    const value = subscription.toJSON();
    if (!value.endpoint || !value.keys?.p256dh || !value.keys.auth) {
      throw new Error("The browser returned an incomplete Push Subscription");
    }
    return {
      endpoint: value.endpoint,
      expirationTime: value.expirationTime ?? null,
      keys: { p256dh: value.keys.p256dh, auth: value.keys.auth },
    };
  } catch (error) {
    if (error instanceof BrowserPushError) throw error;
    throw new BrowserPushError(
      "subscription-failed",
      error instanceof Error ? error.message : "Could not subscribe this browser.",
    );
  }
}

/** The script URL preserves the notification language while the app is closed. */
export async function updateBrowserPushLanguage(locale: Locale): Promise<void> {
  if (!supportsBrowserPush()) return;
  try {
    const registration = await navigator.serviceWorker.getRegistration("/");
    const worker = registration?.installing ?? registration?.waiting ?? registration?.active;
    if (!worker) return;
    const url = new URL(worker.scriptURL);
    if (url.pathname === "/sw.js" && url.searchParams.get("lang") !== locale) {
      await navigator.serviceWorker.register(`/sw.js?lang=${locale}`, { scope: "/" });
    }
  } catch {
    // Offline or blocked service workers must not prevent a UI language change.
  }
}

export async function unsubscribeCurrentBrowser(): Promise<void> {
  if (!supportsBrowserPush()) return;
  const registration = await navigator.serviceWorker.getRegistration("/");
  const subscription = await registration?.pushManager.getSubscription();
  if (subscription) await subscription.unsubscribe();
}

function supportsBrowserPush(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

function base64urlToUint8Array(value: string): Uint8Array<ArrayBuffer> {
  const padded = value + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function sameApplicationServerKey(
  current: ArrayBuffer | null,
  expected: Uint8Array<ArrayBuffer>,
): boolean {
  if (!current) return false;
  const actual = new Uint8Array(current);
  return actual.length === expected.length && actual.every((byte, index) => byte === expected[index]);
}
