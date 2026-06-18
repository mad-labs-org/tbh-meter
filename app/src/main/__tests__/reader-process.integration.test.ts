import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

// Integration test for the reader supervisor's state machine. The win32 spawn/timer/IPC
// path can't run on the dev Mac, so we mock the runtime edges (child_process, electron,
// fs, settings, error-report) and drive time with fake timers to assert the WIRING:
// backoff schedules, the blocked transition, report-once-per-episode, EPERM-doesn't-crash,
// manual retry, and recovery via the healthy timer. (The pure decisions live in — and are
// tested directly by — reader-policy.test.ts.)
//
// vi.mock factories may only reference `mock`-prefixed vars (vitest hoisting rule).
const mockSpawn = vi.fn();
const mockExecFileSync = vi.fn();
const mockReportError = vi.fn();

vi.mock("node:child_process", () => ({ spawn: mockSpawn, execFileSync: mockExecFileSync }));
vi.mock("node:fs", () => ({ existsSync: () => true }));
vi.mock("electron", () => ({ app: { isPackaged: true } }));
vi.mock("../settings.js", () => ({ resolveOutputDir: () => "/tmp/out" }));
vi.mock("../error-report.js", () => ({ reportError: mockReportError }));

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  exitCode: number | null;
  kill: () => void;
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.kill = vi.fn();
  return child;
}

let mod: typeof import("../reader-process.js");
let platformDesc: PropertyDescriptor | undefined;

beforeEach(async () => {
  vi.resetModules();
  mockSpawn.mockReset();
  mockExecFileSync.mockReset();
  mockReportError.mockReset();
  mockSpawn.mockImplementation(() => makeFakeChild());
  vi.useFakeTimers();

  // The supervisor only runs on win32+packaged; fake both, plus resourcesPath (readerExePath joins it).
  platformDesc = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  (process as unknown as { resourcesPath: string }).resourcesPath = "/fake/resources";

  mod = await import("../reader-process.js");
});

afterEach(() => {
  mod.stopReader();
  vi.useRealTimers();
  if (platformDesc) Object.defineProperty(process, "platform", platformDesc);
});

/** The fake child returned by the most recent spawn() call. */
function lastChild(): FakeChild {
  return mockSpawn.mock.results.at(-1)!.value as FakeChild;
}

describe("reader supervisor", () => {
  it("status: offline until engaged, starting while resolving, offline after a clean exit", () => {
    mod.startReader();
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(mod.getReaderState()).toBe("offline"); // managing, nothing engaged yet

    lastChild().stdout.emit("data", Buffer.from("[ok] attached (pid 1).\n"));
    expect(mod.getReaderState()).toBe("starting"); // reached the game

    lastChild().emit("exit", 0, null); // code 0 == clean ("game is not open" / closed)
    expect(mod.getReaderState()).toBe("offline");
    expect(mockReportError).not.toHaveBeenCalled();

    vi.advanceTimersByTime(5_000); // base respawn cadence (clean exits don't back off)
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect(mockReportError).not.toHaveBeenCalled();
  });

  it("abnormal exits back off (5/10/20/40s) and flip to blocked + ONE report at the 5th", () => {
    mod.startReader();

    lastChild().emit("exit", 1, null); // streak 1
    expect(mod.getReaderState()).toBe("starting");
    expect(mockReportError).not.toHaveBeenCalled();

    vi.advanceTimersByTime(5_000); // -> attempt 2
    lastChild().emit("exit", 1, null); // streak 2
    vi.advanceTimersByTime(10_000); // -> attempt 3
    lastChild().emit("exit", 1, null); // streak 3
    vi.advanceTimersByTime(20_000); // -> attempt 4
    lastChild().emit("exit", 1, null); // streak 4
    expect(mod.getReaderState()).toBe("starting");
    expect(mockReportError).not.toHaveBeenCalled();

    vi.advanceTimersByTime(40_000); // -> attempt 5
    lastChild().emit("exit", 1, null); // streak 5 -> blocked

    expect(mockSpawn).toHaveBeenCalledTimes(5);
    expect(mod.getReaderState()).toBe("blocked");
    expect(mockReportError).toHaveBeenCalledTimes(1);
    expect(mockReportError.mock.calls[0][0]).toBe("reader:blocked");
    expect(mockReportError.mock.calls[0][2]).toMatchObject({ failStreak: "5" });
  });

  it("a synchronous spawn EPERM does NOT crash; it reports once and backs off to blocked", () => {
    const eperm = Object.assign(new Error("spawn EPERM"), { code: "EPERM" });
    mockSpawn.mockImplementation(() => {
      throw eperm;
    });

    expect(() => mod.startReader()).not.toThrow(); // the bug we're fixing
    expect(mod.getReaderState()).toBe("starting");
    expect(mockReportError).toHaveBeenCalledTimes(1);
    expect(mockReportError.mock.calls[0][0]).toBe("reader:spawn-failed");

    vi.advanceTimersByTime(5_000); // attempt 2 (throws)
    vi.advanceTimersByTime(10_000); // attempt 3
    vi.advanceTimersByTime(20_000); // attempt 4
    vi.advanceTimersByTime(40_000); // attempt 5 -> blocked

    expect(mockSpawn).toHaveBeenCalledTimes(5);
    expect(mod.getReaderState()).toBe("blocked");
    expect(mockReportError).toHaveBeenCalledTimes(1); // still one report this episode
  });

  it("manual retry clears the streak and respawns immediately", () => {
    mod.startReader();
    for (const delay of [0, 5_000, 10_000, 20_000, 40_000]) {
      if (delay) vi.advanceTimersByTime(delay);
      lastChild().emit("exit", 1, null);
    }
    expect(mod.getReaderState()).toBe("blocked");
    const callsBefore = mockSpawn.mock.calls.length;

    mod.retryReader();
    expect(mockSpawn).toHaveBeenCalledTimes(callsBefore + 1); // respawned now, no backoff wait
    expect(mod.getReaderState()).toBe("offline"); // fresh attempt: streak cleared, not engaged yet
    lastChild().stdout.emit("data", Buffer.from("resolving classes...\n"));
    expect(mod.getReaderState()).toBe("starting");

    // The superseded backoff timer must NOT fire a second spawn after the retry.
    vi.advanceTimersByTime(60_000);
    expect(mockSpawn).toHaveBeenCalledTimes(callsBefore + 1);
  });

  it("surviving the healthy window clears the streak and recovers from blocked", () => {
    mod.startReader();
    for (const delay of [0, 5_000, 10_000, 20_000, 40_000]) {
      if (delay) vi.advanceTimersByTime(delay);
      lastChild().emit("exit", 1, null);
    }
    expect(mod.getReaderState()).toBe("blocked");

    vi.advanceTimersByTime(60_000); // capped backoff -> a fresh attempt
    const survivor = lastChild();
    survivor.stdout.emit("data", Buffer.from("[ok] attached (pid 123).\n"));
    vi.advanceTimersByTime(30_000); // stays alive past the healthy window

    expect(mod.getReaderState()).toBe("starting"); // recovered
  });

  it("splash phase: markers drive it; the slow scan maps to a distinct 'scanning'", () => {
    mod.startReader();
    const child = lastChild();
    expect(mod.getReaderStatus()).toBe("searching"); // set on spawn

    child.stdout.emit("data", Buffer.from("[[STATUS]] resolving\n"));
    expect(mod.getReaderStatus()).toBe("resolving");

    // The slow value-scan gets its own phase (so the splash shows the ~1min estimate only
    // then); the fast/calibrated path stays on "resolving" and never reaches this line.
    child.stdout.emit("data", Buffer.from("resolving classes/instances (~1-2min)...\n"));
    expect(mod.getReaderStatus()).toBe("scanning");

    child.stdout.emit("data", Buffer.from("[[STATUS]] ready\n"));
    expect(mod.getReaderStatus()).toBe("ready");
  });
});

// The APP-side single-writer guarantee (progress.md "Dedup" — single-writer primary):
// the supervisor must NEVER let two readers run at once, because two readers double-write
// the per-run raw and drop the live gold read into the 2× SAVE fallback. It enforces this
// by killing EVERY tbh-reader.exe by image name (taskkill /f /t /im) immediately BEFORE it
// spawns ours, and again on quit — so any stray/orphan (incl. a PyInstaller --onefile
// orphan a by-PID kill would miss) is gone before/after our process. These assert the
// kill-before-spawn ordering on the real spawn path (mockExecFileSync is the taskkill).
describe("reader supervisor — single-writer (kill before spawn, kill on quit)", () => {
  const TASKKILL = ["taskkill", ["/f", "/t", "/im", "tbh-reader.exe"]];

  /** spawn() and taskkill() share vitest's global invocation order, so we can prove the
   *  kill ran BEFORE the spawn it precedes (not merely that both happened). */
  function killBeforeSpawnOrder(): void {
    const killOrders = mockExecFileSync.mock.invocationCallOrder;
    const spawnOrders = mockSpawn.mock.invocationCallOrder;
    expect(killOrders.length).toBeGreaterThanOrEqual(spawnOrders.length);
    // The i-th spawn must be immediately preceded by the i-th kill.
    spawnOrders.forEach((spawnOrder, i) => {
      expect(killOrders[i]).toBeLessThan(spawnOrder);
    });
  }

  it("kills any stray reader BY IMAGE NAME before the first spawn (be the single owner)", () => {
    mod.startReader();
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(mockExecFileSync).toHaveBeenCalledWith(...TASKKILL, { stdio: "ignore" });
    killBeforeSpawnOrder();
  });

  it("kills before EVERY respawn so an old reader is dead before the new one starts", () => {
    // The two-readers root cause is exactly a respawn that leaves the old process alive.
    mod.startReader(); // spawn 1 (preceded by kill 1)
    lastChild().emit("exit", 1, null); // abnormal -> backoff to a respawn
    vi.advanceTimersByTime(5_000); // spawn 2 (must be preceded by kill 2)
    lastChild().emit("exit", 1, null);
    vi.advanceTimersByTime(10_000); // spawn 3 (preceded by kill 3)

    expect(mockSpawn).toHaveBeenCalledTimes(3);
    // Each spawn was preceded by its own taskkill — never two readers alive at once.
    expect(mockExecFileSync.mock.calls.filter((c) => c[0] === "taskkill").length).toBeGreaterThanOrEqual(3);
    killBeforeSpawnOrder();
  });

  it("kills all readers on stopReader (no reader survives the app quit)", () => {
    mod.startReader();
    const killsBefore = mockExecFileSync.mock.calls.length;
    mod.stopReader();
    // stopReader fires one more taskkill (the quit reap) on top of the pre-spawn one.
    expect(mockExecFileSync.mock.calls.length).toBe(killsBefore + 1);
    expect(mockExecFileSync).toHaveBeenLastCalledWith(...TASKKILL, { stdio: "ignore" });
  });

  it("a taskkill failure (nothing running -> non-zero exit) never throws", () => {
    // taskkill exits non-zero when no tbh-reader.exe exists (the common case) — execFileSync
    // throws on a non-zero exit, and the supervisor must swallow it (the kill is best-effort).
    mockExecFileSync.mockImplementation(() => {
      throw Object.assign(new Error("taskkill: process not found"), { status: 128 });
    });
    expect(() => mod.startReader()).not.toThrow();
    expect(mockSpawn).toHaveBeenCalledTimes(1); // still spawned ours after the futile kill
  });
});
