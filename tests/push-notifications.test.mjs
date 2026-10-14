import assert from "node:assert/strict";
import test from "node:test";
import {
  buildNewEmailNotification,
  validatePushSubscription,
} from "../src/worker/notifications/push.ts";

test("builds a concise notification that opens the exact conversation", () => {
  assert.deepEqual(
    buildNewEmailNotification({
      threadId: 42,
      senderName: "  Alice   Customer  ",
      senderAddress: "alice@example.com",
      subject: "  Refund   request  ",
    }),
    {
      title: "New email from Alice Customer",
      body: "Refund request",
      tag: "conversation-42",
      data: { url: "/inbox/42", sender: "Alice Customer", hasSubject: true },
    },
  );
});

test("falls back safely when sender and subject are empty", () => {
  const payload = buildNewEmailNotification({
    threadId: 7,
    senderName: null,
    senderAddress: "",
    subject: "",
  });
  assert.equal(payload.title, "New email from Unknown sender");
  assert.equal(payload.body, "(no subject)");
});

test("accepts only complete HTTPS Push Subscriptions", () => {
  const valid = {
    endpoint: "https://push.example.com/subscriptions/abc",
    expirationTime: null,
    keys: {
      p256dh: "B".repeat(87),
      auth: "a".repeat(22),
    },
  };
  assert.equal(validatePushSubscription(valid), true);
  assert.equal(validatePushSubscription({ ...valid, endpoint: "http://push.example.com/abc" }), false);
  assert.equal(validatePushSubscription({ ...valid, keys: { ...valid.keys, auth: "short" } }), false);
  assert.equal(validatePushSubscription({ ...valid, expirationTime: -1 }), false);
});

test("push notifications use the browser language and preserve email content", async () => {
  const { readFile } = await import("node:fs/promises");
  const { runInNewContext } = await import("node:vm");
  const source = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
  async function show(language, data) {
    const listeners = new Map();
    const notifications = [];
    runInNewContext(source, {
      URL,
      self: {
        location: { href: `https://mail.example/sw.js?lang=${language}`, origin: "https://mail.example" },
        addEventListener: (type, listener) => listeners.set(type, listener),
        registration: { showNotification: async (title, options) => notifications.push({ title, options }) },
      },
    });
    let pending;
    listeners.get("push")({ data, waitUntil: (promise) => { pending = promise; } });
    await pending;
    return notifications[0];
  }
  const payload = buildNewEmailNotification({ threadId: 1, senderName: "Alice", senderAddress: "alice@example.com", subject: "Keep this subject unchanged" });
  const zh = await show("zh-CN", { json: () => payload });
  assert.equal(zh.title, "来自 Alice 的新邮件");
  assert.equal(zh.options.body, payload.body);
  assert.equal(zh.options.data.url, "/inbox/1");
  assert.equal((await show("en", { json: () => payload })).title, "New email from Alice");
  const empty = buildNewEmailNotification({ threadId: 2, senderName: null, senderAddress: "", subject: "" });
  const fallback = await show("zh-CN", { json: () => empty });
  assert.equal(fallback.title, "来自 未知发件人 的新邮件");
  assert.equal(fallback.options.body, "（无主题）");
  const malformed = await show("zh-CN", { json: () => { throw new Error("Invalid JSON"); } });
  assert.equal(malformed.title, "新邮件");
  assert.equal(malformed.options.body, "收到新会话。");
  const legacy = await show("zh-CN", { json: () => ({ title: "Legacy", body: "Original subject", data: { url: "/inbox/1" } }) });
  assert.equal(legacy.title, "Legacy");
  assert.equal(legacy.options.body, "Original subject");
});
