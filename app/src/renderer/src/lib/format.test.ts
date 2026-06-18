import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ago, qualityBadge } from "./format";

describe("qualityBadge", () => {
  it("labels each non-counted verdict", () => {
    expect(qualityBadge("partial")?.label).toBe("Partial");
    expect(qualityBadge("degraded")?.label).toBe("Degraded");
    expect(qualityBadge("skipped")?.label).toBe("Invalid");
  });

  it("explains in its title that the run is not on the leaderboard", () => {
    expect(qualityBadge("partial")?.title).toMatch(/leaderboard/i);
    expect(qualityBadge("degraded")?.title).toMatch(/leaderboard/i);
    expect(qualityBadge("skipped")?.title).toMatch(/leaderboard/i);
  });

  it("tints invalid runs (degraded, skipped) red and partial runs amber", () => {
    expect(qualityBadge("degraded")?.rowClass).toContain("rose");
    expect(qualityBadge("skipped")?.rowClass).toContain("rose");
    expect(qualityBadge("partial")?.rowClass).toContain("amber");
  });

  it("does not mark a clean counted run", () => {
    expect(qualityBadge("counted")).toBeNull();
  });

  it("does not mark a legacy run with no verdict", () => {
    expect(qualityBadge(undefined)).toBeNull();
  });
});

describe("ago — relative time, argument is epoch MILLISECONDS (Redesign 2)", () => {
  // Pin "now" so the buckets are exact and the test can't flake on a boundary.
  const NOW = 1_700_000_000_000; // 2023-11-14T22:13:20Z, in ms
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads its argument as milliseconds, not seconds", () => {
    // 5 minutes ago expressed in MS. Under the OLD seconds contract — the bug the cooldown
    // history row hit via `ago(dropAt / 1000)` — this would be mistaken for a ~54,000-year-old
    // timestamp and render "just now". Pins the unit the whole ts=ms redesign rests on (#308).
    expect(ago(NOW - 5 * 60_000)).toBe("5m ago");
  });

  it("buckets recent → minutes → hours → days → weeks", () => {
    expect(ago(NOW)).toBe("just now");
    expect(ago(NOW - 30_000)).toBe("just now"); // < 60s
    expect(ago(NOW - 90_000)).toBe("1m ago");
    expect(ago(NOW - 2 * 3_600_000)).toBe("2h ago");
    expect(ago(NOW - 3 * 86_400_000)).toBe("3d ago");
    expect(ago(NOW - 2 * 7 * 86_400_000)).toBe("2w ago");
  });

  it("returns empty string for a non-positive or non-finite timestamp", () => {
    expect(ago(0)).toBe("");
    expect(ago(-1)).toBe("");
    expect(ago(Number.NaN)).toBe("");
  });
});
