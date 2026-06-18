import { app } from "electron";
import { release } from "node:os";
import { API_URL } from "./config.js";

// --------------------------------------------------------------------------- //
// Error reporting — relays unhandled errors to the API (POST /meter-errors),
// which forwards them to a private Discord channel ("Meter Log error" embeds);
// our stand-in for Sentry/Datadog. The Discord webhook lives SERVER-SIDE
// (Railway env), so nothing sensitive ships inside the binary. Everything is
// best-effort: reporting must never throw, block, or change crash semantics.
//
// Spam guards: identical (context, message) pairs are sent once per session,
// and a session sends at most MAX_REPORTS_PER_SESSION reports total (the API
// rate-limits per IP on top of this).
//
// Coverage:
//   - main process: uncaughtExceptionMonitor (observes WITHOUT swallowing the
//     crash) + unhandledRejection
//   - renderer/GPU/utility crashes: render-process-gone / child-process-gone
//     (suppressed once quitting — child-process teardown at shutdown is normal)
//   - renderer JS errors: window error/unhandledrejection -> meter:report-error
//     IPC (see renderer main.tsx + ipc.ts)
//   - explicit call sites: reportError() from catch blocks (e.g. share.ts)
// --------------------------------------------------------------------------- //

const MAX_REPORTS_PER_SESSION = 20;

// Caps mirror @tbh/shared's meterErrorReportSchema (the meter cannot import
// that package, so the limits are duplicated here — keep them in sync).
const MAX_CONTEXT = 120;
const MAX_MESSAGE = 1000;
const MAX_STACK = 2000;
const MAX_EXTRA_VALUE = 200;

const seen = new Set<string>();
let sent = 0;

// True once the app begins quitting. During shutdown Electron tears down the
// renderer/GPU/utility child processes, which fire *-process-gone with non-clean
// reasons ("killed"/"abnormal-exit") as NORMAL teardown — reporting those is
// false-alarm noise (it polluted #log-error on every quit). We gate process-gone
// reports on this flag rather than filter by reason, so a genuine mid-session
// crash (any reason) still reports.
let quitting = false;

/** Human-readable OS label. Node's release() reports the NT KERNEL version on Windows,
 *  which is still "10.0.x" on Windows 11 (builds >= 22000) — so raw values made every
 *  report read as Win10. Spell the product name out, keep the build for precision. */
function osLabel(): string {
  const rel = release();
  if (process.platform !== "win32") return `${process.platform} ${rel}`;
  const build = Number(rel.split(".")[2]);
  const name = build >= 22000 ? "Windows 11" : "Windows 10";
  return `${name} (${rel})`;
}

interface ErrorShape {
  message: string;
  stack?: string;
}

/** Normalize anything throwable into { message, stack }. Plain objects with a
 *  string `message` (e.g. API error bodies, IPC payloads) keep it; everything
 *  else is stringified. */
function describe(err: unknown): ErrorShape {
  if (err instanceof Error) return { message: err.message, stack: err.stack };
  if (typeof err === "object" && err !== null) {
    const { message, stack } = err as { message?: unknown; stack?: unknown };
    if (typeof message === "string") {
      return { message, stack: typeof stack === "string" ? stack : undefined };
    }
    try {
      return { message: JSON.stringify(err) };
    } catch {
      // fall through to String()
    }
  }
  return { message: String(err) };
}

/**
 * Report one error through the API relay. Fire-and-forget: failures are logged
 * locally and otherwise ignored. `extra` adds inline fields (e.g. HTTP status).
 * `logs` is sent as a Discord file attachment (meter.log tail + live.json snapshot).
 */
export function reportError(
  context: string,
  err: unknown,
  extra?: Record<string, string | number | undefined>,
  logs?: string,
): void {
  const { message, stack } = describe(err);
  const key = `${context}|${message}`;
  if (seen.has(key) || sent >= MAX_REPORTS_PER_SESSION) return;
  seen.add(key);
  sent++;

  const extraOut: Record<string, string> = {};
  for (const [name, value] of Object.entries(extra ?? {})) {
    if (value !== undefined) extraOut[name.slice(0, 40)] = String(value).slice(0, MAX_EXTRA_VALUE);
  }

  void fetch(`${API_URL}/meter-errors`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      context: context.slice(0, MAX_CONTEXT) || "unknown",
      message: message.slice(0, MAX_MESSAGE) || "(empty)",
      stack: stack?.slice(0, MAX_STACK),
      appVersion: app.getVersion().slice(0, 40),
      os: osLabel().slice(0, 80),
      packaged: app.isPackaged,
      extra: Object.keys(extraOut).length > 0 ? extraOut : undefined,
      logs: logs?.slice(0, 50_000),
    }),
  }).catch((sendErr) => {
    console.warn(
      `[error-report] relay failed: ${sendErr instanceof Error ? sendErr.message : String(sendErr)}`,
    );
  });
}

/** Install the global hooks. Call once, as early as possible in main/index.ts. */
export function installGlobalErrorReporting(): void {
  // Monitor variant: observes the exception without preventing the default
  // crash handling, so reporting never masks a genuinely fatal state.
  process.on("uncaughtExceptionMonitor", (err) => {
    reportError("main:uncaughtException", err);
  });
  process.on("unhandledRejection", (reason) => {
    console.error("[error-report] unhandled rejection:", reason);
    reportError("main:unhandledRejection", reason);
  });
  // Suppress process-gone reports once the app is quitting: child-process teardown
  // during shutdown is expected, not a fault. (Own flag — independent of index.ts.)
  app.on("before-quit", () => {
    quitting = true;
  });
  app.on("render-process-gone", (_event, _webContents, details) => {
    if (quitting || details.reason === "clean-exit") return;
    reportError("renderer:process-gone", details.reason, { exitCode: details.exitCode });
  });
  app.on("child-process-gone", (_event, details) => {
    if (quitting || details.reason === "clean-exit") return;
    reportError(`child:${details.type}:process-gone`, details.reason, {
      exitCode: details.exitCode,
    });
  });
}
