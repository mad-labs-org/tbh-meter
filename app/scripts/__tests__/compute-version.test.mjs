import { describe, expect, it } from "vitest";

import {
  applyBump,
  cmp,
  computeNext,
  intentOf,
  nextPrereleaseNum,
  parseSemver,
} from "../compute-version.mjs";

const feat = "feat(meter): a thing";
const fix = "fix(reader): a bug";
const chore = "chore: tidy";

describe("intentOf", () => {
  it("maps conventional-commit headers to a strength signal", () => {
    expect(intentOf("feat: add thing")).toBe(2);
    expect(intentOf("feat(meter): add thing")).toBe(2);
    expect(intentOf("fix: a bug")).toBe(1);
    expect(intentOf("fix(reader): a bug")).toBe(1);
    expect(intentOf("chore: tidy")).toBe(0);
    expect(intentOf("docs: notes")).toBe(0);
  });

  it("treats `type!:` and a BREAKING CHANGE footer as breaking (3)", () => {
    expect(intentOf("feat!: drop API")).toBe(3);
    expect(intentOf("refactor(app)!: rename")).toBe(3);
    expect(intentOf("feat: x\n\nBREAKING CHANGE: gone")).toBe(3);
    expect(intentOf("feat: x\n\nBREAKING-CHANGE: gone")).toBe(3);
  });
});

describe("applyBump — 0.x guard", () => {
  it("keeps 0.x in 0.x: breaking AND feat bump the MINOR, never crossing to 1.0.0", () => {
    expect(applyBump([0, 4, 0], 3)).toEqual([0, 5, 0]); // breaking
    expect(applyBump([0, 4, 0], 2)).toEqual([0, 5, 0]); // feat
    expect(applyBump([0, 4, 1], 1)).toEqual([0, 4, 2]); // fix
    expect(applyBump([0, 4, 1], 0)).toEqual([0, 4, 2]); // other
  });

  it("bumps normally once major >= 1", () => {
    expect(applyBump([1, 2, 3], 3)).toEqual([2, 0, 0]); // breaking -> major
    expect(applyBump([1, 2, 3], 2)).toEqual([1, 3, 0]); // feat -> minor
    expect(applyBump([1, 2, 3], 1)).toEqual([1, 2, 4]); // fix -> patch
  });
});

describe("nextPrereleaseNum", () => {
  const tags = (...vs) => vs.map((v) => `tbh-meter-v${v}`);

  it("starts at 1 when there is no matching prerelease tag", () => {
    expect(nextPrereleaseNum([], "0.5.0", "rc")).toBe(1);
    expect(nextPrereleaseNum(tags("0.5.0", "0.4.0-rc.7"), "0.5.0", "rc")).toBe(1);
  });

  it("returns highest existing N + 1 for the matching base and id", () => {
    expect(nextPrereleaseNum(tags("0.5.0-rc.1", "0.5.0-rc.2"), "0.5.0", "rc")).toBe(3);
    // gaps don't matter — it's max+1, not count+1
    expect(nextPrereleaseNum(tags("0.5.0-rc.1", "0.5.0-rc.5"), "0.5.0", "rc")).toBe(6);
  });

  it("ignores other base versions, other ids, and non-numeric suffixes", () => {
    const mixed = tags(
      "0.5.0-rc.4",
      "0.6.0-rc.9", // different base
      "0.5.0-beta.8", // different id
      "0.5.0-rc.x", // non-numeric
      "0.5.0-rc.1.2", // not a bare counter
    );
    expect(nextPrereleaseNum(mixed, "0.5.0", "rc")).toBe(5);
    expect(nextPrereleaseNum(mixed, "0.5.0", "beta")).toBe(9);
  });
});

describe("computeNext — P1 refusal + bump + floor", () => {
  const floor0 = [0, 0, 0];

  it("REFUSES when there are zero commits since base (the P1 guard)", () => {
    const d = computeNext({ baseVer: [0, 30, 0], commits: [], floor: floor0, allowEmpty: false });
    expect(d.refused).toBe(true);
    expect(d.version).toBeUndefined();
  });

  it("--allow-empty overrides the refusal → patch bump on an empty range", () => {
    const d = computeNext({ baseVer: [0, 30, 0], commits: [], floor: floor0, allowEmpty: true });
    expect(d.refused).toBe(false);
    expect(d.version).toEqual([0, 30, 1]);
  });

  it("picks the strongest signal across the range (0.x: feat → minor)", () => {
    const d = computeNext({ baseVer: [0, 30, 0], commits: [chore, fix, feat], floor: floor0, allowEmpty: false });
    expect(d).toMatchObject({ refused: false, version: [0, 31, 0], signal: 2 });
  });

  it("fix-only → patch; chore-only still advances (patch)", () => {
    expect(computeNext({ baseVer: [0, 30, 0], commits: [fix], floor: floor0, allowEmpty: false }).version).toEqual([0, 30, 1]);
    expect(computeNext({ baseVer: [0, 30, 0], commits: [chore], floor: floor0, allowEmpty: false }).version).toEqual([0, 30, 1]);
  });

  it("the package.json floor wins (deliberate 1.0.0 graduation)", () => {
    const d = computeNext({ baseVer: [0, 30, 0], commits: [feat], floor: [1, 0, 0], allowEmpty: false });
    expect(d.version).toEqual([1, 0, 0]); // [0,31,0] computed, but floor [1,0,0] is higher
  });
});

describe("parseSemver / cmp", () => {
  it("parses bare X.Y.Z and rejects prerelease/garbage", () => {
    expect(parseSemver("0.5.0")).toEqual([0, 5, 0]);
    expect(parseSemver(" 1.2.3 ")).toEqual([1, 2, 3]);
    expect(parseSemver("0.5.0-rc.1")).toBeNull(); // prerelease tags never become the base
    expect(parseSemver("v1.0")).toBeNull();
  });

  it("orders versions field by field", () => {
    expect(cmp([0, 5, 0], [0, 4, 9])).toBeGreaterThan(0);
    expect(cmp([1, 0, 0], [0, 99, 99])).toBeGreaterThan(0);
    expect(cmp([0, 5, 0], [0, 5, 0])).toBe(0);
    expect(cmp([0, 4, 0], [0, 5, 0])).toBeLessThan(0);
  });
});
