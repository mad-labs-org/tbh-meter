import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Unit test for the global error-reporting hooks — specifically the process-gone
// handlers and the shutdown guard. We mock the electron `app` so we can capture the
// handlers it registers and fire them by hand, and stub fetch so reportError's relay
// call is observable without a network. (vi.mock factories may only reference
// `mock`-prefixed vars — vitest hoisting rule.)
const mockHandlers = new Map<string, ((...args: unknown[]) => void)[]>();
const mockApp = {
  getVersion: () => "0.0.0-test",
  isPackaged: true,
  on(event: string, cb: (...args: unknown[]) => void) {
    const list = mockHandlers.get(event) ?? [];
    list.push(cb);
    mockHandlers.set(event, list);
    return mockApp;
  },
};

vi.mock("electron", () => ({ app: mockApp }));
vi.mock("../config.js", () => ({ API_URL: "http://test.invalid/api" }));

/** Invoke every handler the SUT registered for an electron app event. */
function fire(event: string, ...args: unknown[]): void {
  for (const cb of mockHandlers.get(event) ?? []) cb(...args);
}

/** Parse the JSON body of the Nth relayed report. */
function reportBody(fetchMock: ReturnType<typeof vi.fn>, n = 0): { context: string } {
  return JSON.parse((fetchMock.mock.calls[n]![1] as RequestInit).body as string);
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  // Fresh module each test so the module-level seen/sent/quitting state resets.
  vi.resetModules();
  mockHandlers.clear();
  fetchMock = vi.fn(() => Promise.resolve({ ok: true } as Response));
  vi.stubGlobal("fetch", fetchMock);

  const mod = await import("../error-report.js");
  mod.installGlobalErrorReporting();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("installGlobalErrorReporting — process-gone reporting", () => {
  it("relays a non-clean child-process crash while the app is running", () => {
    fire("child-process-gone", {}, { type: "GPU", reason: "crashed", exitCode: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(reportBody(fetchMock).context).toBe("child:GPU:process-gone");
  });

  it("never relays a clean exit (renderer or child)", () => {
    fire("render-process-gone", {}, {}, { reason: "clean-exit", exitCode: 0 });
    fire("child-process-gone", {}, { type: "Utility", reason: "clean-exit", exitCode: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("suppresses process-gone once the app is quitting — shutdown teardown is not a fault", () => {
    fire("before-quit");
    // These are exactly the shutdown-time events that used to spam #log-error
    // (renderer killed = DBG_TERMINATE_PROCESS, utility killed during teardown).
    fire("render-process-gone", {}, {}, { reason: "killed", exitCode: 1073807364 });
    fire("child-process-gone", {}, { type: "Utility", reason: "killed", exitCode: -1073741205 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
