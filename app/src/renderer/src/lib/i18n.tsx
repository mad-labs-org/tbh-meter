import { createContext, useContext, useEffect, useMemo, useState } from "react";
import {
  AUTO_LOCALE,
  bcp47,
  resolveLocale,
  tFor,
  type Translate,
} from "../../../shared/i18n/index.js";

// Renderer side of the meter's i18n (#232). The persisted `language` setting is the
// SSOT (settings.json, owned by main); this provider reads it once and stays in sync
// via onSettingsChanged, so a language switch in the Settings window re-renders every
// open window (live overlay, runs window, splash) without a restart.

interface I18nValue {
  /** Resolved locale code (never "auto"), e.g. "pt-br". */
  locale: string;
  /** BCP47 tag for Intl APIs (date formatting), e.g. "pt-BR". */
  lang: string;
  t: Translate;
}

function makeValue(setting: string): I18nValue {
  const locale = resolveLocale(setting, typeof navigator !== "undefined" ? navigator.language : null);
  return { locale, lang: bcp47(locale), t: (key, vars) => tFor(locale, key, vars) };
}

const I18nContext = createContext<I18nValue>(makeValue(AUTO_LOCALE));

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [setting, setSetting] = useState<string>(AUTO_LOCALE);

  useEffect(() => {
    void window.meter.getSettings().then((s) => setSetting(s.language));
    return window.meter.onSettingsChanged((s) => setSetting(s.language));
  }, []);

  const value = useMemo(() => makeValue(setting), [setting]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** Locale + translate fn for the current window. */
export function useI18n(): I18nValue {
  return useContext(I18nContext);
}

/** Shorthand for the translate fn only. */
export function useT(): Translate {
  return useI18n().t;
}
