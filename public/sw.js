self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

const chinese = new URL(self.location.href).searchParams.get("lang") === "zh-CN";
const defaultTitle = chinese ? "新邮件" : "New email";
const defaultBody = chinese ? "收到新会话。" : "A new conversation arrived.";

self.addEventListener("push", (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = {};
  }

  let title = payload.title || defaultTitle;
  let body = payload.body || defaultBody;
  if (chinese && payload.data && Object.hasOwn(payload.data, "sender")) {
    title = `来自 ${payload.data.sender || "未知发件人"} 的新邮件`;
    if (payload.data.hasSubject === false) body = "（无主题）";
  }

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag: payload.tag,
      renotify: Boolean(payload.tag),
      data: payload.data || { url: "/inbox" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const relativeUrl = event.notification.data?.url || "/inbox";
  const targetUrl = new URL(relativeUrl, self.location.origin).href;

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then(async (windowClients) => {
        const existing = windowClients.find((client) => client.url.startsWith(self.location.origin));
        if (existing) {
          if ("navigate" in existing && existing.url !== targetUrl) await existing.navigate(targetUrl);
          if ("focus" in existing) return existing.focus();
        }
        return self.clients.openWindow(targetUrl);
      }),
  );
});
