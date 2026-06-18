// --------------------------------------------------------------------------- //
// reader-policy — PURE decision logic for the reader supervisor (reader-process.ts).
// No electron/node imports, so it stays unit-testable without mocking the runtime;
// the supervisor wires these into the real spawn/timer/IPC machinery.
//
// Why this exists: the bundled reader (tbh-reader.exe — an UNSIGNED PyInstaller
// --onefile that reads the GAME's process memory) is routinely terminated or
// quarantined by antivirus. Two field-observed failure modes, both ours to survive:
//   • spawn EPERM — Node throws this SYNCHRONOUSLY (the child's 'error' event never
//     fires for it), so before we guarded the spawn() call it escaped as an uncaught
//     exception -> Electron's "A JavaScript error occurred in the main process" dialog.
//   • respawn churn — AV kills the reader a few seconds into each ~100s resolve; the
//     old FIXED 5s respawn loop just cold-restarted forever, so the meter sat on
//     "Starting up" for ~10 min and never converged (real capture from a user:
//     ~85 cold restarts in 7 min, each killed mid-resolve before it could cache).
//
// So we classify each spawn outcome and back off instead of hammering, and let the
// supervisor flip to a "blocked" state (auto-report + actionable UI) rather than an
// endless, lying "Starting up".
// --------------------------------------------------------------------------- //

/** Base respawn delay. Also the steady cadence for the normal "no game open yet"
 *  poll — the reader exits cleanly when no game is running and we re-attach on launch. */
export const READER_BASE_RESPAWN_MS = 5_000;
/** Ceiling for the exponential backoff applied to consecutive failures. */
export const READER_MAX_BACKOFF_MS = 60_000;
/** Stay-alive duration that proves the reader survived the early-kill window (the
 *  churn killed it at ~5s). Surviving this long resets the failure streak. */
export const READER_HEALTHY_RUN_MS = 30_000;
/** Consecutive failures before we declare the reader "blocked" (almost always AV). */
export const READER_BLOCKED_THRESHOLD = 5;

export type ReaderOutcome =
  /** The exe could not be launched at all (EPERM/ENOENT/EACCES) — locked/quarantined/missing. */
  | "spawn-failed"
  /** Launched but exited abnormally (non-zero code or a signal) — killed mid-run. */
  | "crashed"
  /** Exited 0 — the reader's normal "no game open, will re-poll" path (or a graceful stop). */
  | "clean";

export interface ExitInfo {
  /** A spawn() throw or the child's 'error' event fired — the process never really ran. */
  spawnError: boolean;
  /** The child 'exit' code (null when killed by a signal, or on a spawn error). */
  exitCode: number | null;
  /** The terminating signal, if any (mostly POSIX; Windows kills surface as a code). */
  signal: NodeJS.Signals | null;
}

/** Map a raw spawn/exit result to a coarse outcome the supervisor acts on. */
export function classifyOutcome(info: ExitInfo): ReaderOutcome {
  if (info.spawnError) return "spawn-failed";
  if (info.signal != null) return "crashed";
  // Clean code 0 is the reader's normal "no game open" exit; a null code with no
  // signal is ambiguous, so default it to clean rather than over-reporting AV.
  if (info.exitCode == null || info.exitCode === 0) return "clean";
  return "crashed";
}

/** A clean exit is expected (poll for the game); the other two are failures. */
export function isFailure(outcome: ReaderOutcome): boolean {
  return outcome !== "clean";
}

/** Exponential backoff from the consecutive-failure streak. streak<=0 -> base;
 *  1->base, 2->2x, 3->4x, ... capped at max. Keeps us from cold-restarting a reader
 *  AV is killing every few seconds (which never converges and just feeds the loop). */
export function computeBackoffMs(
  failStreak: number,
  base: number = READER_BASE_RESPAWN_MS,
  max: number = READER_MAX_BACKOFF_MS,
): number {
  if (failStreak <= 0) return base;
  return Math.min(base * 2 ** (failStreak - 1), max);
}

/** Whether a streak has reached the point we declare the reader blocked. */
export function isBlocked(
  failStreak: number,
  threshold: number = READER_BLOCKED_THRESHOLD,
): boolean {
  return failStreak >= threshold;
}
