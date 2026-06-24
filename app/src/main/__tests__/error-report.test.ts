import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Unit test for the global error-reporting hooks — specifically the process-gone
// handlers and the shutdown guard. We mock the electron `app` so we can capture the
// handlers it registers and fire them by hand, and stub fetch so reportError's relay
// call is observable without a network. (vi.mock factories may only reference
// `mock`-prefixed vars — vitest hoisting rule.)
const mockHandlers = new Map<string, ((...args: unknown[]) => void)[]>();
// app.isReady drives the pre-ready relay guard; default ready so the relay fires.
let mockReady = true;
const mockApp = {
  getVersion: () => "0.0.0-test",
  isPackaged: true,
  isReady: () => mockReady,
  on(event: string, cb: (...args: unknown[]) => void) {
    const list = mockHandlers.get(event) ?? [];
    list.push(cb);
    mockHandlers.set(event, list);
    return mockApp;
  },
};

vi.mock("electron", () => ({ app: mockApp }));
vi.mock("../config.js", () => ({ API_URL: "http://test.invalid/api" }));
// The relay rides Electron's net stack (httpFetch -> net.fetch). Delegate the helper
// to the stubbed global fetch so the existing fetchMock keeps observing relay calls.
vi.mock("../net-fetch.js", () => ({
  httpFetch: (input: string | GlobalRequest, init?: RequestInit) => fetch(input, init),
}));

/** Invoke every handler the SUT registered for an electron app event. */
function fire(event: string, ...args: unknown[]): void {
  for (const cb of mockHandlers.get(event) ?? []) cb(...args);
}

/** Parse the JSON body of the Nth relayed report. */
function reportBody(
  fetchMock: ReturnType<typeof vi.fn>,
  n = 0,
): { context: string; message: string; stack?: string } {
  return JSON.parse((fetchMock.mock.calls[n]![1] as RequestInit).body as string);
}

let fetchMock: ReturnType<typeof vi.fn>;
let reportError: typeof import("../error-report.js").reportError;
let installGlobalErrorReporting: typeof import("../error-report.js").installGlobalErrorReporting;

beforeEach(async () => {
  // Fresh module each test so the module-level seen/sent/quitting state resets.
  vi.resetModules();
  mockHandlers.clear();
  mockReady = true;
  fetchMock = vi.fn(() => Promise.resolve({ ok: true } as Response));
  vi.stubGlobal("fetch", fetchMock);

  const mod = await import("../error-report.js");
  reportError = mod.reportError;
  installGlobalErrorReporting = mod.installGlobalErrorReporting;
  // NB: each test installs explicitly (the process-gone tests below). We DON'T install here so the
  // per-test process.on hooks don't accumulate across the suite (vi.resetModules makes a fresh module
  // but can't unregister listeners already added to the real `process`) → no MaxListeners warning.
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("installGlobalErrorReporting — process-gone reporting", () => {
  it("relays a non-clean child-process crash while the app is running", () => {
    installGlobalErrorReporting();
    fire("child-process-gone", {}, { type: "GPU", reason: "crashed", exitCode: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(reportBody(fetchMock).context).toBe("child:GPU:process-gone");
  });

  it("never relays a clean exit (renderer or child)", () => {
    installGlobalErrorReporting();
    fire("render-process-gone", {}, {}, { reason: "clean-exit", exitCode: 0 });
    fire("child-process-gone", {}, { type: "Utility", reason: "clean-exit", exitCode: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("suppresses process-gone once the app is quitting — shutdown teardown is not a fault", () => {
    installGlobalErrorReporting();
    fire("before-quit");
    // These are exactly the shutdown-time events that used to spam #log-error
    // (renderer killed = DBG_TERMINATE_PROCESS, utility killed during teardown).
    fire("render-process-gone", {}, {}, { reason: "killed", exitCode: 1073807364 });
    fire("child-process-gone", {}, { type: "Utility", reason: "killed", exitCode: -1073741205 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("attaches the injected reader-logs tail to a process-gone report (debuggable from the post)", () => {
    // The GPU/renderer crashes seen in #log-error carried NO logs — no way to see the player's build
    // fingerprint or resolve path. The injected provider's tail must ride along as the `logs`
    // attachment so the Discord post is self-sufficient to debug.
    installGlobalErrorReporting(
      () => "=== reader-diag.log ===\nfp=1.00.21-0xDEADBEEF-0x123\n=== meter.log ===\n[ok] attached",
    );
    fire("render-process-gone", {}, {}, { reason: "crashed", exitCode: 34 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = reportBody(fetchMock) as { logs?: string };
    expect(body.logs).toContain("reader-diag.log");
    expect(body.logs).toContain("fp=1.00.21-0xDEADBEEF-0x123");
  });
});

describe("reportError — err.cause capture (the whole point of the net.fetch migration)", () => {
  it("includes the underlying cause's code AND message in the relayed report", () => {
    // undici (Node global fetch) wraps the real transport failure — e.g. an AV doing
    // TLS interception with an untrusted root — in err.cause, leaving only "fetch failed"
    // at the top level. The report must surface that buried detail.
    const err = new Error("fetch failed");
    (err as Error & { cause?: unknown }).cause = Object.assign(new Error("unable to verify the first certificate"), {
      code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    });

    reportError("share:upload-network", err);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = reportBody(fetchMock);
    expect(body.message).toContain("fetch failed");
    expect(body.message).toContain("UNABLE_TO_VERIFY_LEAF_SIGNATURE");
    expect(body.message).toContain("unable to verify the first certificate");
    // Cause also rides the stack so it shows even when the embed leans on the stack field.
    expect(body.stack).toContain("UNABLE_TO_VERIFY_LEAF_SIGNATURE");
  });

  it("falls back to just the cause code when the cause carries no message (e.g. ECONNREFUSED)", () => {
    const err = new Error("fetch failed");
    (err as Error & { cause?: unknown }).cause = { code: "ECONNREFUSED" };

    reportError("share:upload-network", err);

    const body = reportBody(fetchMock);
    expect(body.message).toContain("fetch failed");
    expect(body.message).toContain("ECONNREFUSED");
  });

  it("leaves the message unchanged for a plain error with no cause", () => {
    reportError("some:context", new Error("plain failure"));
    const body = reportBody(fetchMock);
    expect(body.message).toBe("plain failure");
  });
});

describe("reportError — pre-ready guard (net.fetch throws before app-ready)", () => {
  it("skips the relay when the app is not yet ready instead of throwing", () => {
    mockReady = false;
    // Must not throw — reportError is fire-and-forget from global crash hooks that
    // can run before app-ready, and net.fetch would throw if called that early.
    expect(() => reportError("main:uncaughtException", new Error("early boot crash"))).not.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("relays once the app is ready", () => {
    mockReady = true;
    reportError("main:uncaughtException", new Error("post-ready crash"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
