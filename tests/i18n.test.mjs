import assert from "node:assert/strict";
import test from "node:test";
import { resolveLocale, translate, localizeError, readLanguagePreference, saveLanguagePreference } from "../src/web/i18n.ts";
import { zhCN } from "../src/web/locales/zh-CN.ts";
import { formatTime } from "../src/web/lib.ts";

test("language preference overrides browser detection and unsupported languages fall back to English", () => {
  assert.equal(resolveLocale("en", ["zh-CN"]), "en");
  assert.equal(resolveLocale("zh-CN", ["en-US"]), "zh-CN");
  assert.equal(resolveLocale("system", ["zh-TW"]), "zh-CN");
  assert.equal(resolveLocale("system", ["fr-FR", "zh-Hans-CN"]), "zh-CN");
  assert.equal(resolveLocale("system", ["en-GB", "zh-CN"]), "en");
  assert.equal(resolveLocale("system", ["fr-FR"]), "en");
  assert.equal(resolveLocale("system", []), "en");
});

test("preferences persist, invalid values reset, and unavailable storage is safe", () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  assert.equal(readLanguagePreference(storage), "system");
  saveLanguagePreference(storage, "zh-CN");
  assert.equal(readLanguagePreference(storage), "zh-CN");
  saveLanguagePreference(storage, "en");
  assert.equal(readLanguagePreference(storage), "en");
  saveLanguagePreference(storage, "system");
  assert.equal(readLanguagePreference(storage), "system");
  values.set("mailroom.language", "invalid");
  assert.equal(readLanguagePreference(storage), "system");
  const blocked = { getItem() { throw new Error("Blocked"); }, setItem() { throw new Error("Blocked"); } };
  assert.equal(readLanguagePreference(blocked), "system");
  assert.doesNotThrow(() => saveLanguagePreference(blocked, "zh-CN"));
});

test("translations preserve all placeholders and interpolate values literally", () => {
  const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
  for (const [english, chinese] of Object.entries(zhCN)) {
    assert.ok(chinese.trim(), english);
    assert.deepEqual(placeholders(chinese), placeholders(english), english);
    assert.equal(translate("en", english), english);
  }
  assert.equal(translate("zh-CN", "Remove {name}", { name: "$& <file>.txt" }), "移除 $& <file>.txt");
  assert.equal(translate("en", "Remove {name}", { name: "report.txt" }), "Remove report.txt");
});

test("known errors are localized without hiding unknown provider diagnostics", () => {
  assert.equal(localizeError("zh-CN", "Failed to fetch"), "网络连接失败，请重试。");
  assert.equal(localizeError("zh-CN", "Provider detail: abc-123"), "Provider detail: abc-123");
  assert.equal(localizeError("en", "Failed to fetch"), "Failed to fetch");
});

test("dates use the selected UI language", () => {
  const iso = "2024-03-09T12:00:00Z";
  assert.equal(formatTime(iso, "zh-CN"), new Date(iso).toLocaleDateString("zh-CN", { year: "numeric", month: "short", day: "numeric" }));
  assert.equal(formatTime(iso, "en"), new Date(iso).toLocaleDateString("en", { year: "numeric", month: "short", day: "numeric" }));
});

test("dynamic API error translations retain limits and HTTP status", () => {
  assert.equal(localizeError("zh-CN", "Request failed (503)"), "请求失败（503）");
  assert.equal(localizeError("zh-CN", "This inbox already has the maximum of 20 labels"), "此收件箱的标签数量已达到上限（20 个）");
  assert.equal(localizeError("zh-CN", "Message text must be at most 100,000 characters"), "邮件正文不能超过 100,000 个字符");
  assert.equal(localizeError("en", "Attachments are limited to 3 MB in total"), "Attachments are limited to 3 MB in total");
});

test("notification language updates an existing worker without creating a subscription", async (t) => {
  const { updateBrowserPushLanguage } = await import("../src/web/push-notifications.ts");
  const descriptors = Object.fromEntries(["window", "navigator"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => {
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  const registrations = [];
  let registration;
  const serviceWorker = {
    getRegistration: async () => registration,
    register: async (url, options) => { registrations.push({ url, options }); },
  };
  Object.defineProperty(globalThis, "window", { value: { PushManager: {}, Notification: {} }, configurable: true });
  Object.defineProperty(globalThis, "navigator", { value: { serviceWorker }, configurable: true });
  await updateBrowserPushLanguage("zh-CN");
  assert.equal(registrations.length, 0);
  registration = { active: { scriptURL: "https://mail.example/sw.js" } };
  await updateBrowserPushLanguage("zh-CN");
  assert.deepEqual(registrations, [{ url: "/sw.js?lang=zh-CN", options: { scope: "/" } }]);
  registration = { active: { scriptURL: "https://mail.example/sw.js?lang=zh-CN" } };
  await updateBrowserPushLanguage("zh-CN");
  assert.equal(registrations.length, 1);
  serviceWorker.getRegistration = async () => { throw new Error("Blocked"); };
  await assert.doesNotReject(() => updateBrowserPushLanguage("en"));
});
