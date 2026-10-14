export const TIME_ZONE_STORAGE_KEY = "mailroom.timeZone";
type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;

const FALLBACK_TIME_ZONES = [
  "UTC",
  "Africa/Johannesburg",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/New_York",
  "America/Sao_Paulo",
  "Asia/Dubai",
  "Asia/Hong_Kong",
  "Asia/Kolkata",
  "Asia/Shanghai",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Europe/Berlin",
  "Europe/London",
  "Europe/Moscow",
  "Pacific/Auckland",
  "Pacific/Honolulu",
];

export function isTimeZonePreference(value: unknown): value is string {
  if (value === "system") return true;
  if (typeof value !== "string" || !value) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function getSystemTimeZone(): string {
  return new Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function resolveTimeZone(preference: string, systemTimeZone = getSystemTimeZone()): string {
  return preference !== "system" && isTimeZonePreference(preference) ? preference : systemTimeZone;
}

export function readTimeZonePreference(storage?: PreferenceStorage): string {
  try {
    const value = (storage ?? window.localStorage).getItem(TIME_ZONE_STORAGE_KEY);
    return isTimeZonePreference(value) ? value : "system";
  } catch {
    return "system";
  }
}

export function saveTimeZonePreference(storage: PreferenceStorage | undefined, value: string): void {
  if (!isTimeZonePreference(value)) return;
  try {
    (storage ?? window.localStorage).setItem(TIME_ZONE_STORAGE_KEY, value);
  } catch {
    // Keep the in-memory selection when browser storage is unavailable.
  }
}

export function getTimeZones(...selectedZones: string[]): string[] {
  let zones: readonly string[] = FALLBACK_TIME_ZONES;
  try {
    zones = Intl.supportedValuesOf("timeZone");
  } catch {
    // Older browsers can format named zones without listing all supported zones.
  }
  return [...new Set(["UTC", ...zones, ...selectedZones])]
    .filter((zone) => zone !== "system" && isTimeZonePreference(zone))
    .sort();
}
