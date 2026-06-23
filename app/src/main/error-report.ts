import { app } from "electron";
import { release } from "node:os";
import { API_URL } from "./config.js";
import { httpFetch } from "./net-fetch.js";

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

export interface ErrorCause {
  /** Lower-level error code, e.g. UNABLE_TO_VERIFY_LEAF_SIGNATURE / ECONNREFUSED / ETIMEDOUT. */
  code?: string;
  /** The cause's own message. */
  message?: string;
}

/** Pull the underlying transport reason out of an error's `.cause`. undici (Node's
 *  global fetch) wraps the real failure — a self-signed-cert / proxy / DNS error —
 *  in `err.cause` while the top-level message is only "fetch failed", so the cause
 *  is the diagnostic signal. Returns empty fields when there is no usable cause. */
export function describeCause(err: unknown): ErrorCause {
  if (typeof err !== "object" || err === null || !("cause" in err)) return {};
  const cause = (err as { cause?: unknown }).cause;
  if (typeof cause !== "object" || cause === null) {
    return typeof cause === "string" && cause !== "" ? { message: cause } : {};
  }
  const { message, code } = cause as { message?: unknown; code?: unknown };
  return {
    code: typeof code === "string" && code !== "" ? code : undefined,
    message: typeof message === "string" && message !== "" ? message : undefined,
  };
}

/** Render a cause as a short "[CODE: message]" suffix (either part optional). */
function causeSuffix(cause: ErrorCause): string {
  if (!cause.code && !cause.message) return "";
  if (cause.code && cause.message) return ` [${cause.code}: ${cause.message}]`;
  return ` [${cause.code ?? cause.message}]`;
}

/** Normalize anything throwable into { message, stack }. Plain objects with a
 *  string `message` (e.g. API error bodies, IPC payloads) keep it; everything
 *  else is stringified. The underlying `.cause` (when present) is appended to both
 *  message and stack so a wrapped transport failure ("fetch failed" -> the real
 *  UNABLE_TO_VERIFY_LEAF_SIGNATURE / ECONNREFUSED) is visible in the report. */
function describe(err: unknown): ErrorShape {
  const suffix = causeSuffix(describeCause(err));
  if (err instanceof Error) {
    return {
      message: `${err.message}${suffix}`,
      stack: err.stack ? `${err.stack}${suffix}` : suffix || undefined,
    };
  }
  if (typeof err === "object" && err !== null) {
    const { message, stack } = err as { message?: unknown; stack?: unknown };
    if (typeof message === "string") {
      const stackStr = typeof stack === "string" ? stack : undefined;
      return {
        message: `${message}${suffix}`,
        stack: stackStr ? `${stackStr}${suffix}` : suffix || undefined,
      };
    }
    try {
      return { message: `${JSON.stringify(err)}${suffix}` };
    } catch {
      // fall through to String()
    }
  }
  return { message: `${String(err)}${suffix}` };
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
  // Always carry the Electron/Chromium build — the GPU/renderer process-gone crashes are
  // version-specific (the transparent-overlay GPU issue is an Electron-version trait), so this is
  // load-bearing debug context on EVERY report. (Absent when not running under Electron, e.g. tests.)
  if (process.versions.electron) extraOut["electron"] = process.versions.electron;
  if (process.versions.chrome) extraOut["chromium"] = process.versions.chrome;

  // The relay rides Electron's net stack (net.fetch — honors the system proxy and
  // OS cert store, unlike Node's undici). net.fetch THROWS if called before the app
  // is ready, and the global uncaughtException/unhandledRejection hooks can fire
  // during early startup — so skip the relay (best-effort, never throw) until ready.
  if (!app.isReady()) {
    console.warn(`[error-report] dropped pre-ready report (${context}): ${message}`);
    return;
  }

  void httpFetch(`${API_URL}/meter-errors`, {
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

/**
 * Install the global hooks. Call once, as early as possible in main/index.ts.
 *
 * `getReaderLogsTail` (optional) supplies the on-disk reader log tail (reader-diag.log + meter.log +
 * live.json) that rides along as the report's `logs` attachment. Injected (not imported) to avoid an
 * import cycle with reader-process.ts, which depends on this module. Without it the global crash
 * reports — including the GPU/renderer `*-process-gone` ones — carry NO logs, which made them
 * un-debuggable from the Discord post alone (you couldn't see the build fingerprint or resolve path).
 */
export function installGlobalErrorReporting(getReaderLogsTail?: () => string): void {
  // Monitor variant: observes the exception without preventing the default
  // crash handling, so reporting never masks a genuinely fatal state.
  process.on("uncaughtExceptionMonitor", (err) => {
    reportError("main:uncaughtException", err, undefined, getReaderLogsTail?.());
  });
  process.on("unhandledRejection", (reason) => {
    console.error("[error-report] unhandled rejection:", reason);
    reportError("main:unhandledRejection", reason, undefined, getReaderLogsTail?.());
  });
  // Suppress process-gone reports once the app is quitting: child-process teardown
  // during shutdown is expected, not a fault. (Own flag — independent of index.ts.)
  app.on("before-quit", () => {
    quitting = true;
  });
  app.on("render-process-gone", (_event, _webContents, details) => {
    if (quitting || details.reason === "clean-exit") return;
    reportError("renderer:process-gone", details.reason, { exitCode: details.exitCode }, getReaderLogsTail?.());
  });
  app.on("child-process-gone", (_event, details) => {
    if (quitting || details.reason === "clean-exit") return;
    reportError(
      `child:${details.type}:process-gone`,
      details.reason,
      { exitCode: details.exitCode },
      getReaderLogsTail?.(),
    );
  });
}
