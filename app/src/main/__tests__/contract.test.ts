// PR1 contract test — pins the reader↔converter shapes (raw-types.ts / run-types.ts) via the
// canonical fixtures. The TYPE conformance is enforced by `tsc --noEmit`; these runtime checks
// guard the behavioural invariants the converter (PR3) will rely on.
import { describe, expect, it } from "vitest";
import { RAW_V1_EXAMPLE } from "../../shared/__fixtures__/raw-v1.js";
import { RAW_V2_EXAMPLE } from "../../shared/__fixtures__/raw-v2.js";
import { STRUCTURED_V1_EXAMPLE } from "../../shared/__fixtures__/structured-v1.js";
import type { Field } from "../../shared/raw-types.js";

describe("RAW v1 contract", () => {
  it("stamps raw_schema_version = 1", () => {
    expect(RAW_V1_EXAMPLE.raw_schema_version).toBe(1);
  });

  it("wraps observed data fields in the Field envelope (ok carries the value)", () => {
    expect(RAW_V1_EXAMPLE.gold_gained).toEqual({ ok: true, value: 125000 });
    expect(RAW_V1_EXAMPLE.heroes.ok).toBe(true);
  });

  it("keeps structural metadata plain (no envelope) — it defines the record's identity", () => {
    expect(typeof RAW_V1_EXAMPLE.ts).toBe("number");
    expect(typeof RAW_V1_EXAMPLE.duration).toBe("number");
    // The reader owns session identity and emits it as a plain string (not a fact object).
    expect(typeof RAW_V1_EXAMPLE.session_id).toBe("string");
    expect(RAW_V1_EXAMPLE.id).toBe(`${RAW_V1_EXAMPLE.session_id}:${RAW_V1_EXAMPLE.run}`);
  });

  it("distinguishes 'couldn't read' from a real zero (the 1.00.10 gold:0 fix)", () => {
    const unread: Field<number> = { ok: false, error: "gold klass unresolved" };
    const realZero: Field<number> = { ok: true, value: 0 };
    expect(unread.ok).toBe(false);
    expect(realZero).not.toEqual(unread);
  });
});

describe("RAW v2 contract (Redesign 2 — identity = end-ts in ms, no session)", () => {
  it("stamps raw_schema_version = 2", () => {
    expect(RAW_V2_EXAMPLE.raw_schema_version).toBe(2);
  });

  it("id = the run's end-ts (ms) as a string — no session, no counter", () => {
    expect(RAW_V2_EXAMPLE.id).toBe(String(RAW_V2_EXAMPLE.ts));
  });

  it("ts is in MILLISECONDS, not seconds (so two fast back-to-back runs never share it)", () => {
    // ms epoch is ~1e12+; a seconds epoch would be ~1e9. Pins the unit the id depends on.
    expect(RAW_V2_EXAMPLE.ts).toBeGreaterThan(1e12);
  });

  it("drops session_id and run — the run no longer borrows the session's identity", () => {
    const raw = RAW_V2_EXAMPLE as unknown as Record<string, unknown>;
    expect(raw.session_id).toBeUndefined();
    expect(raw.run).toBeUndefined();
  });

  it("keeps the same Field envelope on observed data (the gold:0 fix carries over)", () => {
    expect(RAW_V2_EXAMPLE.gold_gained).toEqual({ ok: true, value: 125000 });
    expect(RAW_V2_EXAMPLE.heroes.ok).toBe(true);
  });
});

describe("STRUCTURED v1 contract", () => {
  it("carries the converter verdict + schema provenance", () => {
    expect(STRUCTURED_V1_EXAMPLE.quality).toBe("counted");
    expect(STRUCTURED_V1_EXAMPLE.structuredSchemaVersion).toBe(1);
    expect(STRUCTURED_V1_EXAMPLE.schemaVersion).toBe(1); // the raw schema it was derived from
    expect(STRUCTURED_V1_EXAMPLE.issues).toEqual({});
  });

  it("derives dps from total_damage / clear_time", () => {
    const expected = STRUCTURED_V1_EXAMPLE.totalDamage / STRUCTURED_V1_EXAMPLE.clearTime;
    expect(STRUCTURED_V1_EXAMPLE.dps).toBeCloseTo(expected, 2);
  });

  it("carries the run id verbatim from its raw (external_id continuity)", () => {
    expect(STRUCTURED_V1_EXAMPLE.id).toBe(RAW_V1_EXAMPLE.id);
  });

  it("the run id is sessionId:run (the external_id shape the leaderboard dedups on)", () => {
    expect(STRUCTURED_V1_EXAMPLE.id).toBe(
      `${STRUCTURED_V1_EXAMPLE.sessionId}:${STRUCTURED_V1_EXAMPLE.run}`,
    );
  });
});
