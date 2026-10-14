import assert from "node:assert/strict";
import test from "node:test";
import {
  TIME_ZONE_STORAGE_KEY,
  getTimeZones,
  isTimeZonePreference,
  readTimeZonePreference,
  resolveTimeZone,
  saveTimeZonePreference,
} from "../src/web/time-zone.ts";
import { formatDateTime, formatTime } from "../src/web/lib.ts";

test("time zone preferences accept supported zones and follow the browser by default", () => {
  for (const value of ["system", "UTC", "Asia/Shanghai", "America/New_York", "Asia/Kathmandu"]) {
    assert.equal(isTimeZonePreference(value), true, value);
  }
  for (const value of ["", null, 8, "Mars/Olympus"]) {
    assert.equal(isTimeZonePreference(value), false);
  }
  assert.equal(resolveTimeZone("system", "Asia/Tokyo"), "Asia/Tokyo");
  assert.equal(resolveTimeZone("Asia/Shanghai", "America/New_York"), "Asia/Shanghai");
  assert.equal(resolveTimeZone("invalid", "UTC"), "UTC");
});

test("time zone preferences persist and recover from invalid or blocked storage", () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  assert.equal(readTimeZonePreference(storage), "system");
  saveTimeZonePreference(storage, "Asia/Shanghai");
  assert.equal(readTimeZonePreference(storage), "Asia/Shanghai");
  saveTimeZonePreference(storage, "UTC");
  assert.equal(readTimeZonePreference(storage), "UTC");
  saveTimeZonePreference(storage, "system");
  assert.equal(readTimeZonePreference(storage), "system");
  values.set(TIME_ZONE_STORAGE_KEY, "invalid");
  assert.equal(readTimeZonePreference(storage), "system");
  const blocked = { getItem() { throw new Error("Blocked"); }, setItem() { throw new Error("Blocked"); } };
  assert.equal(readTimeZonePreference(blocked), "system");
  assert.doesNotThrow(() => saveTimeZonePreference(blocked, "Asia/Shanghai"));
});

test("the selector includes UTC, the saved alias, and valid browser-supported zones", () => {
  const zones = getTimeZones("Asia/Calcutta");
  assert.ok(zones.includes("UTC"));
  assert.ok(zones.includes("Asia/Shanghai"));
  assert.ok(zones.includes("Asia/Calcutta"));
  assert.ok(zones.includes("America/New_York"));
  assert.equal(zones.length, new Set(zones).size);
  assert.ok(zones.every(isTimeZonePreference));
});

test("the selector has a fallback when time zone enumeration is unavailable", (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(Intl, "supportedValuesOf");
  Object.defineProperty(Intl, "supportedValuesOf", { value: undefined, configurable: true });
  t.after(() => Object.defineProperty(Intl, "supportedValuesOf", descriptor));
  const zones = getTimeZones("Pacific/Chatham");
  assert.ok(zones.includes("UTC"));
  assert.ok(zones.includes("Asia/Shanghai"));
  assert.ok(zones.includes("Pacific/Chatham"));
});

const time = (iso, zone) => new Date(iso).toLocaleTimeString("en", { timeZone: zone, hour: "2-digit", minute: "2-digit" });
const date = (iso, zone, year = false) => new Date(iso).toLocaleDateString("en", { timeZone: zone, month: "short", day: "numeric", ...(year ? { year: "numeric" } : {}) });

test("today is determined in the selected zone across UTC midnight", () => {
  const zone = "America/Los_Angeles";
  const previousUtcDay = "2026-10-13T23:00:00Z";
  assert.equal(formatTime(previousUtcDay, "en", zone, new Date("2026-10-14T01:00:00Z")), time(previousUtcDay, zone));
  const sameUtcDay = "2026-10-14T06:30:00Z";
  assert.equal(formatTime(sameUtcDay, "en", zone, new Date("2026-10-14T12:00:00Z")), date(sameUtcDay, zone));
});

test("year boundaries use the selected zone rather than UTC or the host zone", () => {
  const previousUtcYear = "2025-12-31T23:30:00Z";
  assert.equal(formatTime(previousUtcYear, "en", "Asia/Shanghai", new Date("2026-01-02T12:00:00Z")), date(previousUtcYear, "Asia/Shanghai"));
  const sameUtcYear = "2026-01-01T00:30:00Z";
  assert.equal(formatTime(sameUtcYear, "en", "America/Los_Angeles", new Date("2026-01-01T20:00:00Z")), date(sameUtcYear, "America/Los_Angeles", true));
});

test("named time zones apply daylight saving rules and fractional offsets", () => {
  const before = "2026-03-08T06:30:00Z";
  const after = "2026-03-08T07:30:00Z";
  const now = new Date("2026-03-08T12:00:00Z");
  assert.equal(formatTime(before, "en", "America/New_York", now), "01:30 AM");
  assert.equal(formatTime(after, "en", "America/New_York", now), "03:30 AM");
  const kathmandu = "2026-03-08T00:00:00Z";
  assert.equal(formatTime(kathmandu, "en", "Asia/Kathmandu", now), "05:45 AM");
  assert.equal(formatTime(kathmandu, "zh-CN", "Asia/Shanghai", now), "08:00");
});

test("full timestamps include the selected zone and distinguish repeated daylight saving hours", () => {
  const first = formatDateTime("2026-11-01T05:30:00Z", "en", "America/New_York");
  const second = formatDateTime("2026-11-01T06:30:00Z", "en", "America/New_York");
  assert.match(first, /1:30:00/);
  assert.match(second, /1:30:00/);
  assert.notEqual(first, second);
  const iso = "2026-10-14T18:30:00Z";
  assert.equal(formatDateTime(iso, "zh-CN", "Asia/Shanghai"), new Date(iso).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", timeZoneName: "short" }));
});
