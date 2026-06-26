import { Bug, Skull, LogOut, CircleSlash, TimerOff, type LucideIcon } from "lucide-react";
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

/** Compact, human ETA from a second count — for the time-to-level readout, which spans seconds to
 *  days at high levels (`formatDuration`'s raw "7193s" is unreadable there). "45s", "12m", "1h59m",
 *  "2d3h". Non-finite or negative (no XP income / capped) → "—". */
export function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  if (h < 24) return mm ? `${h}h${mm}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const hh = h % 24;
  return hh ? `${d}d${hh}h` : `${d}d`;
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

/** The visual marker for a run that did NOT count, resolved from BOTH the game outcome (`status`)
 *  and the converter's verdict (`quality`) so each reason reads distinctly — a wipe, an abandon, a
 *  too-short clear, a partial capture, and a bugged read no longer collapse to one icon/colour. */
export interface RunOutcomeBadge {
  /** The lucide icon component for this outcome (rendered as `<badge.Icon … />`). */
  Icon: LucideIcon;
  /** Short, self-contained label for the SR hint + detail-banner heading. */
  label: string;
  /** Plain-language explanation shown on hover (list) and in the banner (detail). */
  title: string;
  /** Text colour for the marker icon in the runs list + detail banner. */
  iconClass: string;
  /** Background tint applied to the WHOLE runs-list row, so a non-counted run reads as set-apart. */
  rowClass: string;
  /** Border + tinted background + text for the detail-view banner container. */
  noticeClass: string;
}

// One marker per run, picked by PRECEDENCE over (status, quality):
//   bugged (degraded data) > failed (wipe) > abandoned > partial > too-short (skipped) > counted.
// A clean counted clear (and a legacy run with no verdict) returns null = no marker. This is PURELY
// COSMETIC — it mirrors, and never alters, the counting/hiding the `quality` verdict drives
// (qualityBadge stays the source for those). Each entry's icon colour family matches its row tint
// and banner triple; label/title are dict KEYS so the marker follows the app language.
type OutcomeStyle = {
  Icon: LucideIcon;
  labelKey: Parameters<Translate>[0];
  titleKey: Parameters<Translate>[0];
  iconClass: string;
  rowClass: string;
  noticeClass: string;
};
const OUTCOME_BUGGED: OutcomeStyle = {
  Icon: Bug,
  labelKey: "outcome.buggedLabel",
  titleKey: "outcome.buggedTitle",
  iconClass: "text-rose-400",
  rowClass: "bg-rose-500/10",
  noticeClass: "border-rose-500/30 bg-rose-500/10 text-rose-200",
};
const OUTCOME_FAILED: OutcomeStyle = {
  Icon: Skull,
  labelKey: "outcome.failedLabel",
  titleKey: "outcome.failedTitle",
  iconClass: "text-red-400",
  rowClass: "bg-red-500/10",
  noticeClass: "border-red-500/30 bg-red-500/10 text-red-200",
};
const OUTCOME_ABANDONED: OutcomeStyle = {
  Icon: LogOut,
  labelKey: "outcome.abandonedLabel",
  titleKey: "outcome.abandonedTitle",
  iconClass: "text-slate-400",
  rowClass: "bg-slate-500/10",
  noticeClass: "border-slate-500/30 bg-slate-500/10 text-slate-200",
};
const OUTCOME_PARTIAL: OutcomeStyle = {
  Icon: CircleSlash,
  labelKey: "outcome.partialLabel",
  titleKey: "outcome.partialTitle",
  iconClass: "text-amber-400",
  rowClass: "bg-amber-500/10",
  noticeClass: "border-amber-500/30 bg-amber-500/10 text-amber-200",
};
const OUTCOME_TOO_SHORT: OutcomeStyle = {
  Icon: TimerOff,
  labelKey: "outcome.tooShortLabel",
  titleKey: "outcome.tooShortTitle",
  iconClass: "text-zinc-400",
  rowClass: "bg-zinc-500/10",
  noticeClass: "border-zinc-500/30 bg-zinc-500/10 text-zinc-200",
};

/** Pick the single outcome style for a run by precedence, or null when it is a clean counted clear
 *  (or a legacy run with no verdict — both render unmarked). Bad data wins over the game outcome,
 *  which wins over a partial capture, which wins over a too-short clear. */
function outcomeStyle(status: RunStatus, quality: RunQuality | undefined): OutcomeStyle | null {
  if (quality === "degraded") return OUTCOME_BUGGED;
  if (status === "fail") return OUTCOME_FAILED;
  if (status === "abandoned") return OUTCOME_ABANDONED;
  if (quality === "partial") return OUTCOME_PARTIAL;
  if (quality === "skipped") return OUTCOME_TOO_SHORT;
  return null;
}

/** The outcome marker (icon + colour + label) for a run, or null for a clean counted clear. Reads
 *  BOTH `status` and `quality` so a wipe, an abandon, a too-short clear, a partial capture and a
 *  bugged read are visually distinct in the runs list and the detail banner. */
export function runOutcomeBadge(
  status: RunStatus,
  quality: RunQuality | undefined,
  t: Translate = tEn,
): RunOutcomeBadge | null {
  const style = outcomeStyle(status, quality);
  if (!style) return null;
  return {
    Icon: style.Icon,
    label: t(style.labelKey),
    title: t(style.titleKey),
    iconClass: style.iconClass,
    rowClass: style.rowClass,
    noticeClass: style.noticeClass,
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

/** Absolute local date+time: short date, medium time (includes seconds). `lang` (BCP47, from useI18n) follows the app
 *  language; undefined falls back to the OS locale's conventions (DD/MM vs MM/DD, 12/24h).
 *  Takes an epoch in MILLISECONDS (Redesign 2: run ts is ms; loadStructured normalizes
 *  legacy seconds -> ms). */
export function formatDateTime(tsMs: number, lang?: string): string {
  if (!Number.isFinite(tsMs) || tsMs <= 0) return "";
  return new Date(tsMs).toLocaleString(lang, {
    dateStyle: "short",
    timeStyle: "medium",
  });
}
