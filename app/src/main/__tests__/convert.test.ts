import { describe, expect, it } from "vitest";
import { convert, STRUCTURED_SCHEMA_VERSION } from "../converter/convert.js";
import { COUNT_FLOOR_SEC } from "../converter/helpers.js";
import { RAW_V1_EXAMPLE } from "../../shared/__fixtures__/raw-v1.js";
import { RAW_V2_EXAMPLE } from "../../shared/__fixtures__/raw-v2.js";
import { STRUCTURED_V1_EXAMPLE } from "../../shared/__fixtures__/structured-v1.js";
import type { RawRun, Field } from "../../shared/raw-types.js";

// Build a clean v1 raw with all reads succeeding; override any field per test. Mirrors the canonical
// RAW_V1_EXAMPLE but tunable, so each quality/issue path gets an isolated input.
function rawRun(overrides: Partial<RawRun> = {}): RawRun {
  return {
    raw_schema_version: 1,
    id: "sess-1:3",
    ts: 1_700_000_000,
    run: 3,
    run_outcome: "success",
    session_id: "sess-1",
    game_version: "1.00.10",
    duration: 92,
    stageKey: { ok: true, value: 30901 },
    act: { ok: true, value: 3 },
    stageNo: { ok: true, value: 9 },
    difficulty: { ok: true, value: 2 },
    total_mobs: { ok: true, value: 120 },
    mobs: { ok: true, value: 118 },
    total_damage: { ok: true, value: 4_500_000 },
    clear_time: { ok: true, value: 90 },
    gold_gained: { ok: true, value: 125_000 },
    gold_source: "live",
    xp_gained: { ok: true, value: 3_400_000 },
    xp_source: "live",
    drops: { ok: true, value: [] },
    heroes: { ok: true, value: [] },
    ...overrides,
  };
}

describe("convert — golden (canonical raw -> canonical structured)", () => {
  it("converts RAW_V1_EXAMPLE byte-for-byte into STRUCTURED_V1_EXAMPLE", () => {
    expect(convert(RAW_V1_EXAMPLE)).toEqual(STRUCTURED_V1_EXAMPLE);
  });

  it("is pure — same input yields a deep-equal output every call", () => {
    expect(convert(RAW_V1_EXAMPLE)).toEqual(convert(RAW_V1_EXAMPLE));
  });
});

describe("convert — identity & provenance", () => {
  it("carries the run id verbatim (external_id continuity, never re-minted)", () => {
    expect(convert(rawRun()).id).toBe("sess-1:3");
  });

  it("passes the reader-owned session_id THROUGH (does not re-derive it)", () => {
    expect(convert(rawRun({ session_id: "reader-session-xyz" })).sessionId).toBe("reader-session-xyz");
  });

  it("stamps schemaVersion (raw provenance) and structuredSchemaVersion (its own output)", () => {
    const r = convert(rawRun());
    expect(r.schemaVersion).toBe(1);
    expect(r.structuredSchemaVersion).toBe(STRUCTURED_SCHEMA_VERSION);
  });

  it("maps the game outcome to status and derives the stage/mode labels", () => {
    const r = convert(rawRun({ run_outcome: "fail" }));
    expect(r.status).toBe("fail");
    expect(r.stage).toBe("3-9");
    expect(r.mode).toBe("Hell");
  });
});

describe("convert — derived numbers", () => {
  it("derives dps from total_damage / clear_time", () => {
    expect(convert(rawRun()).dps).toBeCloseTo(50_000, 5);
  });

  it("derives gold/sec and xp/sec from the same reference", () => {
    const r = convert(rawRun());
    expect(r.goldPerSec).toBeCloseTo(1_388.89, 2);
    expect(r.xpPerSec).toBeCloseTo(37_777.78, 2);
  });

  it("does NOT recompute gold/xp — it passes the reader's value through", () => {
    const r = convert(rawRun({ gold_gained: { ok: true, value: 999 }, xp_gained: { ok: true, value: 7 } }));
    expect(r.goldGained).toBe(999);
    expect(r.xpGained).toBe(7);
  });

  it("carries the metric source tags from the raw", () => {
    const r = convert(rawRun({ gold_source: "save", xp_source: "save" }));
    expect(r.goldSource).toBe("save");
    expect(r.xpSource).toBe("save");
  });
});

describe("convert — envelope unwrapping (couldn't-read != real zero)", () => {
  it("a real zero gold stays 0 with NO issue (legit read of 0)", () => {
    const r = convert(rawRun({ gold_gained: { ok: true, value: 0 } }));
    expect(r.goldGained).toBe(0);
    expect(r.issues).toEqual({});
    expect(r.quality).toBe("counted");
  });

  it("an unread gold becomes degraded with an issue (the 1.00.10 gold:0 bug, fixed)", () => {
    const r = convert(rawRun({ gold_gained: { ok: false, error: "gold unread (live+save failed)" } }));
    expect(r.goldGained).toBe(0); // fallback value
    expect(r.issues!.gold_gained).toBe("gold unread (live+save failed)");
    expect(r.quality).toBe("degraded");
  });

  it("an unread stageKey degrades the run", () => {
    const r = convert(rawRun({ stageKey: { ok: false, error: "stage unresolved" } }));
    expect(r.stageKey).toBeNull();
    expect(r.issues!.stageKey).toBe("stage unresolved");
    expect(r.quality).toBe("degraded");
  });

  it("an unread total_damage degrades the run", () => {
    const r = convert(rawRun({ total_damage: { ok: false, error: "dps tracker missing" } }));
    expect(r.issues!.total_damage).toBe("dps tracker missing");
    expect(r.quality).toBe("degraded");
  });

  it("an unread heroes (live party off) degrades the run — who played is unknown, must not rank", () => {
    const r = convert(rawRun({ heroes: { ok: false, error: "party live off (StageManager unresolved)" } }));
    expect(r.heroes).toEqual([]); // fallback: empty, NEVER the save roster
    expect(r.issues!.heroes).toBe("party live off (StageManager unresolved)");
    expect(r.quality).toBe("degraded"); // shows locally (marked), but auto-upload skips degraded
  });

  it('an unresolved stage sub-field shows "?" but does NOT degrade (cosmetic)', () => {
    const r = convert(
      rawRun({ act: { ok: false, error: "stage unresolved" }, stageNo: { ok: false, error: "stage unresolved" } }),
    );
    expect(r.stage).toBe("?");
    expect(r.mode).toBe("Hell"); // difficulty still read
    expect(r.quality).toBe("counted"); // act/stageNo are not critical fields
    expect(r.issues!.act).toBe("stage unresolved");
  });

  it("an unresolved difficulty yields mode '?' without degrading", () => {
    const r = convert(rawRun({ difficulty: { ok: false, error: "stage unresolved" } }));
    expect(r.mode).toBe("?");
    expect(r.quality).toBe("counted");
  });
});

describe("convert — quality verdict", () => {
  it("a clean success above the floor counts", () => {
    expect(convert(rawRun()).quality).toBe("counted");
  });

  it("a sub-floor run is skipped (below 15s, not x-10)", () => {
    const r = convert(rawRun({ clear_time: { ok: true, value: 10 }, duration: 10 }));
    expect(r.quality).toBe("skipped");
    expect(COUNT_FLOOR_SEC).toBe(15);
  });

  it("a non-x-10 success at/above the 15s floor (and below the old 30s) still counts", () => {
    // 20s sits in the 15-29s band the PR moved the floor through (reader's historical 30 -> 15).
    // stageNo 9 keeps it off the x-10 exemption; damage > 0 keeps it off the partial path.
    const r = convert(
      rawRun({ stageNo: { ok: true, value: 9 }, clear_time: { ok: true, value: 20 }, duration: 20, total_damage: { ok: true, value: 2_000_000 } }),
    );
    expect(r.quality).toBe("counted"); // would be "skipped" if the floor regressed to 30
  });

  it("a non-x-10 success below the 15s floor is skipped (lower boundary)", () => {
    const r = convert(
      rawRun({ stageNo: { ok: true, value: 9 }, clear_time: { ok: true, value: 14 }, duration: 14, total_damage: { ok: true, value: 2_000_000 } }),
    );
    expect(r.quality).toBe("skipped");
  });

  it("x-10 (stageNo 10) is EXEMPT from the floor — a short boss clear still counts", () => {
    const r = convert(
      rawRun({
        stageNo: { ok: true, value: 10 },
        clear_time: { ok: true, value: 8 },
        duration: 8,
        total_damage: { ok: true, value: 2_000_000 },
      }),
    );
    expect(r.quality).toBe("counted");
  });

  it("a fail run is skipped (real history, never leaderboard material)", () => {
    expect(convert(rawRun({ run_outcome: "fail" })).quality).toBe("skipped");
  });

  it("an abandoned run is skipped", () => {
    expect(convert(rawRun({ run_outcome: "abandoned" })).quality).toBe("skipped");
  });

  it("a success that captured <80% of the clear is partial (joined mid-run)", () => {
    // clear_time 100, but measured (duration) only 50 -> 50% < 80%.
    const r = convert(rawRun({ clear_time: { ok: true, value: 100 }, duration: 50 }));
    expect(r.partial).toBe(true);
    expect(r.quality).toBe("partial");
  });

  it("a success with non-positive damage is ALWAYS partial (#163; covers short x-10)", () => {
    const r = convert(
      rawRun({ stageNo: { ok: true, value: 10 }, clear_time: { ok: true, value: 8 }, duration: 8, total_damage: { ok: true, value: 0 } }),
    );
    expect(r.partial).toBe(true);
    expect(r.quality).toBe("partial");
  });

  it("a short x-10 with damage <80% of a >=30s clear is NOT mis-flagged partial (clear<30 guard)", () => {
    // clear_time 20 (< 30) so the first partial clause is gated off; damage > 0 so the second
    // clause does not fire -> a legitimate short boss clear counts.
    const r = convert(
      rawRun({ stageNo: { ok: true, value: 10 }, clear_time: { ok: true, value: 20 }, duration: 5, total_damage: { ok: true, value: 1_000 } }),
    );
    expect(r.partial).toBe(false);
    expect(r.quality).toBe("counted");
  });

  it("degraded outranks partial (a critical read failure wins the verdict)", () => {
    const r = convert(
      rawRun({ clear_time: { ok: true, value: 100 }, duration: 50, gold_gained: { ok: false, error: "x" } }),
    );
    expect(r.quality).toBe("degraded");
  });

  it("coerces a garbage run_outcome so a real success is NOT mis-sealed skipped (raw is untrusted)", () => {
    // A hand-edited/corrupt raw with run_outcome "sucesso" (off the EN union) must be repaired to
    // "abandoned" with an issue, NOT trusted verbatim — else classifyQuality would treat it as
    // status !== "success" and seal this clean clear `skipped` (hidden + non-uploadable).
    const r = convert(rawRun({ run_outcome: "sucesso" as unknown as "success" }));
    expect(r.status).toBe("abandoned");
    expect(r.issues!.run_outcome).toContain("sucesso");
    // a real success run_outcome stays success with no run_outcome issue.
    const ok = convert(rawRun());
    expect(ok.status).toBe("success");
    expect(ok.issues!.run_outcome).toBeUndefined();
  });

  it("coerces an off-union metric source to '' (corrupt raw can't persist a garbage source)", () => {
    const r = convert(
      rawRun({ gold_source: "bogus" as unknown as "live", xp_source: "save" }),
    );
    expect(r.goldSource).toBe("");
    expect(r.xpSource).toBe("save");
  });
});

describe("convert — heroes & drops", () => {
  it("maps heroes (camel ids preserved, stats coerced, opaque uniqueId)", () => {
    const r = convert(
      rawRun({
        heroes: {
          ok: true,
          value: [
            {
              heroKey: 1001,
              classId: 5,
              class: "0x5",
              level: 80,
              exp: 123,
              items: [
                {
                  slot: "weapon",
                  slotId: 0,
                  grade: "legendary",
                  gradeId: 4,
                  itemKey: 50012,
                  uniqueId: "1099511627776123",
                  level: 20,
                  mods: [{ recipeId: 11, recipe: "atk", statId: 3, stat: "ATK", value: 1500, tier: 3 }],
                },
              ],
              skills: [{ key: 7001, lv: 5 }],
              stats: { "0": 1500, "1": Number.NaN },
            },
          ],
        },
      }),
    );
    expect(r.heroes).toHaveLength(1);
    expect(r.heroes[0].heroKey).toBe(1001);
    expect((r.heroes[0] as { uniqueId?: string }).uniqueId).toBe(undefined); // not on hero — it's on the item
    expect(r.heroes[0].items[0].uniqueId).toBe("1099511627776123");
    expect(r.heroes[0].stats).toEqual({ "0": 1500 }); // NaN filtered out
  });

  it("maps killed_by (finite numbers only) and filters skillLevels to v>0", () => {
    const r = convert(
      rawRun({
        heroes: {
          ok: true,
          value: [
            {
              heroKey: 1,
              classId: null,
              class: "",
              level: 1,
              exp: 0,
              items: [],
              skills: [],
              // a v8 invested tree with a 0-level entry that must be dropped
              skillLevels: { "7001": 5, "7002": 0 },
              stats: {},
              // mixed garbage: non-numbers are filtered, finite monster keys survive in order
              killed_by: [30102, "x" as unknown as number, null as unknown as number, 30103],
            },
          ],
        },
      }),
    );
    expect(r.heroes[0].killedBy).toEqual([30102, 30103]);
    expect(r.heroes[0].skillLevels).toEqual({ "7001": 5 });
  });

  it("leaves killedBy undefined for a hero with no killed_by", () => {
    const r = convert(
      rawRun({
        heroes: {
          ok: true,
          value: [{ heroKey: 1, classId: null, class: "", level: 1, exp: 0, items: [], skills: [], stats: {} }],
        },
      }),
    );
    expect(r.heroes[0].killedBy).toBeUndefined();
  });

  it("sums run-level deaths/revives from the per-hero counts", () => {
    const r = convert(
      rawRun({
        heroes: {
          ok: true,
          value: [
            { heroKey: 1, classId: null, class: "", level: 1, exp: 0, items: [], skills: [], stats: {}, deaths: 2, revives: 1 },
            { heroKey: 2, classId: null, class: "", level: 1, exp: 0, items: [], skills: [], stats: {}, deaths: 1 },
          ],
        },
      }),
    );
    expect(r.deaths).toBe(3);
    expect(r.revives).toBe(1);
  });

  it("omits drops when none dropped", () => {
    expect(convert(rawRun({ drops: { ok: true, value: [] } })).drops).toBeUndefined();
  });

  it("maps drops snake_case -> camelCase and filters malformed entries", () => {
    const r = convert(
      rawRun({
        // a malformed entry (missing monster_type) is filtered; the valid one survives.
        drops: { ok: true, value: [{ box_key: 920011, monster_type: 1 }, { box_key: 7 } as never] },
      }),
    );
    expect(r.drops).toEqual([{ boxKey: 920011, monsterType: 1 }]);
  });
});

describe("convert — dispatch by raw_schema_version", () => {
  it("flags an unsupported raw_schema_version as an issue (best-effort convert)", () => {
    // Force an out-of-contract version to prove the dispatch records it rather than silently parsing.
    const raw = { ...rawRun(), raw_schema_version: 99 as unknown as 1 };
    const r = convert(raw as RawRun);
    expect(r.issues!.raw_schema_version).toContain("unsupported");
  });
});

describe("convert — defensive against a malformed Field", () => {
  it("a missing/garbage envelope falls back and records a 'missing' issue", () => {
    const r = convert(rawRun({ mobs: undefined as unknown as Field<number> }));
    expect(r.mobs).toBe(0);
    expect(r.issues!.mobs).toBe("missing");
  });
});

describe("convert — raw v2 (Redesign 2: id = end-ts ms, no session)", () => {
  it("carries the end-ts (ms) id verbatim and stamps schemaVersion 2", () => {
    const r = convert(RAW_V2_EXAMPLE);
    expect(r.id).toBe("1717800000123"); // = str(ts_ms): the run's own instant is its identity
    expect(r.ts).toBe(1717800000123);
    expect(r.schemaVersion).toBe(2);
    expect(r.structuredSchemaVersion).toBe(STRUCTURED_SCHEMA_VERSION);
  });

  it("leaves sessionId empty and run 0 — both become app-derived, not reader-emitted", () => {
    const r = convert(RAW_V2_EXAMPLE);
    expect(r.sessionId).toBe("");
    expect(r.run).toBe(0);
  });

  it("still derives quality + dps from the observed fields (same rule as v1)", () => {
    const r = convert(RAW_V2_EXAMPLE);
    expect(r.quality).toBe("counted");
    expect(r.issues).toEqual({});
    expect(r.dps).toBeCloseTo(4_500_000 / 90, 2);
  });

  it("is pure for v2 too — same input yields a deep-equal output", () => {
    expect(convert(RAW_V2_EXAMPLE)).toEqual(convert(RAW_V2_EXAMPLE));
  });
});
