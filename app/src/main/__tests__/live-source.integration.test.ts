import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Integration test of the PR5 LiveSource liveness path: poll <dir>/live.json over a REAL temp file
// and assert the OFFLINE/STALE behavior the spec names (progress.md PR5 "Testes": offline/staleness).
// The cooking itself (cookLive/parseLiveJson) is unit-tested in live-source.test.ts; here we exercise
// the class — the change-detection liveness (mtime-advance vs our own monotonic clock, SMB-skew
// immune) and the emitNull/emitSnap de-dup — using fake timers to drive the 700ms poll.
//
// Liveness uses statSync(file).mtimeMs (REAL fs) and Date.now() (FAKE under useFakeTimers), which are
// independent — so we move the file's mtime explicitly with utimesSync (the logic only cares that mtime
// CHANGES, never its absolute value) and advance the wall clock with vi.advanceTimersByTime. live-source
// has no electron dependency (helpers.ts pulls only a type), so no electron mock is needed.

import { LiveSource } from "../sources/live-source.js";
import type { LiveSnapshot } from "../../shared/run-types.js";
import type { RawLive } from "../../shared/live-types.js";

const STALE_AFTER_MS = 5_000; // mirrors live-source.ts (kept in sync; structural, not imported)
const POLL_MS = 700; // mirrors live-source.ts POLL_INTERVAL_MS

let dir: string;
let mtimeSec: number;

beforeEach(() => {
  vi.useFakeTimers();
  dir = mkdtempSync(join(tmpdir(), "tbh-live-src-"));
  mtimeSec = 1_700_000_000; // an arbitrary, fixed mtime base we bump explicitly
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

function rawLive(over: Partial<RawLive> = {}): RawLive {
  return {
    raw_schema_version: 1,
    run: 8,
    stageKey: 4209,
    act: 2,
    stageNo: 9,
    difficulty: 3,
    mobs: 68,
    total_mobs: 601,
    damage_now: 2_830_000,
    elapsed: 34,
    gold_now: 14_500,
    xp_now: 19_800,
    party: [101, 201, 301],
    drops: [4, 1, 0],
    ...over,
  };
}

/** Write live.json with an EXPLICIT mtime (utimesSync) so the change-detection liveness is driven
 *  deterministically, independent of the fake wall clock. `bump` advances the mtime to simulate the
 *  reader's ~1×/s rewrite (the logic keys off mtime CHANGING, not its value). */
function writeLive(content: string, bump = true): void {
  if (bump) mtimeSec += 1;
  const file = join(dir, "live.json");
  writeFileSync(file, content, "utf-8");
  utimesSync(file, mtimeSec, mtimeSec);
}

function collect(src: LiveSource): Array<LiveSnapshot | null> {
  const out: Array<LiveSnapshot | null> = [];
  src.on("live", (snap: LiveSnapshot | null) => out.push(snap));
  return out;
}

describe("LiveSource — offline when there is no file / no dir", () => {
  it("emits null on start when no dir is set", () => {
    const src = new LiveSource();
    const seen = collect(src);
    src.start();
    try {
      expect(seen).toEqual([null]); // OFFLINE
    } finally {
      src.stop();
    }
  });

  it("emits null when the dir is set but live.json is absent", () => {
    const src = new LiveSource();
    const seen = collect(src);
    src.setDir(dir); // not started yet -> no emit
    src.start(); // ticks once: file absent -> null
    try {
      expect(seen).toEqual([null]);
    } finally {
      src.stop();
    }
  });
});

describe("LiveSource — change-detection liveness (the 'first sighting is not live' rule)", () => {
  it("does NOT go live on the first sighting of a (possibly frozen) file — waits for one mtime advance", () => {
    writeLive(JSON.stringify(rawLive()), false); // file exists, but it's the FIRST sighting
    const src = new LiveSource();
    const seen = collect(src);
    src.setDir(dir);
    src.start(); // tick #1: first sighting, lastMtimeMs was -1 -> never live yet
    try {
      // A frozen leftover must read as OFFLINE until we observe mtime ADVANCE.
      expect(seen).toEqual([null]);
    } finally {
      src.stop();
    }
  });

  it("goes live once mtime advances, cooking the raw into a snapshot", () => {
    writeLive(JSON.stringify(rawLive()), false);
    const src = new LiveSource();
    const seen = collect(src);
    src.setDir(dir);
    src.start(); // tick #1: first sighting -> null
    try {
      writeLive(JSON.stringify(rawLive({ damage_now: 2_830_000, elapsed: 34 }))); // mtime ADVANCES
      vi.advanceTimersByTime(POLL_MS); // tick #2: advance observed -> live -> cook
      const last = seen[seen.length - 1];
      expect(last).not.toBeNull();
      expect(last?.stage).toBe("2-9"); // cooked label
      expect(last?.mode).toBe("Torment"); // cooked mode
      expect(last?.dps).toBeGreaterThan(0); // cooked dps via the shared helper
      expect(last?.runNumber).toBe(8);
    } finally {
      src.stop();
    }
  });
});

describe("LiveSource — staleness flips back to offline (the spec's named case)", () => {
  it("emits null again once mtime stops advancing for longer than STALE_AFTER_MS", () => {
    writeLive(JSON.stringify(rawLive()), false);
    const src = new LiveSource();
    const seen = collect(src);
    src.setDir(dir);
    src.start(); // tick #1: first sighting -> null
    try {
      writeLive(JSON.stringify(rawLive())); // mtime advances
      vi.advanceTimersByTime(POLL_MS); // tick #2: live -> snapshot
      expect(seen[seen.length - 1]).not.toBeNull();

      // The meter stopped: no more mtime bumps. Let the wall clock pass the staleness window.
      vi.advanceTimersByTime(STALE_AFTER_MS + POLL_MS); // several ticks, mtime never advances again
      expect(seen[seen.length - 1]).toBeNull(); // back OFFLINE
    } finally {
      src.stop();
    }
  });
});

describe("LiveSource — a present-but-half-written file is OFFLINE, not a garbage snapshot", () => {
  it("emits null when mtime advanced but the contents do not parse as a live record", () => {
    writeLive(JSON.stringify(rawLive()), false); // first sighting
    const src = new LiveSource();
    const seen = collect(src);
    src.setDir(dir);
    src.start(); // tick #1 -> null
    try {
      // The reader rewrote the file (mtime advances) but we caught it half-written -> parseLiveJson null.
      writeLive("{ not json yet");
      vi.advanceTimersByTime(POLL_MS); // tick #2: advance observed, but parse fails -> emitNull
      expect(seen[seen.length - 1]).toBeNull();
    } finally {
      src.stop();
    }
  });
});

describe("LiveSource — de-dup: re-emits only on change or liveness flip", () => {
  it("emits a live snapshot once for two identical live ticks", () => {
    writeLive(JSON.stringify(rawLive()), false);
    const src = new LiveSource();
    const seen = collect(src);
    src.setDir(dir);
    src.start(); // tick #1 -> null
    try {
      writeLive(JSON.stringify(rawLive())); // mtime advances, content X
      vi.advanceTimersByTime(POLL_MS); // tick #2 -> snapshot X (emitted)
      const afterFirstSnap = seen.length;
      // Bump mtime again (reader rewrote) but with IDENTICAL content -> the cooked snapshot is unchanged.
      writeLive(JSON.stringify(rawLive())); // mtime advances, same content X
      vi.advanceTimersByTime(POLL_MS); // tick #3 -> same snapshot -> NOT re-emitted
      expect(seen.length).toBe(afterFirstSnap); // de-duped: no extra emit

      // And a real change DOES emit again.
      writeLive(JSON.stringify(rawLive({ damage_now: 9_999_999 })));
      vi.advanceTimersByTime(POLL_MS);
      expect(seen.length).toBe(afterFirstSnap + 1);
      expect(seen[seen.length - 1]?.damage).toBe(9_999_999);
    } finally {
      src.stop();
    }
  });
});
