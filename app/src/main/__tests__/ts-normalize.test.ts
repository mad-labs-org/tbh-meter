import { describe, expect, it } from "vitest";
import { tsToMs } from "../sources/runs-source.js";

// Redesign 2: raw v2 emits ts in MS; legacy v1 logs carry SECONDS. loadStructured normalizes to ms
// so newest-first sort + date display stay consistent across the mixed set.
describe("tsToMs — unify v1 seconds / v2 ms to milliseconds", () => {
  it("upgrades a seconds epoch (v1) to ms", () => {
    expect(tsToMs(1_717_800_000)).toBe(1_717_800_000_000);
  });

  it("leaves a ms epoch (v2) unchanged", () => {
    expect(tsToMs(1_717_800_000_123)).toBe(1_717_800_000_123);
  });

  it("is idempotent — re-normalizing an already-ms value is a no-op", () => {
    expect(tsToMs(tsToMs(1_717_800_000))).toBe(1_717_800_000_000);
  });

  it("leaves 0 / non-positive unchanged (no spurious ×1000)", () => {
    expect(tsToMs(0)).toBe(0);
    expect(tsToMs(-5)).toBe(-5);
  });

  it("the 1e11 boundary: just-below is seconds (×1000), at/above is ms", () => {
    expect(tsToMs(1e11 - 1)).toBe((1e11 - 1) * 1000);
    expect(tsToMs(1e11)).toBe(1e11);
  });
});
