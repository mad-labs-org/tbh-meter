import { describe, expect, it } from "vitest";
import {
  DICTIONARIES,
  LOCALES,
  DEFAULT_LOCALE,
  matchSystemLocale,
  resolveLocale,
  tFor,
  bcp47,
} from "./index.js";
import { DICT as EN } from "./en-us.js";

describe("locale resolution", () => {
  it("an explicit valid setting wins over the system language", () => {
    expect(resolveLocale("pt-br", "ko-KR")).toBe("pt-br");
  });

  it("'auto' follows the system language (case-insensitive, full tag first)", () => {
    expect(resolveLocale("auto", "pt-BR")).toBe("pt-br");
    expect(resolveLocale("auto", "ja-JP")).toBe("ja-jp");
  });

  it("falls back to the base language when the region has no exact locale", () => {
    expect(resolveLocale("auto", "pt-PT")).toBe("pt-br");
    expect(resolveLocale("auto", "es-MX")).toBe("es-es");
    expect(resolveLocale("auto", "fr")).toBe("fr-fr");
  });

  it("maps Chinese script variants explicitly (TW/HK/MO → traditional, else simplified)", () => {
    expect(matchSystemLocale("zh-TW")).toBe("zh-hant");
    expect(matchSystemLocale("zh-HK")).toBe("zh-hant");
    expect(matchSystemLocale("zh-CN")).toBe("zh-hans");
    expect(matchSystemLocale("zh")).toBe("zh-hans");
  });

  it("unknown settings and unknown system languages land on English", () => {
    expect(resolveLocale("auto", "xx-XX")).toBe(DEFAULT_LOCALE);
    expect(resolveLocale("not-a-locale", null)).toBe(DEFAULT_LOCALE);
    expect(resolveLocale(undefined, undefined)).toBe(DEFAULT_LOCALE);
  });
});

describe("tFor", () => {
  it("translates for the requested locale", () => {
    expect(tFor("pt-br", "header.tabSettings")).toBe("Configurações");
  });

  it("interpolates {token} vars", () => {
    expect(tFor("en-us", "runs.rangeOf", { start: 1, end: 20, total: 87 })).toBe("1–20 of 87");
  });

  it("falls back to English for an unknown locale", () => {
    expect(tFor("xx-yy", "header.tabSettings")).toBe(EN["header.tabSettings"]);
  });
});

describe("dictionaries", () => {
  it("ships a dictionary for every LOCALES entry", () => {
    for (const { code } of LOCALES) {
      expect(DICTIONARIES[code], `missing dictionary for ${code}`).toBeDefined();
    }
  });

  // The locale files are typed Partial<> (the web's fallback pattern), but the meter
  // SHIPS them complete — this guard catches a key added to en-us and forgotten in a
  // translation, which would silently render English for that locale.
  it("every locale translates every key (no silent English holes)", () => {
    const keys = Object.keys(EN);
    for (const { code } of LOCALES) {
      const dict = DICTIONARIES[code];
      const missing = keys.filter((k) => !(k in dict));
      expect(missing, `locale ${code} is missing: ${missing.join(", ")}`).toEqual([]);
    }
  });

  it("translations keep the {token} placeholders of their English source", () => {
    const tokenRe = /\{(\w+)\}/g;
    for (const [key, value] of Object.entries(EN)) {
      const tokens = [...value.matchAll(tokenRe)].map((m) => m[1]).sort();
      if (tokens.length === 0) continue;
      for (const { code } of LOCALES) {
        const translated = DICTIONARIES[code][key as keyof typeof EN];
        if (translated == null) continue; // completeness is asserted above
        const got = [...translated.matchAll(tokenRe)].map((m) => m[1]).sort();
        expect(got, `${code} ${key} placeholders`).toEqual(tokens);
      }
    }
  });
});

describe("bcp47", () => {
  it("maps locale codes to Intl-friendly tags", () => {
    expect(bcp47("en-us")).toBe("en-US");
    expect(bcp47("pt-br")).toBe("pt-BR");
    expect(bcp47("zh-hans")).toBe("zh-Hans");
    expect(bcp47("zh-hant")).toBe("zh-Hant");
  });
});
