import { describe, expect, it } from "vitest";
import {
  normalizeRecord,
  dedupeSessionScoped,
  dedupeById,
} from "../sources/runs-source.js";
import type { RunRecord } from "../../shared/run-types.js";

// ---------------------------------------------------------------------------
// Helper: build a minimal v10 raw record (all required fields present)
// ---------------------------------------------------------------------------
function rawRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ts: 1_700_000_000,
    session_id: "sess-abc",
    schema_version: 10,
    game_version: "1.00.07",
    run: 1,
    status: "success",
    stage: "2-5",
    act: 2,
    stageNo: 5,
    stageKey: 2105,
    mode: "Normal",
    mobs: 147,
    total_mobs: 200,
    total_damage: 5_000_000,
    dps: 100_000,
    clear_time: 50,
    duration: 52,
    gold_gained: 120_000,
    gold_source: "live",
    xp_gained: 30_000,
    xp_source: "live",
    xp_per_sec: 600,
    gold_per_sec: 2_400,
    partial: false,
    heroes: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// normalizeRecord — core field normalization
// ---------------------------------------------------------------------------

describe("normalizeRecord — core fields", () => {
  it("maps ts, sessionId, schemaVersion correctly", () => {
    const r = normalizeRecord(rawRecord(), 0);
    expect(r.ts).toBe(1_700_000_000);
    expect(r.sessionId).toBe("sess-abc");
    expect(r.schemaVersion).toBe(10);
  });

  it("builds id from sessionId:run when both present", () => {
    const r = normalizeRecord(rawRecord({ session_id: "s1", run: 3 }), 0);
    expect(r.id).toBe("s1:3");
  });

  it("uses idx:N as id fallback when run is missing", () => {
    const r = normalizeRecord(rawRecord({ run: undefined }), 7);
    expect(r.id).toBe("idx:7");
  });

  it("uses noSession prefix when session_id is empty", () => {
    const r = normalizeRecord(rawRecord({ session_id: "" }), 0);
    expect(r.id).toMatch(/^noSession:/);
  });

  it("normalizes success status", () => {
    expect(normalizeRecord(rawRecord({ status: "success" }), 0).status).toBe("success");
  });

  it("normalizes fail status", () => {
    expect(normalizeRecord(rawRecord({ status: "fail" }), 0).status).toBe("fail");
  });

  it("normalizes abandoned status", () => {
    expect(normalizeRecord(rawRecord({ status: "abandoned" }), 0).status).toBe("abandoned");
  });

  it("maps legacy PT status 'sucesso'", () => {
    expect(normalizeRecord(rawRecord({ status: "sucesso" }), 0).status).toBe("success");
  });

  it("maps legacy PT status 'falha'", () => {
    expect(normalizeRecord(rawRecord({ status: "falha" }), 0).status).toBe("fail");
  });

  it("maps legacy PT status 'abandonada'", () => {
    expect(normalizeRecord(rawRecord({ status: "abandonada" }), 0).status).toBe("abandoned");
  });

  it("maps totalDamage from total_damage (v6)", () => {
    expect(normalizeRecord(rawRecord({ total_damage: 9_999 }), 0).totalDamage).toBe(9_999);
  });

  it("maps totalDamage from dano_total (≤v5 fallback)", () => {
    const r = normalizeRecord(rawRecord({ total_damage: undefined, dano_total: 8_888 }), 0);
    expect(r.totalDamage).toBe(8_888);
  });

  it("maps goldGained from gold_gained (v6)", () => {
    expect(normalizeRecord(rawRecord({ gold_gained: 200_000 }), 0).goldGained).toBe(200_000);
  });

  it("maps goldGained from gold_ganho (v5 fallback)", () => {
    const r = normalizeRecord(rawRecord({ gold_gained: undefined, gold_ganho: 150_000 }), 0);
    expect(r.goldGained).toBe(150_000);
  });

  it("partial flag: true when present", () => {
    expect(normalizeRecord(rawRecord({ partial: true }), 0).partial).toBe(true);
  });

  it("partial flag: false when absent (legacy records)", () => {
    const raw = rawRecord();
    delete raw.partial;
    expect(normalizeRecord(raw, 0).partial).toBe(false);
  });

  it("waveNow and waveTotal are undefined for non-fail runs", () => {
    const r = normalizeRecord(rawRecord(), 0);
    expect(r.waveNow).toBeNull();
    expect(r.waveTotal).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// normalizeRecord — drops field (v10+)
// ---------------------------------------------------------------------------

describe("normalizeRecord — drops (v10)", () => {
  it("drops is undefined when absent (old records)", () => {
    const raw = rawRecord();
    delete raw.drops;
    expect(normalizeRecord(raw, 0).drops).toBeUndefined();
  });

  it("drops is undefined when empty array", () => {
    expect(normalizeRecord(rawRecord({ drops: [] }), 0).drops).toBeUndefined();
  });

  it("normalizes valid drops (snake_case → camelCase)", () => {
    const raw = rawRecord({
      drops: [
        { box_key: 920011, monster_type: 1 },
        { box_key: 910011, monster_type: 0 },
      ],
    });
    const r = normalizeRecord(raw, 0);
    expect(r.drops).toHaveLength(2);
    expect(r.drops![0]).toEqual({ boxKey: 920011, monsterType: 1 });
    expect(r.drops![1]).toEqual({ boxKey: 910011, monsterType: 0 });
  });

  it("filters out null entries in drops array", () => {
    const raw = rawRecord({ drops: [null, { box_key: 920011, monster_type: 1 }] });
    const r = normalizeRecord(raw, 0);
    expect(r.drops).toHaveLength(1);
  });

  it("filters out entries with non-numeric box_key", () => {
    const raw = rawRecord({
      drops: [
        { box_key: "not-a-number", monster_type: 1 },
        { box_key: 920011, monster_type: 1 },
      ],
    });
    const r = normalizeRecord(raw, 0);
    expect(r.drops).toHaveLength(1);
    expect(r.drops![0].boxKey).toBe(920011);
  });

  it("filters out entries missing monster_type", () => {
    const raw = rawRecord({
      drops: [{ box_key: 920011 }],
    });
    expect(normalizeRecord(raw, 0).drops).toBeUndefined();
  });

  it("handles 3 chest types (common=0, stage boss=1, act boss=2)", () => {
    const raw = rawRecord({
      drops: [
        { box_key: 910011, monster_type: 0 },  // common
        { box_key: 920011, monster_type: 1 },  // stage boss
        { box_key: 930101, monster_type: 2 },  // act boss
      ],
    });
    const r = normalizeRecord(raw, 0);
    expect(r.drops).toHaveLength(3);
    expect(r.drops!.map((d) => d.monsterType)).toEqual([0, 1, 2]);
  });
});

// ---------------------------------------------------------------------------
// normalizeRecord — deaths/revives/killedBy (v11+)
// ---------------------------------------------------------------------------

describe("normalizeRecord — deaths/revives (v11)", () => {
  it("run-level deaths/revives are undefined when absent (pre-v11)", () => {
    const r = normalizeRecord(rawRecord(), 0);
    expect(r.deaths).toBeUndefined();
    expect(r.revives).toBeUndefined();
  });

  it("maps run-level deaths and revives", () => {
    const r = normalizeRecord(rawRecord({ schema_version: 11, deaths: 3, revives: 2 }), 0);
    expect(r.deaths).toBe(3);
    expect(r.revives).toBe(2);
  });

  it("keeps deaths/revives = 0 (0 is meaningful: tracked, none happened)", () => {
    const r = normalizeRecord(rawRecord({ schema_version: 11, deaths: 0, revives: 0 }), 0);
    expect(r.deaths).toBe(0);
    expect(r.revives).toBe(0);
  });

  it("normalizes per-hero deaths/revives/killedBy (killed_by → killedBy)", () => {
    const raw = rawRecord({
      heroes: [{ heroKey: 201, deaths: 2, revives: 1, killed_by: [30102, 30103] }],
    });
    const h = normalizeRecord(raw, 0).heroes[0];
    expect(h.deaths).toBe(2);
    expect(h.revives).toBe(1);
    expect(h.killedBy).toEqual([30102, 30103]);
  });

  it("per-hero survival fields are undefined when absent (sparse)", () => {
    const h = normalizeRecord(rawRecord({ heroes: [{ heroKey: 201 }] }), 0).heroes[0];
    expect(h.deaths).toBeUndefined();
    expect(h.revives).toBeUndefined();
    expect(h.killedBy).toBeUndefined();
  });

  it("filters non-numeric entries from killed_by", () => {
    const raw = rawRecord({ heroes: [{ heroKey: 201, killed_by: [30102, "x", null, 30103] }] });
    expect(normalizeRecord(raw, 0).heroes[0].killedBy).toEqual([30102, 30103]);
  });

  it("killedBy is undefined when killed_by is empty", () => {
    const raw = rawRecord({ heroes: [{ heroKey: 201, killed_by: [] }] });
    expect(normalizeRecord(raw, 0).heroes[0].killedBy).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// normalizeRecord — hero normalization
// ---------------------------------------------------------------------------

describe("normalizeRecord — heroes", () => {
  function rawHero(overrides: Record<string, unknown> = {}) {
    return {
      heroKey: 1001,
      class: "Ranger",
      classId: 2,
      level: 45,
      exp: 1234.5,
      items: [],
      skills: [],
      stats: { AttackDamage: 999 },
      ...overrides,
    };
  }

  it("normalizes a basic hero", () => {
    const r = normalizeRecord(rawRecord({ heroes: [rawHero()] }), 0);
    expect(r.heroes).toHaveLength(1);
    expect(r.heroes[0].heroKey).toBe(1001);
    expect(r.heroes[0].class).toBe("Ranger");
    expect(r.heroes[0].level).toBe(45);
  });

  it("maps v7+ skills [{key, lv}] to RunSkill[]", () => {
    const r = normalizeRecord(
      rawRecord({ heroes: [rawHero({ skills: [{ key: 10101, lv: 3 }] })] }),
      0,
    );
    expect(r.heroes[0].skills).toEqual([{ key: 10101, lv: 3 }]);
  });

  it("maps legacy v6 skills [number] to RunSkill[] with null lv", () => {
    const r = normalizeRecord(
      rawRecord({ heroes: [rawHero({ skills: [10101, 10201] })] }),
      0,
    );
    expect(r.heroes[0].skills).toEqual([
      { key: 10101, lv: null },
      { key: 10201, lv: null },
    ]);
  });

  it("normalizes stats object", () => {
    const r = normalizeRecord(
      rawRecord({ heroes: [rawHero({ stats: { AttackDamage: 500, MaxHp: 1000 } })] }),
      0,
    );
    expect(r.heroes[0].stats).toEqual({ AttackDamage: 500, MaxHp: 1000 });
  });

  it("filters non-finite stats values", () => {
    const r = normalizeRecord(
      rawRecord({ heroes: [rawHero({ stats: { AttackDamage: NaN, MaxHp: 1000 } })] }),
      0,
    );
    expect(r.heroes[0].stats).toEqual({ MaxHp: 1000 });
  });
});

// ---------------------------------------------------------------------------
// The session-scoped dedup NET (progress.md "Dedup" — safety layer behind the
// PR7 single-writer primary). These lock the pure decision directly: it collapses
// the two-reader phantom (identical content under DIFFERENT sessions) and NEVER a
// real farm (distinct runs in the SAME session, even if they look identical), so
// the single-writer guard's residual escape (a rare double-write) is caught with
// zero false-hide of a grind. (The file-watching seam is covered in the logs
// integration test; this is the boundary, fast + I/O-free.)
// ---------------------------------------------------------------------------
function dedupRec(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "s:1",
    ts: 1_000,
    sessionId: "s",
    schemaVersion: 11,
    gameVersion: "1.00.10",
    run: 1,
    status: "success",
    stage: "2-5",
    act: 2,
    stageNo: 5,
    stageKey: 2105,
    mode: "Normal",
    mobs: 100,
    totalMobs: 200,
    totalDamage: 500_000,
    dps: 10_000,
    clearTime: 50,
    duration: 52,
    goldGained: 100_000,
    goldSource: "live",
    xpGained: 20_000,
    xpSource: "live",
    xpPerSec: 400,
    goldPerSec: 2_000,
    partial: false,
    heroes: [],
    ...overrides,
  };
}

describe("dedupeSessionScoped — collapses the two-reader phantom, never a farm", () => {
  it("collapses identical content across DIFFERENT sessions (the phantom), keeping the first", () => {
    // Two readers (AV respawn) wrote the same finished run under their OWN session ids.
    const newest = dedupRec({ id: "sA:1", sessionId: "sA", ts: 2_000 });
    const older = dedupRec({ id: "sB:1", sessionId: "sB", ts: 1_000 });
    const out = dedupeSessionScoped([newest, older]); // input is newest-first
    expect(out).toHaveLength(1);
    expect(out[0].sessionId).toBe("sA"); // the first (newest) owns the signature
  });

  it("NEVER collapses a real farm: distinct same-session runs that look identical both survive", () => {
    // One grind, two genuinely-distinct runs (run 1 vs 2), identical stage/damage/gold.
    const r1 = dedupRec({ id: "s:1", run: 1, sessionId: "s", ts: 2_000 });
    const r2 = dedupRec({ id: "s:2", run: 2, sessionId: "s", ts: 1_000 });
    const out = dedupeSessionScoped([r1, r2]);
    expect(out.map((r) => r.id)).toEqual(["s:1", "s:2"]); // zero false-hide of the farm
  });

  it("keeps content-distinct runs across different sessions (only IDENTICAL content collapses)", () => {
    const a = dedupRec({ id: "sA:1", sessionId: "sA", totalDamage: 100_000 });
    const b = dedupRec({ id: "sB:1", sessionId: "sB", totalDamage: 999_999 });
    expect(dedupeSessionScoped([a, b])).toHaveLength(2);
  });

  it("uses RAW stable fields only — a drifted dps/duration/ts does not split a phantom pair", () => {
    // Two phantom copies of one run whose derived values drifted between finalizations still
    // collapse: contentSig excludes dps/duration/ts (only stage/mode/status/damage/clear/gold/
    // xp/mobs). If the signature wrongly included a derived field, the second would survive.
    const a = dedupRec({ id: "sA:1", sessionId: "sA", ts: 2_000, dps: 10_000, duration: 52 });
    const b = dedupRec({ id: "sB:1", sessionId: "sB", ts: 1_000, dps: 99_999, duration: 88 });
    expect(dedupeSessionScoped([a, b])).toHaveLength(1);
  });
});

describe("dedupeById — collapses a re-finalized run (same id) to the first", () => {
  it("keeps the first occurrence of a shared id (newest, over a newest-first list)", () => {
    const newest = dedupRec({ id: "s:1", ts: 2_000, dps: 111 });
    const older = dedupRec({ id: "s:1", ts: 1_000, dps: 222 }); // same id, re-finalized
    const out = dedupeById([newest, older]);
    expect(out).toHaveLength(1);
    expect(out[0].dps).toBe(111); // the newest copy survived
  });

  it("keeps records with distinct ids (a real farm: run 1 vs run 2)", () => {
    const r1 = dedupRec({ id: "s:1", run: 1 });
    const r2 = dedupRec({ id: "s:2", run: 2 });
    expect(dedupeById([r1, r2]).map((r) => r.id)).toEqual(["s:1", "s:2"]);
  });
});
