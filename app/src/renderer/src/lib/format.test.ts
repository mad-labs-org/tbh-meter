import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Bug, Skull, LogOut, CircleSlash, TimerOff } from "lucide-react";
import { ago, formatEta, qualityBadge, runOutcomeBadge } from "./format";
import type { RunStatus, RunQuality } from "../../../shared/run-types.js";

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

describe("runOutcomeBadge — one distinct marker per (status, quality)", () => {
  // The marker is purely cosmetic; it must NOT mirror qualityBadge's collapse of fail+abandon into
  // one "skipped" look. Each reason gets its own lucide icon + colour family.

  it("maps a degraded run (bugged data) to Bug / rose, regardless of status", () => {
    const badge = runOutcomeBadge("success", "degraded");
    expect(badge?.Icon).toBe(Bug);
    expect(badge?.iconClass).toBe("text-rose-400");
    expect(badge?.rowClass).toBe("bg-rose-500/10");
    expect(badge?.label).toBe("Bugged");
    expect(badge?.title).toMatch(/leaderboard/i);
  });

  it("maps a wipe (status fail) to Skull / red", () => {
    const badge = runOutcomeBadge("fail", "skipped");
    expect(badge?.Icon).toBe(Skull);
    expect(badge?.iconClass).toBe("text-red-400");
    expect(badge?.rowClass).toBe("bg-red-500/10");
    expect(badge?.label).toBe("Failed (wipe)");
  });

  it("maps an abandon (status abandoned) to LogOut / slate", () => {
    const badge = runOutcomeBadge("abandoned", "skipped");
    expect(badge?.Icon).toBe(LogOut);
    expect(badge?.iconClass).toBe("text-slate-400");
    expect(badge?.rowClass).toBe("bg-slate-500/10");
    expect(badge?.label).toBe("Abandoned");
  });

  it("maps a partial success to CircleSlash / amber", () => {
    const badge = runOutcomeBadge("success", "partial");
    expect(badge?.Icon).toBe(CircleSlash);
    expect(badge?.iconClass).toBe("text-amber-400");
    expect(badge?.rowClass).toBe("bg-amber-500/10");
    expect(badge?.label).toBe("Partial");
  });

  it("maps a too-short success (skipped) to TimerOff / zinc", () => {
    const badge = runOutcomeBadge("success", "skipped");
    expect(badge?.Icon).toBe(TimerOff);
    expect(badge?.iconClass).toBe("text-zinc-400");
    expect(badge?.rowClass).toBe("bg-zinc-500/10");
    expect(badge?.label).toBe("Too short");
  });

  it("does not mark a clean counted success (no marker)", () => {
    expect(runOutcomeBadge("success", "counted")).toBeNull();
  });

  it("does not mark a legacy success with no verdict", () => {
    expect(runOutcomeBadge("success", undefined)).toBeNull();
  });

  // ── Precedence edges: bugged > fail > abandoned > partial > too-short ──

  it("prefers bugged over the game outcome (degraded + fail → Bug, not Skull)", () => {
    const badge = runOutcomeBadge("fail", "degraded");
    expect(badge?.Icon).toBe(Bug);
    expect(badge?.label).toBe("Bugged");
  });

  it("prefers bugged over an abandon (degraded + abandoned → Bug)", () => {
    expect(runOutcomeBadge("abandoned", "degraded")?.Icon).toBe(Bug);
  });

  it("prefers the fail outcome over a partial verdict (fail + partial → Skull)", () => {
    expect(runOutcomeBadge("fail", "partial")?.Icon).toBe(Skull);
  });

  it("prefers an abandon over a partial verdict (abandoned + partial → LogOut)", () => {
    expect(runOutcomeBadge("abandoned", "partial")?.Icon).toBe(LogOut);
  });

  // A degraded fail/abandon still counts as bugged (data is the dominant reason); a non-degraded
  // fail/abandon with a counted/undefined quality still marks by status (the run did not clear).
  it("marks a fail/abandon even when quality is counted or undefined", () => {
    expect(runOutcomeBadge("fail", "counted")?.Icon).toBe(Skull);
    expect(runOutcomeBadge("fail", undefined)?.Icon).toBe(Skull);
    expect(runOutcomeBadge("abandoned", "counted")?.Icon).toBe(LogOut);
    expect(runOutcomeBadge("abandoned", undefined)?.Icon).toBe(LogOut);
  });

  it("gives every non-counted outcome a title mentioning the leaderboard", () => {
    const combos: [RunStatus, RunQuality | undefined][] = [
      ["success", "degraded"],
      ["fail", "skipped"],
      ["abandoned", "skipped"],
      ["success", "partial"],
      ["success", "skipped"],
    ];
    for (const [status, quality] of combos) {
      expect(runOutcomeBadge(status, quality)?.title).toMatch(/leaderboard/i);
    }
  });

  it("never reuses one icon for two different reasons (all five are distinct)", () => {
    const icons = [
      runOutcomeBadge("success", "degraded")?.Icon,
      runOutcomeBadge("fail", "skipped")?.Icon,
      runOutcomeBadge("abandoned", "skipped")?.Icon,
      runOutcomeBadge("success", "partial")?.Icon,
      runOutcomeBadge("success", "skipped")?.Icon,
    ];
    expect(new Set(icons).size).toBe(5);
  });
});

describe("formatEta — compact human ETA for time-to-level", () => {
  it("shows seconds under a minute", () => {
    expect(formatEta(0)).toBe("0s");
    expect(formatEta(45)).toBe("45s");
    expect(formatEta(59.4)).toBe("59s");
  });

  it("shows whole minutes under an hour", () => {
    expect(formatEta(60)).toBe("1m");
    expect(formatEta(52 * 60)).toBe("52m");
  });

  it("shows hours+minutes, then days+hours at high levels", () => {
    expect(formatEta(2 * 3600)).toBe("2h");
    expect(formatEta(3600 + 59 * 60)).toBe("1h59m");
    expect(formatEta(2 * 86400 + 3 * 3600)).toBe("2d3h");
  });

  it("returns — for no income (Infinity) or bad input", () => {
    expect(formatEta(Infinity)).toBe("—");
    expect(formatEta(-5)).toBe("—");
    expect(formatEta(NaN)).toBe("—");
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
