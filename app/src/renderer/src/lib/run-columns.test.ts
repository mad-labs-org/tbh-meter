import { describe, expect, it } from "vitest";
import { resolveColumnConfig, reorderColumnConfig, toggleColumnConfig } from "./run-columns";

const KEYS = ["stage", "dps", "gold", "date"];

describe("resolveColumnConfig", () => {
  it("empty/absent saved -> every default column visible, in default order", () => {
    const expected = KEYS.map((key) => ({ key, visible: true }));
    expect(resolveColumnConfig(KEYS, [])).toEqual(expected);
    expect(resolveColumnConfig(KEYS, undefined)).toEqual(expected);
  });

  it("keeps the saved order + visibility for known keys", () => {
    const saved = [
      { key: "date", visible: true },
      { key: "stage", visible: false },
      { key: "dps", visible: true },
      { key: "gold", visible: true },
    ];
    expect(resolveColumnConfig(KEYS, saved)).toEqual(saved);
  });

  it("drops unknown keys and appends new registry keys as visible", () => {
    const saved = [
      { key: "gone", visible: true }, // removed in this build -> dropped
      { key: "dps", visible: false },
    ];
    expect(resolveColumnConfig(KEYS, saved)).toEqual([
      { key: "dps", visible: false },
      { key: "stage", visible: true },
      { key: "gold", visible: true },
      { key: "date", visible: true },
    ]);
  });

  it("is idempotent", () => {
    const saved = [{ key: "gold", visible: false }, { key: "stage", visible: true }];
    const once = resolveColumnConfig(KEYS, saved);
    expect(resolveColumnConfig(KEYS, once)).toEqual(once);
  });
});

describe("reorderColumnConfig", () => {
  const cfg = KEYS.map((key) => ({ key, visible: true }));

  it("moves a column to the target's position", () => {
    expect(reorderColumnConfig(cfg, "date", "stage").map((c) => c.key)).toEqual([
      "date",
      "stage",
      "dps",
      "gold",
    ]);
    expect(reorderColumnConfig(cfg, "stage", "gold").map((c) => c.key)).toEqual([
      "dps",
      "gold",
      "stage",
      "date",
    ]);
  });

  it("no-ops (same array) on equal or missing key", () => {
    expect(reorderColumnConfig(cfg, "dps", "dps")).toBe(cfg);
    expect(reorderColumnConfig(cfg, "nope", "dps")).toBe(cfg);
  });
});

describe("toggleColumnConfig", () => {
  it("flips visibility", () => {
    const cfg = [
      { key: "a", visible: true },
      { key: "b", visible: true },
    ];
    expect(toggleColumnConfig(cfg, "a")).toEqual([
      { key: "a", visible: false },
      { key: "b", visible: true },
    ]);
  });

  it("never hides the last visible column", () => {
    const cfg = [
      { key: "a", visible: true },
      { key: "b", visible: false },
    ];
    expect(toggleColumnConfig(cfg, "a")).toEqual(cfg); // 'a' is the last visible -> unchanged
  });

  it("re-showing a hidden column always works", () => {
    const cfg = [
      { key: "a", visible: true },
      { key: "b", visible: false },
    ];
    expect(toggleColumnConfig(cfg, "b")).toEqual([
      { key: "a", visible: true },
      { key: "b", visible: true },
    ]);
  });
});
