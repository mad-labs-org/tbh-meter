// Session derivation (Redesign 2). A "session" is just a GROUPING label over runs — a continuous
// grind — NOT part of a run's identity (that's the run's own end-ts, raw v2). The reader no longer
// emits a session; the APP derives it here from the run timestamps + the user's manual "Nova sessão"
// cuts. Pure + deterministic: same runs + same cuts -> same grouping (so re-deriving on every load
// is stable, and an already-uploaded run keeps the session it had at upload). See progress.md
// "Redesign 2 — Session = derivada pelo APP".

/** Idle gap that starts a new session: 6h with no run. In MILLISECONDS — v2 run timestamps are ms.
 *  System rule (not a user setting); mirrors the reader's old SESSION_GAP_SECONDS, now app-side. */
export const SESSION_GAP_MS = 6 * 60 * 60 * 1000;

/** The minimal run shape the derivation needs: the id and the end-timestamp (ms, raw v2). */
export interface SessionableRun {
  id: string;
  ts: number;
}

/**
 * Derive the session each run belongs to, returning `id -> sessionId`. A run starts a NEW session
 * when EITHER the gap from the previous run exceeds SESSION_GAP_MS, OR a manual cut timestamp falls
 * after the previous run and at/through this one. The session id is the `ts` (ms) of the FIRST run
 * of the group, as a string — meaningful ("grind started at T") and stable.
 *
 * Pure + order-independent: runs are sorted oldest-first internally, so the caller can pass them in
 * any order (the app holds them newest-first). Deterministic for a given (runs, cuts) set.
 *
 * Operates on v2 (ms) timestamps only — legacy v1 runs already carry their original sessionId and
 * must NOT be re-derived (the caller filters those out).
 */
export function deriveSessions(runs: SessionableRun[], cutsMs: readonly number[] = []): Map<string, string> {
  const sorted = [...runs].sort((a, b) => a.ts - b.ts);
  const cuts = [...cutsMs].sort((a, b) => a - b);
  const out = new Map<string, string>();
  let label: string | null = null;
  let prevTs: number | null = null;
  for (const run of sorted) {
    const gapBreak = prevTs !== null && run.ts - prevTs > SESSION_GAP_MS;
    // A cut "between" the previous run and this one (exclusive of prev, inclusive of this) opens a
    // new session at this run — the user pressed "Nova sessão" while idle before this run.
    const cutBreak = prevTs !== null && cuts.some((c) => c > prevTs! && c <= run.ts);
    if (label === null || gapBreak || cutBreak) label = String(run.ts);
    out.set(run.id, label);
    prevTs = run.ts;
  }
  return out;
}
