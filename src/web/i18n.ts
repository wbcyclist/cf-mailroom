import { zhCN } from "./locales/zh-CN.ts";

export type Locale = "en" | "zh-CN";
export type LanguagePreference = Locale | "system";
export type MessageKey = keyof typeof zhCN;
export type MessageValues = Record<string, string | number>;
export type Translator = (message: MessageKey, values?: MessageValues) => string;

export const LANGUAGE_STORAGE_KEY = "mailroom.language";
type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;

export function isLanguagePreference(value: unknown): value is LanguagePreference {
  return value === "system" || value === "en" || value === "zh-CN";
}

export function resolveLocale(preference: LanguagePreference, languages: readonly string[]): Locale {
  if (preference !== "system") return preference;
  for (const language of languages) {
    const base = language.toLowerCase().split(/[-_]/)[0];
    if (base === "zh") return "zh-CN";
    if (base === "en") return "en";
  }
  return "en";
}

export function readLanguagePreference(storage?: PreferenceStorage): LanguagePreference {
  try {
    const value = (storage ?? window.localStorage).getItem(LANGUAGE_STORAGE_KEY);
    return isLanguagePreference(value) ? value : "system";
  } catch {
    return "system";
  }
}

export function saveLanguagePreference(storage: PreferenceStorage | undefined, value: LanguagePreference): void {
  try {
    (storage ?? window.localStorage).setItem(LANGUAGE_STORAGE_KEY, value);
  } catch {
    // The selected language still works for this session when storage is blocked.
  }
}

export function messageTemplate(locale: Locale, message: MessageKey): string {
  return locale === "zh-CN" ? zhCN[message] : message;
}

export function translate(locale: Locale, message: MessageKey, values: MessageValues = {}): string {
  return messageTemplate(locale, message).replace(/\{(\w+)\}/g, (token, key: string) =>
    Object.hasOwn(values, key) ? String(values[key]) : token,
  );
}

/** Translate known application errors; retain diagnostics from external services. */
export function localizeError(locale: Locale, message: string): string {
  if (Object.hasOwn(zhCN, message)) return translate(locale, message as MessageKey);
  for (const [pattern, template, key] of ERROR_PATTERNS) {
    const match = pattern.exec(message);
    if (match) return translate(locale, template, { [key]: match[1] });
  }
  return message;
}

const ERROR_PATTERNS: readonly [RegExp, MessageKey, string][] = [
  [/^Request failed \((\d+)\)$/, "Request failed ({status})", "status"],
  [/^AI request failed \(HTTP (\d+)\)$/, "AI request failed (HTTP {status})", "status"],
  [/^Could not send \((\d+)\)$/, "Could not send ({status})", "status"],
  [/^This inbox already has the maximum of (\d+) labels$/, "This inbox already has the maximum of {count} labels", "count"],
  [/^Keep the instruction under (\d+) characters$/, "Keep the instruction under {count} characters", "count"],
  [/^Enter a subject of 1–(\d+) characters without line breaks$/, "Enter a subject of 1–{count} characters without line breaks", "count"],
  [/^Message text must be at most ([\d,]+) characters$/, "Message text must be at most {count} characters", "count"],
  [/^A message can carry at most (\d+) attachments$/, "A message can carry at most {count} attachments", "count"],
  [/^Attachments are limited to (\d+) MB in total$/, "Attachments are limited to {count} MB in total", "count"],
];
