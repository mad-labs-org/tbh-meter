import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import { resolveOutputDir } from "./settings.js";
import {
  classifyOutcome,
  computeBackoffMs,
  isBlocked,
  isFailure,
  READER_HEALTHY_RUN_MS,
  type ExitInfo,
} from "./reader-policy.js";
import type { ReaderState, ReaderStatus } from "../shared/ipc-types.js";

// --------------------------------------------------------------------------- //
// Reader sidecar — the Python meter, frozen by CI into resources/reader/tbh-reader.exe
// and spawned as a MANAGED child so the user never opens a terminal. It writes
// raw/<id>.json (per-run, the converter cooks into logs/) + live.json (the live snapshot)
// into the SAME folder the sources read (resolveOutputDir), so reads and writes share one
// zero-config folder.
//
// Lifecycle: start on app ready (after the meter folder exists); the reader EXITS
// CLEANLY (code 0) when the game is not running, so on a clean exit we re-poll after
// a short delay — that lets it auto-attach once the game launches.
//
// Resilience (the hard-won part): tbh-reader.exe is an unsigned PyInstaller --onefile
// that reads the GAME's memory, which antivirus loves to terminate or quarantine. So:
//   • spawn() is GUARDED — a synchronous EPERM throw (Node does NOT route EPERM through
//     the 'error' event) used to escape and crash the main process; now it's a normal
//     spawn-failure we back off from.
//   • respawns BACK OFF (computeBackoffMs) instead of a fixed 5s, so a reader AV kills
//     every few seconds doesn't churn cold-restarts forever (which never converges and
//     just leaves the UI on a false "Starting up").
//   • after enough consecutive failures we surface a "blocked" status and let the UI
//     tell the user it's likely AV, with Retry.
//
// State is intentionally a handful of plain module vars (matching auto-update.ts)
// plus ONE pure derivation: getReaderState() reads them, nothing sets a
// status field. Late events from a superseded child are ignored by identity (proc===child).
//
// Platform guard: spawn ONLY on win32 AND only when the exe exists, so dev on macOS
// and the no-exe build are safe no-ops (the file-watching sources keep working).
// --------------------------------------------------------------------------- //

const READER_HZ = "10";
// The reader prints one of these once it reaches the game; seeing it means this attempt
// engaged a live game (vs the fast clean "[error] game is not open." exit). Used to show
// "starting" instead of "offline" while a real resolve is in flight.
const ENGAGED_RE = /attached|resolving|re-attaching|measuring/i;

/** Supervisor breadcrumb (spawn/end/respawn/healthy). Console-only: the reader's own
 *  on-disk meter.log / reader-diag.log are the durable diagnostics. */
function note(line: string): void {
  console.log(`[reader-supervisor] ${process.uptime().toFixed(1)}s ${line}`);
}

/** Forward each non-empty line of a child stream to `fn` (shared by stdout + stderr). */
function forEachLine(stream: NodeJS.ReadableStream | null, fn: (line: string) => void): void {
  stream?.on("data", (b: Buffer) => {
    for (const line of b.toString().split(/\r?\n/)) if (line) fn(line);
  });
}

/**
 * Absolute path to the bundled reader exe, or null when it can't exist here.
 * Packaged: extraResources copies resources/reader/ -> <resourcesPath>/reader/, so
 * the exe lives OUTSIDE app.asar (asar contents are not executable). Dev: there is
 * no built exe in the tree, so return null and let startReader() no-op.
 */
export function readerExePath(): string | null {
  if (!app.isPackaged) return null;
  if (process.platform === "win32") return join(process.resourcesPath, "reader", "tbh-reader.exe");
  if (process.platform === "linux") return join(process.resourcesPath, "reader", "meter_windows.py");
  return null;
}

function readerInvocation(exe: string): { file: string; prefixArgs: string[] } {
  if (process.platform === "linux") return { file: "python3", prefixArgs: [exe] };
  return { file: exe, prefixArgs: [] };
}

let child: ChildProcess | null = null;
let quitting = false;
let managing = false; // true between startReader and stopReader
let respawnTimer: ReturnType<typeof setTimeout> | null = null;
let healthyTimer: ReturnType<typeof setTimeout> | null = null;
let failStreak = 0; // consecutive failures (0 = healthy); drives backoff + blocked
let spawnedAt = 0; // Date.now() of the current attempt (for alive-time logging)
let engaged = false; // this attempt printed an attach/resolve line -> it reached the game

/** Reader status, DERIVED from the supervisor's facts — there is no status field to keep
 *  in sync. blocked > retrying/engaged > offline. */
export function getReaderState(): ReaderState {
  if (!managing) return "idle";
  if (isBlocked(failStreak)) return "blocked";
  if (failStreak > 0 || (child !== null && engaged)) return "starting";
  return "offline";
}

// Reader bring-up phase, surfaced to the startup splash (Discord-style). The reader
// prints lifecycle markers to stdout; we parse them below and fan them out from here.
let readerStatus: ReaderStatus = "searching";
export const readerEvents = new EventEmitter();

/** Current reader bring-up phase: "searching" until the game is found, "resolving"
 *  while it reads the game's memory (~1-2 min), "ready" once attached + resolved. */
export function getReaderStatus(): ReaderStatus {
  return readerStatus;
}

function setReaderStatus(next: ReaderStatus): void {
  if (next === readerStatus) return;
  readerStatus = next;
  readerEvents.emit("status", next);
}

/** True when this build will actually spawn the bundled reader (packaged Windows with
 *  the frozen exe present). Gates the startup splash: with no reader there is no
 *  "attached" signal to wait for. */
export function readerWillRun(): boolean {
  const exe = readerExePath();
  return !!exe && existsSync(exe);
}

/** Map a reader stdout line to a bring-up phase. Prefers the explicit "[[STATUS]] x"
 *  markers the reader emits; falls back to the human log lines so an OLDER reader exe
 *  (the app ships independently of the reader build) still drives the splash. */
function statusFromLine(line: string): ReaderStatus | null {
  const marker = /^\[\[STATUS\]\]\s+(searching|resolving|scanning|ready)\b/.exec(line);
  if (marker) return marker[1] as ReaderStatus;
  if (
    line.includes("Measuring per run") ||
    line.startsWith("[ok] resolved") ||
    line.includes("managers reused")
  )
    return "ready";
  // "resolving classes/instances" is the SLOW value-scan -> its own "scanning" phase.
  if (line.includes("resolving classes/instances")) return "scanning";
  if (line.startsWith("[ok] attached")) return "resolving";
  if (line.includes("game is not open")) return "searching";
  return null;
}

/**
 * Synchronously kill EVERY tbh-reader.exe — whole process tree (/t), forced (/f), BY IMAGE
 * NAME. Killing by name (not by a tracked PID) is deliberate: it catches PyInstaller
 * --onefile orphans (the bootloader can outlive or orphan its real child) and any stray
 * from a crashed prior session — a by-PID kill misses both. Called in two places:
 *   • before we spawn, so the app is the SINGLE owner (two readers attach to the game and
 *     each write the per-run raw/<id>.json under their OWN session — the root cause of
 *     duplicate runs + 2x-gold under contention; the reader also self-guards with a named
 *     mutex in shared/single_instance.py, but we clear the field first so OURS acquires it);
 *   • on quit (stopReader), so no reader survives the app.
 * Sync on purpose: pre-spawn the field must be clear before we spawn, and on quit it must
 * finish before will-quit lets the process exit — an async kill can be dropped on exit.
 * win32-only; a non-zero exit just means nothing was running.
 */
function killAllReaders(): void {
  if (process.platform !== "win32") return;
  try {
    execFileSync("taskkill", ["/f", "/t", "/im", "tbh-reader.exe"], { stdio: "ignore" });
  } catch {
    // taskkill exits non-zero when no tbh-reader.exe is running — the normal case.
  }
}

/** End-of-attempt handler. Updates the streak and schedules the next attempt with
 *  backoff. The async callers gate on identity + null `child` first, so this runs
 *  once per attempt and never for a superseded one. */
function onAttemptEnd(info: ExitInfo, errMsg?: string): void {
  if (healthyTimer) {
    clearTimeout(healthyTimer);
    healthyTimer = null;
  }
  if (quitting) return;

  const aliveMs = spawnedAt ? Date.now() - spawnedAt : 0;
  const outcome = classifyOutcome(info);
  note(
    `end ${outcome} code=${info.exitCode} sig=${info.signal} ` +
      `alive=${(aliveMs / 1000).toFixed(1)}s engaged=${engaged}${errMsg ? ` (${errMsg})` : ""}`,
  );

  if (isFailure(outcome)) {
    failStreak++;
  } else {
    failStreak = 0; // clean exit (code 0): normal "no game open" poll, or a graceful stop
  }

  const delay = computeBackoffMs(failStreak);
  note(`respawn in ${(delay / 1000).toFixed(1)}s (streak=${failStreak})`);
  if (respawnTimer) clearTimeout(respawnTimer);
  respawnTimer = setTimeout(attemptSpawn, delay);
}

/** Start one reader attempt: GUARDED spawn (EPERM never crashes). `child` is cleared first
 *  so any prior process's late events are ignored (proc !== child), which also supersedes a
 *  still-alive reader on manual retry. Re-resolves the exe so a quarantined-then-restored
 *  exe recovers and a vanished one surfaces as a failure. */
function attemptSpawn(): void {
  if (quitting) return;
  if (respawnTimer) {
    // Cancel a pending backoff: this attempt supersedes it (fired timer -> no-op; manual
    // retry / fresh start -> cancels the queued respawn so we don't double-spawn).
    clearTimeout(respawnTimer);
    respawnTimer = null;
  }
  child = null;
  spawnedAt = Date.now();
  engaged = false;

  const exe = readerExePath();
  if (!exe) return; // not packaged / off-win32 — managing should never be true here
  if (!existsSync(exe)) {
    note(`exe missing: ${exe}`);
    onAttemptEnd({ spawnError: true, exitCode: null, signal: null }, "reader exe missing (quarantined?)");
    return;
  }

  killAllReaders(); // be the only reader: clear strays before bringing ours up
  setReaderStatus("searching"); // fresh attempt -> splash shows "looking for the game"
  note(`spawn (streak=${failStreak})`);

  let proc: ChildProcess;
  try {
    // spawn(file, argsArray) bypasses the shell, so an outputDir containing spaces
    // (e.g. C:\Users\First Last\tbh-meter) is passed as a single argv element safely.
    const { file, prefixArgs } = readerInvocation(exe);
    proc = spawn(file, [...prefixArgs, "--output", resolveOutputDir(), "--hz", READER_HZ], {
      windowsHide: true, // no console/terminal window flashes for the user
      stdio: ["ignore", "pipe", "pipe"], // capture stdout/stderr for diagnostics; no stdin
      // NOT detached: this is a managed child we kill on quit.
    });
  } catch (err) {
    // EPERM (and other non-ENOENT spawn errors) are thrown SYNCHRONOUSLY by Node — the
    // 'error' handler below does NOT fire for them. Before this guard the throw escaped
    // (often from the respawn timer) and became an uncaught exception -> Electron's
    // "A JavaScript error occurred in the main process" dialog. Now: report + back off.
    const errMsg = err instanceof Error ? err.message : String(err);
    note(`spawn threw: ${errMsg}`);
    onAttemptEnd({ spawnError: true, exitCode: null, signal: null }, errMsg);
    return;
  }
  child = proc;
  healthyTimer = setTimeout(() => onHealthy(proc), READER_HEALTHY_RUN_MS);

  forEachLine(proc.stdout, (line) => {
    console.log(`[reader] ${line}`);
    note(`out ${line}`);
    // Engagement = reached the game. Only meaningful for the current child.
    if (proc === child && !engaged && ENGAGED_RE.test(line)) engaged = true;
    // Bring-up phase for the startup splash (searching -> resolving -> ready).
    const next = statusFromLine(line);
    if (next) setReaderStatus(next);
  });
  forEachLine(proc.stderr, (line) => {
    console.error(`[reader] ${line}`);
    note(`err ${line}`);
  });

  // Async spawn errors (ENOENT/EACCES) arrive here, not as a throw. Both handlers null
  // `child` first, so the other one (and any stale event) is ignored: one end per attempt.
  proc.on("error", (err) => {
    if (proc !== child) return;
    child = null;
    onAttemptEnd({ spawnError: true, exitCode: null, signal: null }, err.message);
  });
  proc.on("exit", (code, signal) => {
    if (proc !== child) return;
    child = null;
    onAttemptEnd({ spawnError: false, exitCode: code, signal });
  });
}

/** The reader stayed alive past the early-kill window, so whatever was killing it (AV, a
 *  transient) isn't this time — forget the failure streak (a healthy run that never exits
 *  would otherwise leave us stuck "blocked"). */
function onHealthy(proc: ChildProcess): void {
  healthyTimer = null;
  if (quitting || proc !== child) return;
  if (failStreak !== 0) note(`healthy: alive ${READER_HEALTHY_RUN_MS / 1000}s — clearing streak`);
  failStreak = 0;
}

/** Start (and keep alive) the reader. No-op off-win32 or when the exe is absent. */
export function startReader(): void {
  if (process.platform !== "win32" && process.platform !== "linux") return;
  if (managing) return; // already managing a reader — never run two
  const exe = readerExePath();
  if (!exe || !existsSync(exe)) {
    if (exe) console.warn(`[reader] exe not found, not spawning: ${exe}`);
    return;
  }
  quitting = false;
  managing = true;
  failStreak = 0;
  note("startReader");
  attemptSpawn();
}

/** Manual "Retry" from the blocked UI: forget the failure streak and respawn now. */
export function retryReader(): void {
  if (!managing || quitting) return;
  note("manual retry");
  failStreak = 0;
  attemptSpawn(); // clears any pending respawn timer itself
}

/** Stop respawning and kill the reader. Call from will-quit.
 *
 *  Windows: kill ALL tbh-reader.exe by image name (killAllReaders), NOT just the tracked
 *  child's PID. The old by-PID kill leaked a reader in two real cases — the bug where the
 *  reader outlived "Quit": (1) `child` is null at quit time (the reader exits + respawns on
 *  a timer whenever the game isn't open, so often there's no tracked PID), and (2) a
 *  PyInstaller --onefile bootloader had orphaned its real child, so killing the tracked
 *  PID's tree missed it. By-name + sync (taskkill runs to completion before the app exits)
 *  closes both. Off win32 there's just the one tracked child to reap. */
export function stopReader(): void {
  quitting = true;
  managing = false;
  if (respawnTimer) {
    clearTimeout(respawnTimer);
    respawnTimer = null;
  }
  if (healthyTimer) {
    clearTimeout(healthyTimer);
    healthyTimer = null;
  }
  const proc = child;
  child = null;
  if (process.platform === "win32") {
    killAllReaders();
  } else if (proc && proc.exitCode === null) {
    proc.kill();
  }
}
