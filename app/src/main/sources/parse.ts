// Reverse of the reader's fmt() humanized number format.
// fmt() (meter_windows.py): values < 1000 print as an integer with NO suffix;
// otherwise "%.2f" + one of K(1e3) M(1e6) B(1e9) T(1e12) P(1e15), dividing by 1000 per step.
// DPS values additionally carry a trailing "/s". Parsing is approximate (2 decimals).

const SUFFIX_FACTOR: Record<string, number> = {
  K: 1e3,
  M: 1e6,
  B: 1e9,
  T: 1e12,
  P: 1e15,
};

const HUMANIZED_RE = /^([+-]?[0-9]*\.?[0-9]+)\s*([KMBTP]?)/i;

/**
 * Parse a humanized number string (e.g. "6.66M", "70.20K/s", "147") back to a Number.
 * Strips a trailing "/s", tolerates surrounding whitespace, and applies the suffix factor.
 * Returns 0 when the input is empty or unparseable.
 */
export function parseHumanized(s: string | null | undefined): number {
  if (s == null) return 0;
  const trimmed = s.trim().replace(/\/s$/i, "").trim();
  if (trimmed === "") return 0;
  const m = HUMANIZED_RE.exec(trimmed);
  if (!m) return 0;
  const value = Number(m[1]);
  if (!Number.isFinite(value)) return 0;
  const suffix = m[2].toUpperCase();
  const factor = suffix ? (SUFFIX_FACTOR[suffix] ?? 1) : 1;
  return value * factor;
}

/** Parse the first integer found in a string (e.g. "147" from "mobs 147/601"); null if none. */
export function parseIntOr(s: string | null | undefined, fallback: number | null = null): number | null {
  if (s == null) return fallback;
  const m = /-?\d+/.exec(s);
  if (!m) return fallback;
  const n = Number.parseInt(m[0], 10);
  return Number.isFinite(n) ? n : fallback;
}
