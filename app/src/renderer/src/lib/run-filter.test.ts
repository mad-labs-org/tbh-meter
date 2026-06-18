import { describe, expect, it } from "vitest";
import { clampMinDuration, passesRunFilter, applyRunFilter, countQualityHidden } from "./run-filter";
import { COUNT_FLOOR_SEC, ACT_BOSS_STAGE_NO } from "../../../shared/run-types.js";
import type { RunIndexEntry } from "../../../shared/ipc-types.js";
import type { RunQuality } from "../../../shared/run-types.js";

// A minimal run row carrying only the fields the filter reads. `quality` defaults to "counted"
// (a normal visible run); pass `quality: undefined` to model a legacy-mirror log with NO verdict.
// `status` (always present on a real index entry) defaults to "success". We branch on the presence
// of the `quality` KEY (not its value) so an explicit `quality: undefined` omits it from the row —
// a destructuring default would otherwise turn `undefined` back into "counted".
function run(
  overrides: Partial<
    Pick<RunIndexEntry, "quality" | "status" | "duration" | "clearTime" | "stageNo">
  > & {
    quality?: RunQuality | undefined;
  } = {},
): Pick<RunIndexEntry, "quality" | "status" | "duration" | "clearTime" | "stageNo"> {
  const { status = "success", duration = 60, clearTime = 58, stageNo = 5 } = overrides;
  const quality = "quality" in overrides ? overrides.quality : "counted";
  return { ...(quality !== undefined ? { quality } : {}), status, duration, clearTime, stageNo };
}

const SHOW_ALL = { hideNonCounted: false, minDurationSec: null };
const DEFAULT = { hideNonCounted: true, minDurationSec: null }; // ships as the default

describe("clampMinDuration", () => {
  it("null/undefined -> null (filter off)", () => {
    expect(clampMinDuration(null)).toBeNull();
    expect(clampMinDuration(undefined)).toBeNull();
  });

  it("0 / negative / non-finite -> null (garbage is off)", () => {
    expect(clampMinDuration(0)).toBeNull();
    expect(clampMinDuration(-5)).toBeNull();
    expect(clampMinDuration(NaN)).toBeNull();
    expect(clampMinDuration(Infinity)).toBeNull();
  });

  it("raises a value below the system floor up to the floor", () => {
    expect(clampMinDuration(5)).toBe(COUNT_FLOOR_SEC);
    expect(clampMinDuration(COUNT_FLOOR_SEC - 1)).toBe(COUNT_FLOOR_SEC);
  });

  it("passes a value at or above the floor unchanged", () => {
    expect(clampMinDuration(COUNT_FLOOR_SEC)).toBe(COUNT_FLOOR_SEC);
    expect(clampMinDuration(30)).toBe(30);
    expect(clampMinDuration(120)).toBe(120);
  });

  it("the floor is the converter's system constant (15s), not a local literal", () => {
    expect(COUNT_FLOOR_SEC).toBe(15);
  });
});

describe("passesRunFilter — quality gate", () => {
  it("DEFAULT (hideNonCounted): a counted run is shown", () => {
    expect(passesRunFilter(run({ quality: "counted" }), DEFAULT)).toBe(true);
  });

  it("DEFAULT: skipped / partial / degraded are hidden", () => {
    expect(passesRunFilter(run({ quality: "skipped" }), DEFAULT)).toBe(false);
    expect(passesRunFilter(run({ quality: "partial" }), DEFAULT)).toBe(false);
    expect(passesRunFilter(run({ quality: "degraded" }), DEFAULT)).toBe(false);
  });

  it("toggle ON (show ignored): every quality is shown", () => {
    for (const q of ["counted", "skipped", "partial", "degraded"] as const) {
      expect(passesRunFilter(run({ quality: q }), SHOW_ALL)).toBe(true);
    }
  });

  it("a SUCCESS run with NO verdict (legacy-mirror, quality undefined) is shown even when hiding", () => {
    expect(passesRunFilter(run({ quality: undefined, status: "success" }), DEFAULT)).toBe(true);
  });

  it("a NON-success legacy-mirror run (quality undefined) is hidden by default", () => {
    // Regression guard: the pre-PR6 table filtered status === "success", so fail/abandoned
    // mirror logs were hidden. With no quality verdict the gate must fall back to that, not show
    // them — they only become visible after the boot ingest seals them "skipped".
    expect(passesRunFilter(run({ quality: undefined, status: "fail" }), DEFAULT)).toBe(false);
    expect(passesRunFilter(run({ quality: undefined, status: "abandoned" }), DEFAULT)).toBe(false);
  });

  it("a non-success legacy-mirror run is shown when not hiding (status never gates with the toggle off)", () => {
    expect(passesRunFilter(run({ quality: undefined, status: "fail" }), SHOW_ALL)).toBe(true);
  });

  it("status is IGNORED once a quality verdict exists (a sealed fail run is gated on quality, not status)", () => {
    // A converted fail run is sealed quality "skipped" — hidden by the quality branch regardless of
    // its status; and a counted run is shown even if (hypothetically) its status were non-success.
    expect(passesRunFilter(run({ quality: "skipped", status: "fail" }), DEFAULT)).toBe(false);
    expect(passesRunFilter(run({ quality: "counted", status: "fail" }), DEFAULT)).toBe(true);
  });
});

describe("passesRunFilter — duration gate", () => {
  it("off (minDurationSec null): a short run is still shown", () => {
    expect(passesRunFilter(run({ duration: 5, clearTime: 0 }), SHOW_ALL)).toBe(true);
  });

  it("hides a run shorter than the set minimum", () => {
    const s = { hideNonCounted: false, minDurationSec: 30 };
    expect(passesRunFilter(run({ duration: 20, clearTime: 0 }), s)).toBe(false);
    expect(passesRunFilter(run({ duration: 40, clearTime: 0 }), s)).toBe(true);
  });

  it("uses max(duration, clearTime) as the run length (matches the converter floor)", () => {
    const s = { hideNonCounted: false, minDurationSec: 30 };
    // clearTime 35 > duration 20 -> counts as 35s -> passes a 30s minimum.
    expect(passesRunFilter(run({ duration: 20, clearTime: 35 }), s)).toBe(true);
  });

  it("x-10 (ACT_BOSS_STAGE_NO) is EXEMPT — a short boss clear is never hidden by duration", () => {
    const s = { hideNonCounted: false, minDurationSec: 120 };
    expect(passesRunFilter(run({ stageNo: ACT_BOSS_STAGE_NO, duration: 8, clearTime: 8 }), s)).toBe(
      true,
    );
    // a non-x-10 short run with the same length IS hidden.
    expect(passesRunFilter(run({ stageNo: 9, duration: 8, clearTime: 8 }), s)).toBe(false);
  });

  it("clamps the minimum to the floor — a stale sub-floor setting behaves like the floor", () => {
    // minDurationSec persisted as 5 (below the floor); a 10s run is < floor(15) -> hidden.
    const s = { hideNonCounted: false, minDurationSec: 5 };
    expect(passesRunFilter(run({ duration: 10, clearTime: 0 }), s)).toBe(false);
    // a 20s run clears the floor -> shown.
    expect(passesRunFilter(run({ duration: 20, clearTime: 0 }), s)).toBe(true);
  });
});

describe("passesRunFilter — both gates combine (AND)", () => {
  it("must pass quality AND duration", () => {
    const s = { hideNonCounted: true, minDurationSec: 30 };
    expect(passesRunFilter(run({ quality: "counted", duration: 40, clearTime: 0 }), s)).toBe(true);
    // counted but too short -> hidden by duration.
    expect(passesRunFilter(run({ quality: "counted", duration: 20, clearTime: 0 }), s)).toBe(false);
    // long enough but not counted -> hidden by quality.
    expect(passesRunFilter(run({ quality: "skipped", duration: 40, clearTime: 0 }), s)).toBe(false);
  });
});

describe("applyRunFilter", () => {
  it("filters a list and preserves order", () => {
    const runs = [
      run({ quality: "counted", duration: 60 }), // shown
      run({ quality: "skipped", duration: 60 }), // hidden by default
      run({ quality: "counted", duration: 60 }), // shown
    ];
    const out = applyRunFilter(runs, DEFAULT);
    expect(out).toHaveLength(2);
    expect(out).toEqual([runs[0], runs[2]]);
  });

  it("show-all returns every run", () => {
    const runs = [run({ quality: "counted" }), run({ quality: "degraded" })];
    expect(applyRunFilter(runs, SHOW_ALL)).toHaveLength(2);
  });
});

describe("countQualityHidden", () => {
  const HIDE = { hideNonCounted: true, minDurationSec: null };

  it("is 0 when not hiding (the toggle reveals nothing if it isn't filtering)", () => {
    const runs = [run({ quality: "counted" }), run({ quality: "skipped" })];
    expect(countQualityHidden(runs, { hideNonCounted: false, minDurationSec: null })).toBe(0);
  });

  it("counts only non-counted verdicts when hiding (the gate the toggle controls)", () => {
    const runs = [
      run({ quality: "counted" }),
      run({ quality: "skipped" }),
      run({ quality: "partial" }),
      run({ quality: "degraded" }),
    ];
    expect(countQualityHidden(runs, HIDE)).toBe(3);
  });

  it("ignores the duration gate — a counted-but-short run is NOT quality-hidden", () => {
    // The "show ignored" count must match what flipping the toggle reveals; duration has its own
    // control, so a counted run that the duration filter would hide does not inflate this count.
    const runs = [run({ quality: "counted", duration: 5, clearTime: 0 })];
    expect(countQualityHidden(runs, HIDE)).toBe(0);
  });

  it("counts a non-success legacy-mirror run (mirrors the success-fallback gate)", () => {
    const runs = [
      run({ quality: undefined, status: "success" }), // visible -> not counted
      run({ quality: undefined, status: "fail" }), // hidden by fallback -> counted
    ];
    expect(countQualityHidden(runs, HIDE)).toBe(1);
  });

  it("excludes a run hidden by BOTH gates — flipping the toggle would NOT reveal it (no over-promise)", () => {
    // minDurationSec=30: a skipped@10s is quality-hidden AND duration-hidden, so flipping
    // hideNonCounted off leaves it duration-hidden -> it must not be counted (the over-promise bug).
    // The counted@20s is duration-hidden only -> the quality toggle never affects it either.
    const runs = [
      run({ quality: "skipped", duration: 10, clearTime: 0 }),
      run({ quality: "counted", duration: 20, clearTime: 0 }),
    ];
    expect(countQualityHidden(runs, { hideNonCounted: true, minDurationSec: 30 })).toBe(0);
  });
});
