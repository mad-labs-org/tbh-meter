import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Unit test for renderer crash recovery — the render-process-gone reload handler
// (with its shutdown guard and loop-guard) and the pure shouldReloadCrashedRenderer
// decision. We mock the electron `app` so we can capture the handler it registers and
// fire it by hand, exactly like error-report.test.ts. (vi.mock factories may only
// reference `mock`-prefixed vars — vitest hoisting rule.)
const mockHandlers = new Map<string, ((...args: unknown[]) => void)[]>();
const mockApp = {
  on(event: string, cb: (...args: unknown[]) => void) {
    const list = mockHandlers.get(event) ?? [];
    list.push(cb);
    mockHandlers.set(event, list);
    return mockApp;
  },
};

vi.mock("electron", () => ({ app: mockApp }));

/** Invoke every handler the SUT registered for an electron app event. */
function fire(event: string, ...args: unknown[]): void {
  for (const cb of mockHandlers.get(event) ?? []) cb(...args);
}

/** A stand-in for a live BrowserWindow's webContents. `reload`/`once` are spies so we
 *  can assert reloads and destroyed-cleanup wiring without a real renderer. */
function fakeWebContents(id = 1): {
  id: number;
  isDestroyed: () => boolean;
  reload: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
  destroyed: boolean;
} {
  return {
    id,
    destroyed: false,
    isDestroyed() {
      return this.destroyed;
    },
    reload: vi.fn(),
    once: vi.fn(),
  };
}

/** Details payload Electron passes as the 3rd render-process-gone arg. */
function goneDetails(reason: string, exitCode = 1): { reason: string; exitCode: number } {
  return { reason, exitCode };
}

let installCrashRecovery: typeof import("../crash-recovery.js").installCrashRecovery;
let shouldReloadCrashedRenderer: typeof import("../crash-recovery.js").shouldReloadCrashedRenderer;

beforeEach(async () => {
  // Fresh module each test so the module-level quitting flag and reload-history map
  // reset (same approach error-report.test.ts uses for its seen/sent/quitting state).
  vi.resetModules();
  mockHandlers.clear();
  vi.useRealTimers();

  const mod = await import("../crash-recovery.js");
  installCrashRecovery = mod.installCrashRecovery;
  shouldReloadCrashedRenderer = mod.shouldReloadCrashedRenderer;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("installCrashRecovery — render-process-gone reload", () => {
  it("reloads a renderer that crashed mid-session", () => {
    installCrashRecovery();
    const wc = fakeWebContents();
    fire("render-process-gone", {}, wc, goneDetails("crashed", 34));
    expect(wc.reload).toHaveBeenCalledTimes(1);
  });

  it("reloads a renderer that was killed mid-session", () => {
    installCrashRecovery();
    const wc = fakeWebContents();
    fire("render-process-gone", {}, wc, goneDetails("killed"));
    expect(wc.reload).toHaveBeenCalledTimes(1);
  });

  it("does NOT reload on a clean exit (intentional teardown, not a fault)", () => {
    installCrashRecovery();
    const wc = fakeWebContents();
    fire("render-process-gone", {}, wc, goneDetails("clean-exit", 0));
    expect(wc.reload).not.toHaveBeenCalled();
  });

  it("does NOT reload once the app is quitting — shutdown teardown is expected", () => {
    installCrashRecovery();
    fire("before-quit");
    const wc = fakeWebContents();
    // Exactly the shutdown-time crash that must NOT be fought with a reload.
    fire("render-process-gone", {}, wc, goneDetails("killed", 1073807364));
    expect(wc.reload).not.toHaveBeenCalled();
  });

  it("does NOT reload an already-destroyed webContents (reload would throw)", () => {
    installCrashRecovery();
    const wc = fakeWebContents();
    wc.destroyed = true;
    fire("render-process-gone", {}, wc, goneDetails("crashed"));
    expect(wc.reload).not.toHaveBeenCalled();
  });

  it("swallows a reload that throws (best-effort — never escapes the handler)", () => {
    installCrashRecovery();
    const wc = fakeWebContents();
    wc.reload.mockImplementation(() => {
      throw new Error("webContents busy");
    });
    expect(() => fire("render-process-gone", {}, wc, goneDetails("crashed"))).not.toThrow();
    expect(wc.reload).toHaveBeenCalledTimes(1);
  });

  it("registers destroyed-cleanup that frees the window's history when it fires", () => {
    // The destroyed handler must prune the per-id map so it can't leak across a long
    // session. We can't read the private map, so we prove the delete indirectly: exhaust
    // the budget, fire `destroyed`, and confirm a later crash is recovered again (a fresh
    // budget — only possible if the history was cleared, since these crashes are in-window).
    vi.useFakeTimers();
    vi.setSystemTime(0);
    installCrashRecovery();
    const wc = fakeWebContents();

    for (let i = 0; i < 4; i++) fire("render-process-gone", {}, wc, goneDetails("crashed"));
    expect(wc.reload).toHaveBeenCalledTimes(3); // budget spent

    expect(wc.once).toHaveBeenCalledWith("destroyed", expect.any(Function));
    const destroyedCb = wc.once.mock.calls.find(([evt]) => evt === "destroyed")![1] as () => void;
    destroyedCb();

    fire("render-process-gone", {}, wc, goneDetails("crashed"));
    expect(wc.reload).toHaveBeenCalledTimes(4); // history cleared → recovered again
  });

  it("arms destroyed-cleanup EXACTLY ONCE per window, not per reload (no listener pile-up)", () => {
    // Re-arming the once-listener on every reload would trip Node's MaxListenersExceeded
    // warning on a window that crash-reloads repeatedly over a session. Arm once, on the
    // first crash — even across many in-budget reloads and a give-up.
    installCrashRecovery();
    const wc = fakeWebContents();
    for (let i = 0; i < 5; i++) fire("render-process-gone", {}, wc, goneDetails("crashed"));
    expect(wc.reload).toHaveBeenCalledTimes(3); // 3 reloaded, 2 gave up
    const destroyedArms = wc.once.mock.calls.filter(([evt]) => evt === "destroyed");
    expect(destroyedArms).toHaveLength(1);
  });

  it("stops reloading after MAX_RELOADS crashes within the window (loop-guard)", () => {
    // A renderer that re-crashes on every reload must not spin: allow the first 3,
    // then give up on the 4th within the 60s window.
    vi.useFakeTimers();
    vi.setSystemTime(0);
    installCrashRecovery();
    const wc = fakeWebContents();

    for (let i = 0; i < 3; i++) {
      vi.setSystemTime(i * 1000); // all inside the 60s window
      fire("render-process-gone", {}, wc, goneDetails("crashed"));
    }
    expect(wc.reload).toHaveBeenCalledTimes(3);

    vi.setSystemTime(4000);
    fire("render-process-gone", {}, wc, goneDetails("crashed"));
    expect(wc.reload).toHaveBeenCalledTimes(3); // 4th crash in-window: no reload
  });

  it("grants a fresh budget once old reloads age out of the window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    installCrashRecovery();
    const wc = fakeWebContents();

    for (let i = 0; i < 3; i++) {
      vi.setSystemTime(i * 1000);
      fire("render-process-gone", {}, wc, goneDetails("crashed"));
    }
    expect(wc.reload).toHaveBeenCalledTimes(3);

    // Well past the 60s window — the earlier reloads no longer count, so a later
    // crash is recovered again (a rare repeat, not a storm).
    vi.setSystemTime(120_000);
    fire("render-process-gone", {}, wc, goneDetails("crashed"));
    expect(wc.reload).toHaveBeenCalledTimes(4);
  });

  it("tracks the loop-guard per window (one crashing renderer never starves another)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    installCrashRecovery();
    const a = fakeWebContents(1);
    const b = fakeWebContents(2);

    // Exhaust window A's budget.
    for (let i = 0; i < 4; i++) fire("render-process-gone", {}, a, goneDetails("crashed"));
    expect(a.reload).toHaveBeenCalledTimes(3);

    // Window B still gets recovered — histories are keyed by webContents.id.
    fire("render-process-gone", {}, b, goneDetails("crashed"));
    expect(b.reload).toHaveBeenCalledTimes(1);
  });
});

describe("shouldReloadCrashedRenderer — pure loop-guard decision", () => {
  const now = 100_000;
  const cases: { name: string; timestamps: number[]; expected: boolean }[] = [
    { name: "no prior reloads → allow", timestamps: [], expected: true },
    { name: "under the cap in-window → allow", timestamps: [now - 1000, now - 2000], expected: true },
    { name: "at the cap in-window → deny", timestamps: [now - 1000, now - 2000, now - 3000], expected: false },
    {
      name: "over the cap in-window → deny",
      timestamps: [now - 1000, now - 2000, now - 3000, now - 4000],
      expected: false,
    },
    {
      name: "old reloads outside the window don't count → allow",
      timestamps: [now - 61_000, now - 62_000, now - 63_000],
      expected: true,
    },
    {
      name: "mix: only in-window reloads count toward the cap → allow",
      timestamps: [now - 61_000, now - 1000, now - 2000],
      expected: true,
    },
    {
      name: "a timestamp exactly at the window edge is excluded → allow",
      timestamps: [now - 60_000, now - 60_000, now - 60_000],
      expected: true,
    },
  ];
  for (const { name, timestamps, expected } of cases) {
    it(name, () => {
      expect(shouldReloadCrashedRenderer(timestamps, now)).toBe(expected);
    });
  }

  it("honors a custom max and window", () => {
    // max=1: a single in-window reload already denies the next.
    expect(shouldReloadCrashedRenderer([now - 500], now, 1, 1000)).toBe(false);
    // …but one that predates the 1s window does not.
    expect(shouldReloadCrashedRenderer([now - 1500], now, 1, 1000)).toBe(true);
  });
});
