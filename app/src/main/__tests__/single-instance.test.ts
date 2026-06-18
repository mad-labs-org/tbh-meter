import { describe, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";

// Unit test for the APP single-writer guarantee (progress.md "Dedup" — single-writer
// primary). The decision is driven through an injectable SingleInstanceApp so we can
// assert the lock-and-quit wiring without spinning up Electron: a second instance must
// QUIT (and return false) so it never reaches startReader, and the primary must register
// the second-instance handler so a later launch raises the existing window.
//
// single-instance.ts imports `electron` at load (for the default `app` arg + the
// BrowserWindow type) — stub it so importing the module is side-effect free.
vi.mock("electron", () => ({ app: {} }));

import {
  acquireSingleInstanceLock,
  focusWindow,
  makeSecondInstanceHandler,
  runIfPrimary,
} from "../single-instance.js";

/** A fake of the slice of Electron's `app` the lock needs. `locked=false` means another
 *  instance already holds the lock (Electron's requestSingleInstanceLock returns false). */
function makeApp(locked: boolean) {
  const handlers: Record<string, () => void> = {};
  return {
    requestSingleInstanceLock: vi.fn(() => locked),
    on: vi.fn((event: string, listener: () => void) => {
      handlers[event] = listener;
    }),
    quit: vi.fn(),
    handlers,
  };
}

describe("acquireSingleInstanceLock", () => {
  it("primary: gets the lock, does NOT quit, returns true, and registers second-instance", () => {
    const app = makeApp(true);
    const onSecond = vi.fn();

    const isPrimary = acquireSingleInstanceLock(onSecond, app);

    expect(isPrimary).toBe(true);
    expect(app.quit).not.toHaveBeenCalled(); // primary keeps running -> reaches startReader
    expect(app.on).toHaveBeenCalledWith("second-instance", expect.any(Function));
  });

  it("primary: a later launch attempt fires onSecondInstance (raise the existing window)", () => {
    const app = makeApp(true);
    const onSecond = vi.fn();
    acquireSingleInstanceLock(onSecond, app);

    expect(onSecond).not.toHaveBeenCalled(); // nothing until a second instance launches
    app.handlers["second-instance"](); // Electron notifies the primary
    expect(onSecond).toHaveBeenCalledTimes(1);
  });

  it("secondary: fails the lock -> quits, returns false, and NEVER registers second-instance", () => {
    const app = makeApp(false);
    const onSecond = vi.fn();

    const isPrimary = acquireSingleInstanceLock(onSecond, app);

    expect(isPrimary).toBe(false); // caller must abort startup -> no reader spawned
    expect(app.quit).toHaveBeenCalledTimes(1);
    // The secondary is the one quitting; only the PRIMARY listens for second-instance.
    expect(app.on).not.toHaveBeenCalled();
    expect(onSecond).not.toHaveBeenCalled();
  });
});

describe("focusWindow", () => {
  function makeWin(over: Partial<Record<keyof BrowserWindow, unknown>> = {}) {
    return {
      isDestroyed: vi.fn(() => false),
      isMinimized: vi.fn(() => false),
      isVisible: vi.fn(() => true),
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
      ...over,
    } as unknown as BrowserWindow & {
      isDestroyed: ReturnType<typeof vi.fn>;
      restore: ReturnType<typeof vi.fn>;
      show: ReturnType<typeof vi.fn>;
      focus: ReturnType<typeof vi.fn>;
    };
  }

  it("focuses a visible, non-minimized window without restore/show", () => {
    const win = makeWin();
    focusWindow(win);
    expect(win.restore).not.toHaveBeenCalled();
    expect(win.show).not.toHaveBeenCalled();
    expect(win.focus).toHaveBeenCalledTimes(1);
  });

  it("restores a minimized window and shows a hidden one before focusing", () => {
    const win = makeWin({ isMinimized: () => true, isVisible: () => false });
    focusWindow(win);
    expect(win.restore).toHaveBeenCalledTimes(1);
    expect(win.show).toHaveBeenCalledTimes(1);
    expect(win.focus).toHaveBeenCalledTimes(1);
  });

  it("is a no-op for a null window (no overlay yet)", () => {
    expect(() => focusWindow(null)).not.toThrow();
  });

  it("is a no-op for a destroyed window", () => {
    const win = makeWin({ isDestroyed: () => true });
    focusWindow(win);
    expect(win.focus).not.toHaveBeenCalled();
  });
});

describe("makeSecondInstanceHandler", () => {
  // index.ts wires the lock as acquireSingleInstanceLock(makeSecondInstanceHandler(() => liveWin)).
  // These prove that composition: the handler raises whatever the getter currently returns
  // (the overlay is created after wiring and recreated on macOS "activate" — a captured value
  // would be stale/null), and tolerates a null window before the overlay exists.
  function makeWin() {
    return {
      isDestroyed: vi.fn(() => false),
      isMinimized: vi.fn(() => false),
      isVisible: vi.fn(() => true),
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
    } as unknown as BrowserWindow & { focus: ReturnType<typeof vi.fn> };
  }

  it("focuses the window the getter returns at call time (not a captured value)", () => {
    let current: (BrowserWindow & { focus: ReturnType<typeof vi.fn> }) | null = null;
    const handler = makeSecondInstanceHandler(() => current);

    // Before the overlay exists the getter yields null — the handler must not throw.
    expect(() => handler()).not.toThrow();

    // Overlay created later: the handler must raise THIS window, proving it re-reads the getter.
    current = makeWin();
    handler();
    expect(current.focus).toHaveBeenCalledTimes(1);
  });
});

describe("runIfPrimary", () => {
  // The seam index.ts uses to gate BOTH whenReady (startReader) and will-quit
  // (stopReader -> killAllReaders). A secondary must skip both: never spawn a second
  // reader, and — load-bearing — never reap, since killAllReaders kills tbh-reader.exe
  // by image name and would tear down the PRIMARY's reader on a double-launch.
  it("primary: runs the gated body (whenReady would reach startReader)", () => {
    const fn = vi.fn();
    runIfPrimary(true, fn);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("secondary: skips the gated body so startReader is never called", () => {
    const startReader = vi.fn();
    runIfPrimary(false, () => startReader());
    expect(startReader).not.toHaveBeenCalled();
  });

  it("secondary: will-quit is a no-op — stopReader/killAllReaders never run on a secondary", () => {
    // Stand-in for the will-quit body: a secondary must NOT reach stopReader (which on
    // win32 calls killAllReaders -> taskkill /im tbh-reader.exe, killing the PRIMARY's reader).
    const stopReader = vi.fn();
    runIfPrimary(false, () => {
      stopReader();
    });
    expect(stopReader).not.toHaveBeenCalled();
  });
});
