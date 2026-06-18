import { app } from "electron";
import { resolveLocale, tFor, type DictKey } from "../shared/i18n/index.js";
import { getSettings } from "./settings.js";

// Main-process side of the meter's i18n (#232): tray menu, native dialogs and OS
// notifications read the SAME persisted `language` setting (and dictionaries) as the
// renderer, resolved lazily at call time so a language switch applies immediately.

/** The resolved locale for main-process strings ("auto" follows the OS language). */
export function currentLocale(): string {
  // app.getLocale() is only meaningful after the ready event; before that it returns
  // "" which resolveLocale treats as no-match → English. All main-side UI (tray,
  // dialogs, notifications) is created post-ready, so this is fine.
  return resolveLocale(getSettings().language, app.getLocale());
}

/** Translate a dict key for the current locale (main-process counterpart of useT). */
export function tMain(key: DictKey, vars?: Record<string, string | number>): string {
  return tFor(currentLocale(), key, vars);
}
