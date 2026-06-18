import { describe, expect, it } from "vitest";
import { loadStructured, dedupeSessionScoped, dedupeById } from "../sources/runs-source.js";
import type { RunRecord } from "../../shared/run-types.js";

// Unit tests for the app's READ path (PR4): loadStructured parses ONE already-converted
// logs/<id>.json into a RunRecord (no re-derivation — the converter did that once), and
// dedupeSessionScoped collapses the two-reader phantom while never touching a real farm.

// ---------------------------------------------------------------------------
// loadStructured — parse a structured logs/<id>.json (the converter's output)
// ---------------------------------------------------------------------------

/** A structured record as the converter writes it (camelCase, derived numbers + quality). */
function structured(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "sess-1:3",
    ts: 1_700_000_000,
    sessionId: "sess-1",
    schemaVersion: 1,
    structuredSchemaVersion: 1,
    gameVersion: "1.00.10",
    run: 3,
    status: "success",
    quality: "counted",
    stage: "3-9",
    act: 3,
    stageNo: 9,
    stageKey: 30901,
    mode: "Hell",
    mobs: 118,
    totalMobs: 120,
    totalDamage: 4_500_000,
    dps: 50_000,
    clearTime: 90,
    duration: 92,
    goldGained: 125_000,
    goldSource: "live",
    xpGained: 3_400_000,
    xpSource: "live",
    xpPerSec: 37_777.78,
    goldPerSec: 1_388.89,
    partial: false,
    issues: {},
    heroes: [],
    ...overrides,
  };
}

describe("loadStructured — core fields (no re-derivation)", () => {
  it("loads a clean structured record verbatim", () => {
    const r = loadStructured(structured())!;
    expect(r.id).toBe("sess-1:3");
    expect(r.sessionId).toBe("sess-1");
    expect(r.stage).toBe("3-9");
    expect(r.mode).toBe("Hell");
    // dps/rates are READ from the file, not recomputed.
    expect(r.dps).toBe(50_000);
    expect(r.xpPerSec).toBe(37_777.78);
    expect(r.goldPerSec).toBe(1_388.89);
  });

  it("carries the converter quality + structuredSchemaVersion", () => {
    const r = loadStructured(structured({ quality: "degraded", structuredSchemaVersion: 2 }))!;
    expect(r.quality).toBe("degraded");
    expect(r.structuredSchemaVersion).toBe(2);
  });

  it("returns null when id is missing (not a run record)", () => {
    const raw = structured();
    delete raw.id;
    expect(loadStructured(raw)).toBeNull();
  });

  it("returns null when id is empty", () => {
    expect(loadStructured(structured({ id: "" }))).toBeNull();
  });

  it("returns null when ts is missing (a corrupt log must skip, not sort as epoch-0)", () => {
    const raw = structured();
    delete raw.ts;
    expect(loadStructured(raw)).toBeNull();
  });

  it("returns null when ts is non-finite (NaN/Infinity/non-number)", () => {
    expect(loadStructured(structured({ ts: Number.NaN }))).toBeNull();
    expect(loadStructured(structured({ ts: Infinity }))).toBeNull();
    expect(loadStructured(structured({ ts: "1700000000" }))).toBeNull();
  });

  it("does NOT recompute dps even if the stored value disagrees with the inputs", () => {
    // A stored dps of 1 with 4.5M damage / 90s would be ~50k if recomputed; we keep the stored 1.
    const r = loadStructured(structured({ dps: 1 }))!;
    expect(r.dps).toBe(1);
  });
});

describe("loadStructured — quality coercion", () => {
  it.each(["counted", "skipped", "partial", "degraded"])("accepts quality %s", (q) => {
    expect(loadStructured(structured({ quality: q }))!.quality).toBe(q);
  });

  it("drops an unknown quality string (leaves quality undefined)", () => {
    expect(loadStructured(structured({ quality: "weird" }))!.quality).toBeUndefined();
  });

  it("leaves quality undefined when absent (a legacy-mirror log, pre-converter)", () => {
    const raw = structured();
    delete raw.quality;
    expect(loadStructured(raw)!.quality).toBeUndefined();
  });
});

describe("loadStructured — defensive (old/corrupt fields never crash)", () => {
  it("loads a legacy-mirror log lacking every converter-only field", () => {
    // The pre-PR3 archive wrote a bare normalizeRecord dump: no quality/issues/structuredSchemaVersion.
    const mirror = {
      id: "old:1",
      ts: 1,
      sessionId: "old",
      run: 1,
      status: "success",
      stage: "1-1",
      stageKey: 1001,
      mode: "Normal",
      goldGained: 0,
      schemaVersion: 11,
    };
    const r = loadStructured(mirror)!;
    expect(r.id).toBe("old:1");
    expect(r.quality).toBeUndefined();
    expect(r.issues).toBeUndefined();
    expect(r.structuredSchemaVersion).toBeUndefined();
    // missing numerics coerce to 0 / null defaults, never NaN
    expect(r.totalDamage).toBe(0);
    expect(r.dps).toBe(0);
    expect(r.act).toBeNull();
  });

  it("coerces a wrong-typed status to abandoned", () => {
    expect(loadStructured(structured({ status: 42 }))!.status).toBe("abandoned");
  });

  it("ignores non-string issue values, keeps the string ones", () => {
    const r = loadStructured(structured({ issues: { gold_gained: "err", bad: 5 } }))!;
    expect(r.issues).toEqual({ gold_gained: "err" });
  });

  it("drops the issues object entirely when it has no string entries", () => {
    expect(loadStructured(structured({ issues: { bad: 5 } }))!.issues).toBeUndefined();
  });

  it("loads camelCase drops from the structured shape", () => {
    const r = loadStructured(
      structured({ drops: [{ boxKey: 920011, monsterType: 1 }, { boxKey: 910011, monsterType: 0 }] }),
    )!;
    expect(r.drops).toEqual([
      { boxKey: 920011, monsterType: 1 },
      { boxKey: 910011, monsterType: 0 },
    ]);
  });

  it("filters malformed drop entries (and drops the field when none survive)", () => {
    expect(loadStructured(structured({ drops: [{ boxKey: "x", monsterType: 1 }] }))!.drops).toBeUndefined();
  });

  it("keeps deaths/revives = 0 (0 is meaningful: tracked, none happened)", () => {
    const r = loadStructured(structured({ deaths: 0, revives: 0 }))!;
    expect(r.deaths).toBe(0);
    expect(r.revives).toBe(0);
  });

  it("leaves deaths/revives undefined when absent", () => {
    const r = loadStructured(structured())!;
    expect(r.deaths).toBeUndefined();
    expect(r.revives).toBeUndefined();
  });

  it("normalizes heroes via the shared coercion", () => {
    const r = loadStructured(
      structured({ heroes: [{ heroKey: 201, class: "Ranger", level: 45, skills: [{ key: 10101, lv: 3 }], stats: { AttackDamage: 999 } }] }),
    )!;
    expect(r.heroes).toHaveLength(1);
    expect(r.heroes[0].heroKey).toBe(201);
    expect(r.heroes[0].skills).toEqual([{ key: 10101, lv: 3 }]);
  });

  it("preserves the CONVERTED (camelCase) per-hero xp/killedBy through the read path", () => {
    // Regression: normalizeHero is the shared coercion for BOTH the legacy runs.jsonl migration AND
    // the structured-logs READ path. convert.ts writes per-hero xp fields CAMELCASE
    // (xpGained/expStart/expEnd/killedBy) — the on-disk truth for every `logs/<id>.json`. The reader
    // path once read these ONLY in snake_case, so every converted run silently lost per-hero
    // xpGained/expStart/expEnd/killedBy on read back (the XP-by-hero panel rendered nothing on seeded
    // data). Asserting the camelCase shape survives intact locks the fix.
    const r = loadStructured(
      structured({
        heroes: [
          {
            heroKey: 201,
            class: "Ranger",
            level: 45,
            skills: [],
            stats: {},
            xpGained: 1_250_000,
            expStart: 8_000_000,
            expEnd: 9_250_000,
            levelup: true,
            deaths: 2,
            revives: 1,
            killedBy: [30102, 30103],
          },
        ],
      }),
    )!;
    expect(r.heroes).toHaveLength(1);
    const h = r.heroes[0];
    expect(h.xpGained).toBe(1_250_000);
    expect(h.expStart).toBe(8_000_000);
    expect(h.expEnd).toBe(9_250_000);
    expect(h.levelup).toBe(true);
    expect(h.deaths).toBe(2);
    expect(h.revives).toBe(1);
    expect(h.killedBy).toEqual([30102, 30103]);
  });

  it("still reads the LEGACY (snake_case) per-hero xp/killed_by shape (migration path unchanged)", () => {
    // The legacy runs.jsonl hero shape (consumed by normalizeRecord during migration) carries these
    // snake_case; the fix keeps them as fallbacks AFTER the camelCase reads, so migration is intact.
    const r = loadStructured(
      structured({
        heroes: [
          {
            heroKey: 201,
            class: "Ranger",
            level: 45,
            skills: [],
            stats: {},
            xp_gained: 777_000,
            exp_start: 4_000_000,
            exp_end: 4_777_000,
            killed_by: [40201],
          },
        ],
      }),
    )!;
    const h = r.heroes[0];
    expect(h.xpGained).toBe(777_000);
    expect(h.expStart).toBe(4_000_000);
    expect(h.expEnd).toBe(4_777_000);
    expect(h.killedBy).toEqual([40201]);
  });

  it("prefers the camelCase value when BOTH shapes are present (camelCase = current on-disk truth)", () => {
    // A defensive belt: if a record somehow carried both, the converted camelCase wins (it is what
    // every shipped converter writes; snake_case is only the legacy fallback).
    const r = loadStructured(
      structured({
        heroes: [
          {
            heroKey: 201,
            class: "Ranger",
            level: 45,
            skills: [],
            stats: {},
            xpGained: 1_000,
            xp_gained: 9_999,
            expStart: 10,
            exp_start: 99,
            expEnd: 20,
            exp_end: 88,
            killedBy: [1],
            killed_by: [9],
          },
        ],
      }),
    )!;
    const h = r.heroes[0];
    expect(h.xpGained).toBe(1_000);
    expect(h.expStart).toBe(10);
    expect(h.expEnd).toBe(20);
    expect(h.killedBy).toEqual([1]);
  });
});

// ---------------------------------------------------------------------------
// dedupeSessionScoped — collapse the two-reader phantom, never a real farm
// ---------------------------------------------------------------------------

describe("dedupeSessionScoped", () => {
  function rec(overrides: Partial<RunRecord> = {}): RunRecord {
    return {
      id: "s:1",
      ts: 1_000,
      sessionId: "s",
      schemaVersion: 1,
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
      quality: "counted",
      heroes: [],
      ...overrides,
    };
  }

  it("passes through a single run", () => {
    expect(dedupeSessionScoped([rec()])).toHaveLength(1);
  });

  it("collapses identical content across DIFFERENT sessions (the two-reader phantom)", () => {
    const a = rec({ id: "sA:1", sessionId: "sA" });
    const b = rec({ id: "sB:1", sessionId: "sB" }); // same content, different session
    const out = dedupeSessionScoped([a, b]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("sA:1"); // keeps the first (newest-first input)
  });

  it("NEVER collapses two distinct farm runs in the SAME session (zero false-hide)", () => {
    // Same session, same content signature (a farm re-running the exact same stage with the same
    // damage/gold). Different run numbers/ids. Both MUST survive — this is the whole point.
    const r1 = rec({ id: "s:2", run: 2 });
    const r2 = rec({ id: "s:1", run: 1 });
    expect(dedupeSessionScoped([r1, r2])).toHaveLength(2);
  });

  it("does NOT collapse same-session content-identical runs (that is id-dedup's job, not content's)", () => {
    // Two SAME-session records that look identical by content are KEPT here — the session-scoped net
    // only ever touches CROSS-session phantoms. A genuine same-run re-finalization (same `id`) is
    // collapsed earlier by id-dedup in RunsSource.reload (see runs-source-logs integration test),
    // not by this content rule — so this function must never hide a same-session run.
    const r1 = rec({ id: "s:2", run: 2, ts: 2_000 });
    const r2 = rec({ id: "s:1", run: 1, ts: 1_000 });
    expect(dedupeSessionScoped([r1, r2])).toHaveLength(2);
  });

  it("keeps distinct content across different sessions", () => {
    const a = rec({ id: "sA:1", sessionId: "sA", totalDamage: 100_000 });
    const b = rec({ id: "sB:1", sessionId: "sB", totalDamage: 200_000 });
    expect(dedupeSessionScoped([a, b])).toHaveLength(2);
  });

  it("uses RAW stable fields for the signature — derived dps/ts drift does NOT prevent a collapse", () => {
    // Two readers writing the same run differ in derived dps + ts but share the raw fields.
    const a = rec({ id: "sA:1", sessionId: "sA", dps: 10_000, ts: 2_000 });
    const b = rec({ id: "sB:1", sessionId: "sB", dps: 9_998, ts: 1_950 });
    expect(dedupeSessionScoped([a, b])).toHaveLength(1);
  });

  it("a third session with the same content also collapses (keeps only the first)", () => {
    const a = rec({ id: "sA:1", sessionId: "sA", ts: 3_000 });
    const b = rec({ id: "sB:1", sessionId: "sB", ts: 2_000 });
    const c = rec({ id: "sC:1", sessionId: "sC", ts: 1_000 });
    const out = dedupeSessionScoped([a, b, c]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("sA:1");
  });

  it("collapses cross-session phantom but keeps the same-session farm alongside it", () => {
    // sA has TWO identical farm runs (both kept); sB is a phantom copy of sA's run (dropped).
    const farm1 = rec({ id: "sA:1", sessionId: "sA", run: 1, ts: 3_000 });
    const farm2 = rec({ id: "sA:2", sessionId: "sA", run: 2, ts: 2_500 });
    const phantom = rec({ id: "sB:1", sessionId: "sB", run: 1, ts: 2_000 });
    const out = dedupeSessionScoped([farm1, farm2, phantom]);
    // both sA farm runs survive; the sB phantom (identical content, different session) is dropped
    expect(out.map((r) => r.id).sort()).toEqual(["sA:1", "sA:2"]);
  });
});

// ---------------------------------------------------------------------------
// dedupeById — collapse logs sharing a run id (a re-finalization), keep the first
// ---------------------------------------------------------------------------

describe("dedupeById", () => {
  function rec(id: string, extra: Partial<RunRecord> = {}): RunRecord {
    return loadStructured({ id, ts: 1, sessionId: "s", run: 1, status: "success", ...extra }) as RunRecord;
  }

  it("keeps a single record untouched", () => {
    expect(dedupeById([rec("s:1")])).toHaveLength(1);
  });

  it("collapses two records with the same id to the FIRST (newest-first input)", () => {
    const out = dedupeById([rec("s:1", { dps: 111 }), rec("s:1", { dps: 222 })]);
    expect(out).toHaveLength(1);
    expect(out[0].dps).toBe(111);
  });

  it("keeps records with distinct ids", () => {
    expect(dedupeById([rec("s:1"), rec("s:2"), rec("s:3")])).toHaveLength(3);
  });
});
