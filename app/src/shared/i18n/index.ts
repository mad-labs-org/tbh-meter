// Dependency-free i18n for the meter app (#232) — same architecture as the web wiki
// (web/src/lib/i18n.tsx): English is the source of truth, every other locale is a
// partial override falling back to English, `{token}` vars interpolate at lookup.
// This module is PURE (no Electron imports) so the main process (tray, dialogs,
// notifications) and the renderer share one implementation.

import { DICT as EN, type DictKey } from "./en-us.js";
import { DICT as PT_BR } from "./pt-br.js";
import { DICT as ES_ES } from "./es-es.js";
import { DICT as FR_FR } from "./fr-fr.js";
import { DICT as DE_DE } from "./de-de.js";
import { DICT as PL_PL } from "./pl-pl.js";
import { DICT as RU_RU } from "./ru-ru.js";
import { DICT as UK_UA } from "./uk-ua.js";
import { DICT as TR_TR } from "./tr-tr.js";
import { DICT as ID_ID } from "./id-id.js";
import { DICT as VI_VN } from "./vi-vn.js";
import { DICT as TH_TH } from "./th-th.js";
import { DICT as JA_JP } from "./ja-jp.js";
import { DICT as KO_KR } from "./ko-kr.js";
import { DICT as ZH_HANS } from "./zh-hans.js";
import { DICT as ZH_HANT } from "./zh-hant.js";

export type { DictKey } from "./en-us.js";

export interface LocaleOption {
  code: string;
  /** Endonym — the language's name in its own language (for the Settings picker). */
  label: string;
}

/** The 16 locales the game (and the web wiki) ship, in display order. */
export const LOCALES: LocaleOption[] = [
  { code: "en-us", label: "English" },
  { code: "pt-br", label: "Português" },
  { code: "es-es", label: "Español" },
  { code: "fr-fr", label: "Français" },
  { code: "de-de", label: "Deutsch" },
  { code: "pl-pl", label: "Polski" },
  { code: "ru-ru", label: "Русский" },
  { code: "uk-ua", label: "Українська" },
  { code: "tr-tr", label: "Türkçe" },
  { code: "id-id", label: "Bahasa Indonesia" },
  { code: "vi-vn", label: "Tiếng Việt" },
  { code: "th-th", label: "ไทย" },
  { code: "ja-jp", label: "日本語" },
  { code: "ko-kr", label: "한국어" },
  { code: "zh-hans", label: "简体中文" },
  { code: "zh-hant", label: "繁體中文" },
];

export const DEFAULT_LOCALE = "en-us";
/** The settings value meaning "follow the system language". */
export const AUTO_LOCALE = "auto";

const LOCALE_CODES = new Set(LOCALES.map((l) => l.code));

export const DICTIONARIES: Record<string, Partial<Record<DictKey, string>>> = {
  "en-us": EN,
  "pt-br": PT_BR,
  "es-es": ES_ES,
  "fr-fr": FR_FR,
  "de-de": DE_DE,
  "pl-pl": PL_PL,
  "ru-ru": RU_RU,
  "uk-ua": UK_UA,
  "tr-tr": TR_TR,
  "id-id": ID_ID,
  "vi-vn": VI_VN,
  "th-th": TH_TH,
  "ja-jp": JA_JP,
  "ko-kr": KO_KR,
  "zh-hans": ZH_HANS,
  "zh-hant": ZH_HANT,
};

/** Best-effort match of a system language tag (navigator.language / app.getLocale(),
 *  e.g. "pt-BR", "zh-TW", "fr") to one of our locale codes. Script-specific Chinese
 *  maps explicitly (zh-TW/HK/MO → traditional); everything else matches the full tag
 *  first, then the base language (so "pt-PT" lands on pt-br rather than English). */
export function matchSystemLocale(tag: string | undefined | null): string | null {
  const sys = tag?.toLowerCase();
  if (!sys) return null;
  if (sys === "zh-tw" || sys === "zh-hk" || sys === "zh-mo" || sys === "zh-hant") return "zh-hant";
  if (sys.startsWith("zh")) return "zh-hans";
  if (LOCALE_CODES.has(sys)) return sys;
  const base = sys.split("-")[0];
  return LOCALES.find((l) => l.code.split("-")[0] === base)?.code ?? null;
}

/** Resolve the persisted `language` setting to a concrete locale code:
 *  "auto" (or anything unknown) follows the system language, defaulting to English. */
export function resolveLocale(setting: string | undefined | null, systemTag?: string | null): string {
  if (setting && setting !== AUTO_LOCALE && LOCALE_CODES.has(setting)) return setting;
  return matchSystemLocale(systemTag) ?? DEFAULT_LOCALE;
}

/** Translate `key` for `locale`, falling back to English then the key itself,
 *  interpolating `{token}` vars (e.g. tFor("pt-br", "runs.rangeOf", { start: 1, … })). */
export function tFor(
  locale: string,
  key: DictKey,
  vars?: Record<string, string | number>,
): string {
  let s = DICTIONARIES[locale]?.[key] ?? EN[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  }
  return s;
}

/** The translate-fn shape components receive (a bound tFor). */
export type Translate = (key: DictKey, vars?: Record<string, string | number>) => string;

/** Map a locale code to a BCP47 tag for Intl APIs (date formatting). */
export function bcp47(code: string): string {
  switch (code) {
    case "zh-hans":
      return "zh-Hans";
    case "zh-hant":
      return "zh-Hant";
    default: {
      const [lang, region] = code.split("-");
      return region ? `${lang}-${region.toUpperCase()}` : lang;
    }
  }
}
