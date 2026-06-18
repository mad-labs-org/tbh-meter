import type { RunStatus, RunQuality } from "../../../shared/run-types.js";
import { tFor, type Translate } from "../../../shared/i18n/index.js";

// English-bound default translator: keeps these helpers callable without a locale
// (tests, non-React code); components pass the context's `t` for the user's language.
const tEn: Translate = (key, vars) => tFor("en-us", key, vars);

const SUFFIXES: [number, string][] = [
  [1e15, "P"],
  [1e12, "T"],
  [1e9, "B"],
  [1e6, "M"],
  [1e3, "K"],
];

/**
 * Mirrors the reader's fmt(): values < 1000 print as a plain integer with no
 * suffix; otherwise "%.2f" with a K/M/B/T/P suffix (each step = /1000).
 */
export function humanize(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const abs = Math.abs(value);
  if (abs < 1000) return String(Math.trunc(value));
  for (const [factor, suffix] of SUFFIXES) {
    if (abs >= factor) return `${(value / factor).toFixed(2)}${suffix}`;
  }
  return String(Math.trunc(value));
}

/** Seconds with an "s" suffix, keeping one decimal only when present (e.g. "172s",
 *  "300.4s"), from a duration in SECONDS (the reader's unit). Clear time stays in
 *  seconds — never reformatted to m:ss; whole values render without a decimal. */
export function formatDuration(seconds: number): string {
  const rounded = Math.round(Math.max(0, seconds) * 10) / 10;
  return `${rounded}s`;
}

export function statusLabel(status: RunStatus, t: Translate = tEn): string {
  switch (status) {
    case "success":
      return t("status.success");
    case "fail":
      return t("status.fail");
    case "abandoned":
      return t("status.abandoned");
    default:
      return status;
  }
}

// Mode badge color by difficulty (escalating danger). Shared by the runs list and run detail.
const MODE_BADGE: Record<string, string> = {
  Normal: "bg-emerald-500/15 text-emerald-300",
  Nightmare: "bg-sky-500/15 text-sky-300",
  Hell: "bg-orange-500/15 text-orange-300",
  Torment: "bg-rose-500/15 text-rose-300",
};

/** Tailwind bg+text classes for a difficulty-mode badge. */
export function modeBadgeClass(mode: string): string {
  return MODE_BADGE[mode] ?? "bg-surface-700 text-zinc-400";
}

// Difficulty text color (no background) — for the combined stage chip in the runs
// list, mirroring the web leaderboard's stage cell. Same hue family as MODE_BADGE.
const MODE_TEXT: Record<string, string> = {
  Normal: "text-emerald-300",
  Nightmare: "text-sky-300",
  Hell: "text-orange-300",
  Torment: "text-rose-300",
};

/** Tailwind text-color class for a difficulty mode (chip variant, no background). */
export function modeTextClass(mode: string): string {
  return MODE_TEXT[mode] ?? "text-zinc-400";
}

// Two-letter mode abbreviation for tight rows (the cooldown card spots).
const MODE_ABBREV: Record<string, string> = {
  Normal: "NO",
  Nightmare: "NM",
  Hell: "HE",
  Torment: "TO",
};

/** Compact 2-letter mode label (e.g. "Nightmare" → "NM"). Falls back to the first 2 chars.
 *  Intentionally NOT translated — the 2-letter codes are stable game shorthand. */
export function modeAbbrev(mode: string): string {
  return MODE_ABBREV[mode] ?? mode.slice(0, 2).toUpperCase();
}

/** Localized display label for a difficulty mode (run data stores the EN name). */
export function modeLabel(mode: string, t: Translate = tEn): string {
  switch (mode) {
    case "Normal":
      return t("mode.Normal");
    case "Nightmare":
      return t("mode.Nightmare");
    case "Hell":
      return t("mode.Hell");
    case "Torment":
      return t("mode.Torment");
    default:
      return mode;
  }
}

/** The visual marker for a run that did NOT count — partial, degraded, or skipped. */
export interface QualityBadge {
  /** Short label for the detail banner heading ("Partial" / "Degraded" / "Invalid"). */
  label: string;
  /** Plain-language explanation shown on hover (list) and in the banner (detail). */
  title: string;
  /** Text color for the warning icon in the runs list. */
  iconClass: string;
  /** Background tint applied to the WHOLE runs-list row, so an ignored run reads as set-apart at a
   *  glance (red = invalid/unreliable, amber = a real clear with incomplete data). */
  rowClass: string;
  /** Border + tinted background + text for the detail-view banner container. */
  noticeClass: string;
}

// Every verdict that is NOT a clean counted clear gets a marker, so a run revealed by "show ignored"
// can never be mistaken for a real one. `degraded` (bad data) and `skipped` (not a valid clear — too
// short, or a fail/abandon) are RED = invalid; `partial` (a real clear the meter only partly captured)
// is amber. `counted` (and a legacy run with no verdict) is the normal case → no marker. Label and
// title come from dict KEYS so the marker follows the app language (translated in qualityBadge()).
const QUALITY_BADGE = {
  partial: {
    labelKey: "quality.partialLabel",
    titleKey: "quality.partialTitle",
    iconClass: "text-amber-400",
    rowClass: "bg-amber-500/10",
    noticeClass: "border-amber-500/30 bg-amber-500/10 text-amber-200",
  },
  degraded: {
    labelKey: "quality.degradedLabel",
    titleKey: "quality.degradedTitle",
    iconClass: "text-rose-400",
    rowClass: "bg-rose-500/10",
    noticeClass: "border-rose-500/30 bg-rose-500/10 text-rose-200",
  },
  skipped: {
    labelKey: "quality.skippedLabel",
    titleKey: "quality.skippedTitle",
    iconClass: "text-rose-400",
    rowClass: "bg-rose-500/10",
    noticeClass: "border-rose-500/30 bg-rose-500/10 text-rose-200",
  },
} as const satisfies Partial<Record<RunQuality, unknown>>;

/** The quality marker for a run, or null when the run is a clean counted clear (or a legacy run
 *  with no verdict — both render normally). Partial/degraded/skipped all return a marker. */
export function qualityBadge(
  quality: RunQuality | undefined,
  t: Translate = tEn,
): QualityBadge | null {
  const entry = quality ? QUALITY_BADGE[quality as keyof typeof QUALITY_BADGE] ?? null : null;
  if (!entry) return null;
  return {
    label: t(entry.labelKey),
    title: t(entry.titleKey),
    iconClass: entry.iconClass,
    rowClass: entry.rowClass,
    noticeClass: entry.noticeClass,
  };
}

/** Relative time from an epoch timestamp in MILLISECONDS (Redesign 2: run ts is ms; loadStructured
 *  normalizes legacy seconds -> ms, so the renderer always receives ms). */
export function ago(tsMs: number, t: Translate = tEn): string {
  if (!Number.isFinite(tsMs) || tsMs <= 0) return "";
  const deltaSec = Math.floor((Date.now() - tsMs) / 1000);
  if (deltaSec < 60) return t("ago.justNow");
  const minutes = Math.floor(deltaSec / 60);
  if (minutes < 60) return t("ago.m", { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("ago.h", { n: hours });
  const days = Math.floor(hours / 24);
  if (days < 7) return t("ago.d", { n: days });
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return t("ago.w", { n: weeks });
  const months = Math.floor(days / 30);
  if (months < 12) return t("ago.mo", { n: months });
  return t("ago.y", { n: Math.floor(days / 365) });
}

/** Absolute local date+time in short style. `lang` (BCP47, from useI18n) follows the app
 *  language; undefined falls back to the OS locale's conventions (DD/MM vs MM/DD, 12/24h).
 *  Takes an epoch in MILLISECONDS (Redesign 2: run ts is ms; loadStructured normalizes
 *  legacy seconds -> ms). */
export function formatDateTime(tsMs: number, lang?: string): string {
  if (!Number.isFinite(tsMs) || tsMs <= 0) return "";
  return new Date(tsMs).toLocaleString(lang, {
    dateStyle: "short",
    timeStyle: "short",
  });
}
