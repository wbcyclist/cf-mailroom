import { createContext, Fragment, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { updateBrowserPushLanguage } from "./push-notifications";
import {
  TIME_ZONE_STORAGE_KEY,
  getSystemTimeZone,
  isTimeZonePreference,
  readTimeZonePreference,
  resolveTimeZone,
  saveTimeZonePreference,
} from "./time-zone";
import {
  LANGUAGE_STORAGE_KEY,
  localizeError,
  messageTemplate,
  readLanguagePreference,
  resolveLocale,
  saveLanguagePreference,
  translate,
  type LanguagePreference,
  type Locale,
  type MessageKey,
  type Translator,
} from "./i18n";

interface LanguageContextValue {
  locale: Locale;
  preference: LanguagePreference;
  setPreference: (value: LanguagePreference) => void;
  timeZone: string;
  systemTimeZone: string;
  timeZonePreference: string;
  setTimeZonePreference: (value: string) => void;
  t: Translator;
  errorMessage: (message: string) => string;
}

const LanguageContext = createContext<LanguageContextValue | null>(null);

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [preference, setPreference] = useState(readLanguagePreference);
  const [languages, setLanguages] = useState(() => navigator.languages);
  const [timeZonePreference, setTimeZonePreference] = useState(readTimeZonePreference);
  const [systemTimeZone, setSystemTimeZone] = useState(getSystemTimeZone);
  const locale = resolveLocale(preference, languages);
  const timeZone = resolveTimeZone(timeZonePreference, systemTimeZone);

  useEffect(() => {
    document.documentElement.lang = locale;
    void updateBrowserPushLanguage(locale);
  }, [locale]);

  useEffect(() => {
    const updateLanguages = () => setLanguages(navigator.languages);
    const updatePreference = (event: StorageEvent) => {
      if (event.key === null || event.key === LANGUAGE_STORAGE_KEY) {
        setPreference(readLanguagePreference());
      }
      if (event.key === null || event.key === TIME_ZONE_STORAGE_KEY) {
        setTimeZonePreference(readTimeZonePreference());
      }
    };
    // Browsers have no time-zone-change event. Refresh after returning to the app.
    const updateSystemTimeZone = () => setSystemTimeZone(getSystemTimeZone());
    window.addEventListener("languagechange", updateLanguages);
    window.addEventListener("storage", updatePreference);
    window.addEventListener("focus", updateSystemTimeZone);
    document.addEventListener("visibilitychange", updateSystemTimeZone);
    return () => {
      window.removeEventListener("languagechange", updateLanguages);
      window.removeEventListener("storage", updatePreference);
      window.removeEventListener("focus", updateSystemTimeZone);
      document.removeEventListener("visibilitychange", updateSystemTimeZone);
    };
  }, []);

  const value = useMemo<LanguageContextValue>(() => ({
    locale,
    preference,
    timeZone,
    systemTimeZone,
    timeZonePreference,
    setTimeZonePreference: (next) => {
      if (!isTimeZonePreference(next)) return;
      saveTimeZonePreference(undefined, next);
      setTimeZonePreference(next);
    },
    setPreference: (next) => {
      saveLanguagePreference(undefined, next);
      setPreference(next);
    },
    t: (message, values) => translate(locale, message, values),
    errorMessage: (message) => localizeError(locale, message),
  }), [locale, preference, timeZone, systemTimeZone, timeZonePreference]);

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useI18n(): LanguageContextValue {
  const value = useContext(LanguageContext);
  if (!value) throw new Error("LanguageProvider is required");
  return value;
}

/** Keep linked or emphasized content inside complete, reorderable sentences. */
export function Trans({ message, values }: { message: MessageKey; values: Record<string, ReactNode> }) {
  const { locale } = useI18n();
  return <>{messageTemplate(locale, message).split(/(\{\w+\})/g).map((part, index) => {
    const key = /^\{(\w+)\}$/.exec(part)?.[1];
    return <Fragment key={index}>{key && Object.hasOwn(values, key) ? values[key] : part}</Fragment>;
  })}</>;
}
