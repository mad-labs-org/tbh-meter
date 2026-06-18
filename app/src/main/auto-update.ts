import { app, Notification } from "electron";
import { EventEmitter } from "node:events";
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import electronUpdater from "electron-updater";
import type { UpdateStatus } from "../shared/ipc-types.js";
import { reportError } from "./error-report.js";
import { httpFetch } from "./net-fetch.js";
import { resolveOutputDir } from "./settings.js";
import { isRcBuild } from "./variant.js";

// electron-updater is CommonJS; under ESM (electron-vite emits the main process as
// ESM) the singleton has to be pulled off the default export — a named import
// (`import { autoUpdater }`) is not reliably resolvable from the CJS module.
const { autoUpdater } = electronUpdater;

// A long-lived tray app can stay open for days, so a single on-launch check would
// miss anything published mid-session. 3min (was 30min): ships are announced on Discord
// and players reopen/refocus the meter right then expecting the new build — a half-hour
// blind window reads as "update is broken". A tick is two or three small anonymous
// requests to GitHub's web endpoints (not the rate-limited REST API), so 3min stays
// well within polite use; resting-guarded, so ticks never pile onto an active download.
const RECHECK_INTERVAL_MS = 3 * 60 * 1000; // 3min

// Foreground/wake triggers re-check on top of the interval (focus + power resume), but a
// burst of window focus changes must not hammer the GitHub feed — coalesce them: skip a
// triggered check if one already ran within this window.
const TRIGGERED_CHECK_COOLDOWN_MS = 10 * 60 * 1000; // 10min

// After a FAILED check, "error" means "don't know", not "up to date" — holding the full
// cooldown would leave the user pointlessly blind when they poke the app right after a
// flaky check (v0.31.0: the boot check missed the just-flipped release and every focus
// re-check for the next 10 minutes was swallowed). Small floor only, so focus churn on a
// dead network doesn't hammer checks that will just fail again.
const ERROR_RETRIGGER_COOLDOWN_MS = 30_000;

// Boot authority cross-check (runBootUpdateGate): the updater resolves "Latest" through
// GitHub's eventually-consistent public web pointer; the REST API answers from the origin.
// Right after a ship flips Latest the two can disagree (v0.31.0: a boot seconds around the
// flip was told "up to date") — when the REST origin says a NEWER version is shipped, the
// gate KNOWS the pointer is stale and re-checks until it converges, instead of trusting a
// single read. Anonymous REST quota is 60 req/h per IP and players can sit behind CGNAT,
// so any failure degrades to null = "no signal" and the gate behaves as before.
// owner/repo must match electron-builder.yml `publish`.
const RELEASES_LATEST_API_URL =
  "https://api.github.com/repos/mad-labs-org/tbh-meter-releases/releases/latest";
const AUTHORITY_TIMEOUT_MS = 3_000;
// Convergence budget once staleness is KNOWN: 8 × (3s + one check round-trip) ≈ 45s of
// splash typically. Not a hard wall-clock cap — each re-check is awaited in full so its
// download is never orphaned (an abandoned checkForUpdates with autoDownload leaks an
// unhandled downloadPromise rejection, the #204 bug class); a HUNG request is bounded by
// electron-updater's own 60s per-request timeout. Acceptable exactly because this only
// runs when a newer build is confirmed to exist (landing on it can skip a post-patch cold
// scan). Never converged → proceed; the 3min interval picks it up.
const CONVERGENCE_ATTEMPTS = 8;
const CONVERGENCE_DELAY_MS = 3_000;

// A staged download can fail transiently: most often electron-builder's
// non-deterministic "ENOENT … rename temp-*.exe" race (electron-builder #7063 /
// #3622), or an interrupted transfer (#2451) — both clear on a retry. Re-attempt
// the download a few times before giving up, instead of dropping the update until
// the next scheduled check (which strands users on an old build — and for an AV-affected
// user, an old build is exactly where the unsigned reader keeps getting killed).
const MAX_DOWNLOAD_RETRIES = 3;
const DOWNLOAD_RETRY_DELAY_MS = 10_000;

// Boot gate (checkAndApplyBootUpdate): how long to wait for the update CHECK — including
// its bounded retry — before giving up and letting the reader start. Bounds only the
// metadata fetch; once an update is confirmed, the download runs unbounded (progress shows
// on the splash). 8s fits one transient failure + retry; offline machines reject in
// milliseconds and never get near the cap, and a genuinely slow feed still falls through
// to the background-download path instead of stalling the boot.
const BOOT_CHECK_TIMEOUT_MS = 8_000;

// One transient failure must not cancel a boot update (the gate runs exactly once per
// launch — a single mis-answer otherwise strands the user until the next recheck window).
// Offline rejects fast, so the retry only stretches the boot when something actually
// answered badly.
const BOOT_CHECK_ATTEMPTS = 2;
const BOOT_CHECK_RETRY_DELAY_MS = 2_000;

const emitter = new EventEmitter();
const STATUS_EVENT = "status";

let status: UpdateStatus = { state: "idle" };
let started = false;
// When the last check() began — feeds the triggered-check cooldown. 0 = never checked
// (a triggered check right after launch is fine: the launch check sets this).
let lastCheckAt = 0;
// The version being fetched, carried across the available -> downloading -> downloaded
// events (download-progress doesn't include it).
let pendingVersion = "";

// ── Flight recorder ──────────────────────────────────────────────────────────
// Rolling log of updater state TRANSITIONS ("downloading" % ticks collapse) in the
// meter folder, next to the reader's meter.log, so it is reachable over the same
// share during triage. A packaged app keeps no console, which made the v0.31.0
// missed boot update undiagnosable after the fact (was the check wrong, or did it
// fail?) — this answers that next time. Best-effort only: a log failure must never
// disturb the updater.
const LOG_ROTATE_BYTES = 64 * 1024;
let logFile: string | null = null;

function logLine(text: string): void {
  try {
    if (logFile === null) {
      const path = join(resolveOutputDir(), "updater.log");
      mkdirSync(dirname(path), { recursive: true });
      logFile = path; // only memoize once the dir exists — else retry next line
    }
    // Rotate on every line, not just at startup: transitions are sparse (one stat is
    // noise next to the append), and a long-lived tray session must not grow unbounded.
    try {
      if (statSync(logFile).size > LOG_ROTATE_BYTES) renameSync(logFile, `${logFile}.old`);
    } catch {
      // no file yet
    }
    appendFileSync(logFile, `${new Date().toISOString()} ${text}\n`);
  } catch {
    // best-effort telemetry only
  }
}

function setStatus(next: UpdateStatus): void {
  // updaterSupported() gate: dev/macOS walk a FAKE status sequence for the splash
  // preview (__devSetUpdateStatus) — keep that out of the flight recorder.
  if (next.state !== status.state && updaterSupported()) {
    logLine(
      next.state === "error"
        ? `error: ${next.message}`
        : "version" in next
          ? `${next.state} ${next.version}`
          : next.state,
    );
  }
  status = next;
  emitter.emit(STATUS_EVENT, status);
}

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Latest status — for windows opened after an event already fired (broadcasts only
 *  reach windows that exist at emit time). */
export function getUpdateStatus(): UpdateStatus {
  return status;
}

/** Subscribe to status changes; returns an unsubscribe fn (mirrors the file sources). */
export function onUpdateStatus(cb: (status: UpdateStatus) => void): () => void {
  emitter.on(STATUS_EVENT, cb);
  return () => emitter.off(STATUS_EVENT, cb);
}

/** Only the packaged Windows NSIS install can self-update. Dev (not packaged) and macOS
 *  have no update feed, so the updater stays dormant ("idle") there. The RC variant is a
 *  throwaway side-by-side test build — it must NOT self-update (its feed would otherwise
 *  drag it toward the promoted stable release), so it stays dormant too. Exported so the
 *  renderer can gate its manual "Check for updates" button on installs that can update. */
export function updaterSupported(): boolean {
  return app.isPackaged && process.platform === "win32" && !isRcBuild();
}

/**
 * Await a staged download, retrying a bounded number of times on failure.
 *
 * electron-updater's auto-download promise (returned by `checkForUpdates` when
 * autoDownload is on) can reject with a transient "ENOENT rename" race or an
 * interrupted transfer. Left
 * unawaited it escapes BOTH the `error` event and a `.catch()` on the call — it only
 * surfaces as an `unhandledRejection` (electron-builder #2451) — and the staged update
 * is silently lost. Awaiting it here pins the failure to a place we can handle, and a
 * fresh download attempt (`redownload`) clears the non-deterministic rename race that a
 * single try hits. Deps are injected so the retry logic is unit-testable without Electron.
 */
export async function awaitDownloadWithRetry(
  initial: Promise<unknown>,
  redownload: () => Promise<unknown>,
  opts: {
    maxRetries?: number;
    delayMs?: number;
    sleep?: (ms: number) => Promise<void>;
    onRetry?: (attempt: number, err: unknown) => void;
  } = {},
): Promise<void> {
  const maxRetries = opts.maxRetries ?? MAX_DOWNLOAD_RETRIES;
  const delayMs = opts.delayMs ?? DOWNLOAD_RETRY_DELAY_MS;
  const sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  let pending = initial;
  for (let attempt = 1; ; attempt++) {
    try {
      await pending;
      return; // success: 'update-downloaded' has already set the status
    } catch (err) {
      if (attempt > maxRetries) throw err; // exhausted — let the caller surface status:error
      opts.onRetry?.(attempt, err);
      await sleep(delayMs);
      pending = redownload(); // a settled promise can't be re-awaited — start a fresh one
    }
  }
}

async function check(): Promise<void> {
  lastCheckAt = Date.now();
  try {
    // checkForUpdates (NOT ...AndNotify): the AndNotify variant chains its own
    // catch-less .then() onto the download promise to fire the OS notification, which
    // re-introduces the very unhandledRejection we're catching on a failed download
    // (field-observed: AV quarantining the temp installer -> ENOENT on the final rename
    // in the updater cache). We await the download ourselves — with a bounded retry for
    // the non-deterministic rename race (electron-builder #7063 / #2451), so a transient
    // failure still ends in an applied update instead of waiting for the next scheduled check —
    // and re-create the "update ready" notification in the update-downloaded handler below.
    const result = await autoUpdater.checkForUpdates();
    if (result?.downloadPromise) {
      await awaitDownloadWithRetry(result.downloadPromise, () => autoUpdater.downloadUpdate(), {
        onRetry: (attempt, err) =>
          console.warn(
            `[auto-update] download attempt ${attempt} failed ` +
              `(${err instanceof Error ? err.message : String(err)}); retrying`,
          ),
      });
    }
  } catch (err) {
    // Download-phase failures (status got past "checking") are high-signal: AV
    // quarantining the installer strands users on old versions. Check-phase failures
    // are mostly offline machines — status-only, no report.
    if (status.state === "downloading") reportError("updater:download-failed", err);
    setStatus({ state: "error", message: err instanceof Error ? err.message : String(err) });
  }
}

let wired = false;

/** Register the electron-updater event→status bridge exactly once. Split out of
 *  initAutoUpdate so the boot gate (checkAndApplyBootUpdate) can wire it up BEFORE the
 *  periodic interval is scheduled — the splash subscribes to these same status events to
 *  drive the "updating"/"restarting" screens. */
function wireEvents(): void {
  if (wired) return;
  wired = true;

  autoUpdater.on("checking-for-update", () => setStatus({ state: "checking" }));
  autoUpdater.on("update-available", (info) => {
    pendingVersion = info.version;
    setStatus({ state: "available", version: info.version });
  });
  autoUpdater.on("update-not-available", () => setStatus({ state: "up-to-date" }));
  autoUpdater.on("download-progress", (p) =>
    setStatus({ state: "downloading", version: pendingVersion, percent: Math.round(p.percent) }),
  );
  autoUpdater.on("update-downloaded", (info) => {
    pendingVersion = info.version;
    setStatus({ state: "downloaded", version: info.version });
    // Replaces checkForUpdatesAndNotify's built-in nudge (same copy as its default) — a
    // zero-UI heads-up even if the Settings window is closed. (On the boot gate the app
    // relaunches immediately, so this is only ever seen for a mid-session download.)
    new Notification({
      title: "A new update is ready to install",
      body: `${app.name} version ${info.version} has been downloaded and will be automatically installed on exit`,
    }).show();
  });
  autoUpdater.on("error", (err) => setStatus({ state: "error", message: errMsg(err) }));
}

/** Wire electron-updater + arm the periodic re-check. No-op off the supported NSIS-Windows
 *  install. The LAUNCH check is the boot gate (checkAndApplyBootUpdate), which runs before
 *  the reader; this only arms the long-running backstop so an app left open for hours still
 *  picks up a release published mid-session. Defaults match the goal: autoDownload
 *  (background) + autoInstallOnAppQuit (apply on next quit). */
export function initAutoUpdate(): void {
  if (started || !updaterSupported()) return;
  started = true;
  wireEvents();
  // Don't let the recheck timer alone keep the app alive — the tray/windows do that.
  // Resting-guarded like every non-manual trigger: a tick that lands mid-download or
  // on a staged update must not re-enter checkForUpdates.
  setInterval(() => {
    if (isResting(status.state)) void check();
  }, RECHECK_INTERVAL_MS).unref();
}

/** A check may run only from a resting state — while checking / downloading / staged, a
 *  re-check would just re-announce the same update. Pure for testing. */
function isResting(state: UpdateStatus["state"]): boolean {
  return state === "idle" || state === "up-to-date" || state === "error";
}

/** Whether a *triggered* (focus / power-resume) check should run now: resting, and not
 *  within the cooldown of the previous check. Manual checks bypass the cooldown. Pure so
 *  the throttle is unit-testable without Electron. */
export function shouldTriggeredCheck(
  state: UpdateStatus["state"],
  lastCheckAt: number,
  now: number,
  cooldownMs: number,
): boolean {
  return isResting(state) && now - lastCheckAt >= cooldownMs;
}

/** Cooldown a triggered check must respect given the current state: the full window
 *  normally, a short floor after a FAILED check (an error is "don't know", not "current",
 *  so the user poking the app should retry promptly). Pure for testing. */
export function triggeredCooldownFor(state: UpdateStatus["state"]): number {
  return state === "error" ? ERROR_RETRIGGER_COOLDOWN_MS : TRIGGERED_CHECK_COOLDOWN_MS;
}

/** Manual on-demand check (the Settings "Check for updates" button). Funnels into the
 *  same status pipeline as the scheduled checks. No-op mid-flight: while checking /
 *  downloading / staged, a re-check would only re-announce the same update. */
export function checkForUpdates(): void {
  if (!started) return;
  if (!isResting(status.state)) return;
  void check();
}

/** Re-check on a foreground/wake trigger (window focus, power resume). With the 3min
 *  interval refreshing lastCheckAt on every tick, the 10min cooldown means this fires
 *  mostly after a system sleep (suspended timers → lastCheckAt aged) and after an error
 *  (30s floor) — the moments the interval alone covers poorly. */
export function checkForUpdatesThrottled(): void {
  if (!started) return;
  if (
    !shouldTriggeredCheck(status.state, lastCheckAt, Date.now(), triggeredCooldownFor(status.state))
  ) {
    return;
  }
  void check();
}

/** Quit and apply a staged update now (the "restart to update" affordance). Only valid
 *  once an update is downloaded. forceRunAfter relaunches the app; the installer is shown
 *  (oneClick:false) to match this build's deliberately-visible install flow. */
export function quitAndInstallUpdate(): void {
  if (status.state !== "downloaded") return;
  autoUpdater.quitAndInstall(false, true);
}

/** Strict X.Y.Z numeric compare: is `a` newer than `b`? The meter never ships prerelease
 *  stables, so plain numeric segments suffice (and "0.10.0" > "0.9.1" works, where a string
 *  compare would not). Malformed input never claims newer. Pure for testing. */
export function isNewerVersion(a: string, b: string): boolean {
  if (a === "" || b === "") return false; // "" splits to [0] and would read as 0.0.0
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (Number.isNaN(x) || Number.isNaN(y)) return false;
    if (x !== y) return x > y;
  }
  return false;
}

/** The authoritative "what version is shipped" fact (see RELEASES_LATEST_API_URL). Null on
 *  ANY failure — offline, 403 (anonymous quota / CGNAT), unexpected payload — so the boot
 *  gate silently falls back to trusting the updater's own answer. Exported so the
 *  never-rejects contract is pinned by tests (stubbed global fetch). */
export async function fetchLatestShippedVersion(): Promise<string | null> {
  try {
    const res = await httpFetch(RELEASES_LATEST_API_URL, {
      headers: { accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(AUTHORITY_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const tag = ((await res.json()) as { tag_name?: string }).tag_name ?? "";
    const m = /^tbh-meter-v(\d+\.\d+\.\d+)$/.exec(tag);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * Pure boot-update decision (all I/O injected, so it unit-tests without Electron):
 *
 *  - unsupported install            → "proceed" (start the reader; never checks)
 *  - up-to-date, no authority signal → "proceed"
 *  - up-to-date, but `authoritativeVersion` (REST origin) says a NEWER version is shipped
 *                                   → the pointer the updater read is provably stale:
 *                                      re-check until it converges (bounded:
 *                                      `convergenceAttempts`), then download+apply; never
 *                                      converged → "proceed" (the interval picks it up)
 *  - check fails                    → retry (bounded: `checkAttempts`); all attempts fail
 *                                      → "proceed" (an error never blocks the boot)
 *  - check slower than `timeoutMs`  → "proceed" now; if the late check still finds an update,
 *                                      `drainBackgroundDownload` keeps its download handled
 *                                      (no unhandledRejection; it installs on next quit)
 *  - update found, download ok      → `apply()` (quitAndInstall) → "updated"
 *  - update found, download fails   → `onDownloadFail` + "proceed" (never strand the user
 *                                      behind the splash — the cold scan still works)
 *
 * The timeout bounds only the initial CHECK (attempts included); a confirmed download runs
 * unbounded (progress on the splash), and convergence runs past the timeout on purpose — it
 * only starts once a newer build is KNOWN to exist. `authoritativeVersion` must be internally
 * time-bounded and resolve null on failure (never reject — a `.catch` guards it anyway).
 * `retrySleep` is injected separately from `sleep` (the timeout clock) so tests can freeze
 * one without freezing the other; it also paces the convergence loop.
 */
export async function runBootUpdateGate(deps: {
  supported: boolean;
  check: () => Promise<{ hasUpdate: boolean; download: () => Promise<void> }>;
  apply: () => void;
  timeoutMs?: number;
  checkAttempts?: number;
  checkRetryDelayMs?: number;
  authoritativeVersion?: () => Promise<string | null>;
  currentVersion?: string;
  convergenceAttempts?: number;
  convergenceDelayMs?: number;
  onKnownStale?: (shippedVersion: string) => void;
  drainBackgroundDownload?: (download: () => Promise<void>) => void;
  onDownloadFail?: (err: unknown) => void;
  sleep?: (ms: number) => Promise<void>;
  retrySleep?: (ms: number) => Promise<void>;
}): Promise<"updated" | "proceed"> {
  if (!deps.supported) return "proceed";
  const timeoutMs = deps.timeoutMs ?? BOOT_CHECK_TIMEOUT_MS;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const retrySleep = deps.retrySleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const attempts = Math.max(1, deps.checkAttempts ?? BOOT_CHECK_ATTEMPTS);
  const retryDelayMs = deps.checkRetryDelayMs ?? BOOT_CHECK_RETRY_DELAY_MS;

  // Fire the authority lookup alongside the check: the updater answers "what does the
  // public pointer serve", this answers "what is actually shipped". Resolves null when
  // there is no signal (not injected / failed / rate-limited).
  const authorityPromise: Promise<string | null> = deps.authoritativeVersion
    ? deps.authoritativeVersion().catch(() => null)
    : Promise.resolve(null);

  // The gate runs exactly once per launch, so one transient mis-answer must not cancel
  // the boot update — re-attempt before concluding "no update" (v0.31.0 incident).
  const attemptCheck = async (): Promise<{ hasUpdate: boolean; download: () => Promise<void> }> => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await deps.check();
      } catch (err) {
        if (attempt >= attempts) throw err;
        await retrySleep(retryDelayMs);
      }
    }
  };

  const downloadAndApply = async (result: {
    download: () => Promise<void>;
  }): Promise<"updated" | "proceed"> => {
    // apply() shares the catch: a synchronous throw out of quitAndInstall must degrade to
    // "proceed" (reader starts, staged update applies on next quit via autoInstallOnAppQuit),
    // never reject the gate — a rejection here would silently abort the caller's whole boot
    // sequence. onDownloadFail doubles as the generic surfacer (status:error; it only files
    // an error report while state is still "downloading", so an apply throw doesn't misfile).
    try {
      await result.download();
      deps.apply();
    } catch (err) {
      deps.onDownloadFail?.(err);
      return "proceed";
    }
    return "updated";
  };

  // All attempts failed (offline / feed error) → "no update" — the wired `error` event
  // already surfaced status; never let a rejection escape and block the boot.
  const checkPromise = attemptCheck().catch(() => ({
    hasUpdate: false,
    download: () => Promise.resolve(),
  }));
  // Race the check against the timeout, tagging each branch so the winner is unambiguous
  // (a bare symbol sentinel widens to `symbol` through Promise.race and won't narrow).
  const raced = await Promise.race([
    checkPromise.then((r) => ({ kind: "result" as const, result: r })),
    sleep(timeoutMs).then(() => ({ kind: "timeout" as const })),
  ]);

  if (raced.kind === "timeout") {
    // Slow check: don't hold the boot — a network this slow shouldn't also pay the
    // convergence loop. If the late check still finds an update, keep its download
    // handled (no unhandledRejection); it installs on the next quit, like a mid-session one.
    void checkPromise.then((r) => {
      if (r.hasUpdate) deps.drainBackgroundDownload?.(r.download);
    });
    return "proceed";
  }

  const { result } = raced;
  if (result.hasUpdate) return downloadAndApply(result);

  // "Up to date" — cross-check against the authority before believing it. A newer shipped
  // version means the pointer the updater read is provably stale (it happens for a moment
  // right after a ship flips Latest): converge instead of trusting the single read.
  // Raced against the timeout clock as a belt-and-suspenders bound — the real injection is
  // AbortSignal-bounded, but the gate must not hang on a foreign one.
  const shipped = await Promise.race([authorityPromise, sleep(timeoutMs).then(() => null)]);
  const current = deps.currentVersion ?? "";
  if (shipped === null || current === "" || !isNewerVersion(shipped, current)) {
    return "proceed";
  }

  deps.onKnownStale?.(shipped);
  const convergenceAttempts = Math.max(1, deps.convergenceAttempts ?? CONVERGENCE_ATTEMPTS);
  const convergenceDelayMs = deps.convergenceDelayMs ?? CONVERGENCE_DELAY_MS;
  for (let i = 0; i < convergenceAttempts; i++) {
    await retrySleep(convergenceDelayMs);
    // A convergence re-check that fails is just "not yet" — keep going until the budget ends.
    const again = await deps.check().catch(() => null);
    if (again?.hasUpdate) return downloadAndApply(again);
  }
  return "proceed";
}

/**
 * Boot gate: check GitHub for a newer release BEFORE the reader starts and, if there is one,
 * download it + relaunch (quitAndInstall). On a game-patch day this lands the user on a build
 * whose bundled seed matches the new game — skipping the 2–5 min cold scan the stale seed
 * would otherwise force. Returns "updated" when the app is relaunching (the caller must NOT
 * start the reader) or "proceed" when there's nothing to do / it fell back to the reader.
 */
export async function checkAndApplyBootUpdate(): Promise<"updated" | "proceed"> {
  wireEvents();
  let result: "updated" | "proceed";
  try {
    result = await runBootUpdateGate({
      supported: updaterSupported(),
      check: async () => {
        lastCheckAt = Date.now();
        const result = await autoUpdater.checkForUpdates();
        // autoDownload is on, so a present downloadPromise == a newer version is being fetched.
        const dl = result?.downloadPromise ?? null;
        return {
          hasUpdate: dl !== null,
          download: () =>
            dl
              ? awaitDownloadWithRetry(dl, () => autoUpdater.downloadUpdate(), {
                  onRetry: (attempt, err) =>
                    console.warn(
                      `[auto-update] boot download attempt ${attempt} failed (${errMsg(err)}); retrying`,
                    ),
                })
              : Promise.resolve(),
        };
      },
      // Silent install (isSilent=true): this is an UNATTENDED boot update, so the NSIS installer
      // runs hidden — the user just sees the splash's "restarting" then the app reopens already
      // updated, with no installer window flashing. Safe because the meter installs per-user
      // (AppData\Local → no UAC elevation). The MANUAL "restart to update" path
      // (quitAndInstallUpdate) intentionally stays VISIBLE (false): there the user chose to update.
      apply: () => autoUpdater.quitAndInstall(true, true),
      authoritativeVersion: fetchLatestShippedVersion,
      currentVersion: app.getVersion(),
      onKnownStale: (shipped) =>
        logLine(
          `boot-gate stale pointer: ${shipped} shipped > ${app.getVersion()} installed; converging`,
        ),
      drainBackgroundDownload: (download) =>
        void download().catch((err) => setStatus({ state: "error", message: errMsg(err) })),
      onDownloadFail: (err) => {
        if (status.state === "downloading") reportError("updater:download-failed", err);
        setStatus({ state: "error", message: errMsg(err) });
      },
    });
  } catch (err) {
    // Absolute backstop: NOTHING in update-land may stop the reader from starting. Every
    // inner path already resolves (check retries, authority, download and apply all carry
    // their own catches) — this catches the residue, e.g. a synchronous throw out of a
    // wired callback, and turns it into a normal "proceed" boot.
    logLine(`boot-gate crashed: ${errMsg(err)}`);
    setStatus({ state: "error", message: errMsg(err) });
    result = "proceed";
  }
  // Anchor the gate's conclusion in the flight recorder: "boot-gate proceed" right after
  // an `up-to-date` line = the check answered current; right after `error:` = it failed;
  // right after `checking` = it timed out. Transitions alone can't anchor that moment.
  if (updaterSupported()) logLine(`boot-gate ${result}`);
  return result;
}

/** DEV-ONLY splash preview hook: drive the update-status pipeline without a real updater
 *  (updaterSupported() is false on macOS/dev), so the "updating"/"restarting" screens can be
 *  walked end-to-end. A hard no-op in any packaged build, so it can never fire in production. */
export function __devSetUpdateStatus(next: UpdateStatus): void {
  if (app.isPackaged) return;
  setStatus(next);
}
