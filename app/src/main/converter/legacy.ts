// convertLegacy(record) -> structured RunRecord. The MIGRATION branch of the converter: it adopts a
// pre-redesign `runs.jsonl` line (schema_version <= 11, mixed PT/EN eras) into the same `logs/<id>.json`
// the new pipeline reads, so a player's existing run history does NOT restart under the redesign
// (progress.md "Migração & continuidade"). Same mechanics as convert(), different input shape.
//
// TWO invariants this branch exists to hold:
//  1. PRESERVE the external_id. A legacy record already has its `session_id:run` identity (and was
//     possibly already uploaded under it). We carry that id VERBATIM — never re-mint — or the app
//     would re-upload the migrated run as a NEW row and duplicate it on the leaderboard.
//  2. The bugged records stay, marked honest. The 1.00.10 window wrote runs with `gold: 0` + mode
//     "?" — values that never existed and can't be recovered. We don't delete them (the user would
//     think the meter ate their runs) and we don't pretend they're good — we seal them `degraded`
//     with an issue, so they show, filtered, with a reason.
//
// It reuses the battle-tested `normalizeRecord` (runs-source.ts) for all the era field-mapping (PT
// vs EN status, v5/v6/v7/v8 hero shapes, drops/deaths added per era) rather than re-deriving it —
// then layers ONLY the converter's additions on top: the quality verdict + issues + the structured
// schema stamp. `normalizeRecord` already builds the `session_id:run` id, so the external_id is
// preserved for free.

import type { RunRecord } from "../../shared/run-types.js";
import { normalizeRecord } from "../sources/runs-source.js";
import { classifyQuality, computeDps, computeRate, round } from "./helpers.js";
import { STRUCTURED_SCHEMA_VERSION } from "./convert.js";

/** The bugged-record signature from the 1.00.10 descalibration window: a run whose gold read came
 *  back 0 AND whose stage never resolved (mode "?"). Both at once is the fingerprint of the broken
 *  capture (a legitimately 0-gold run still resolves its stage). Sealed `degraded` with a reason.
 *  Also degrade when the stageKey itself is missing — the run can't be ranked. */
function legacyDegradeIssues(r: RunRecord): Record<string, string> {
  const issues: Record<string, string> = {};
  if (r.goldGained === 0 && r.mode === "?") {
    issues.gold_gained = "legacy: gold read 0 + stage unresolved (1.00.10 miscalibration)";
    issues.stageKey = "legacy: stage unresolved (mode '?')";
  }
  if (r.stageKey == null && !("stageKey" in issues)) {
    issues.stageKey = "legacy: stageKey missing";
  }
  return issues;
}

/** Convert ONE legacy `runs.jsonl` record (any era, schema <= 11) into a structured RunRecord,
 *  preserving its external_id. `lineIndex` is only an id fallback (passed to normalizeRecord) for a
 *  malformed line missing run/session_id — exactly as the legacy reader path did. Returns the sealed
 *  record; never throws on a normal record (normalizeRecord is defensive). */
export function convertLegacy(raw: Record<string, unknown>, lineIndex: number): RunRecord {
  // 1. Reuse the proven era normalization — yields a RunRecord with the external_id already built
  //    as `session_id:run` (or the idx:N fallback), every field coerced defensively.
  const base = normalizeRecord(raw, lineIndex);

  // 2. Re-derive the rates/dps from the normalized raw fields with the SAME helpers the new path
  //    uses — a legacy record's stored dps/per-sec were computed by an OLDER reader formula; deriving
  //    here keeps every migrated run consistent with new ones (one formula, helpers.ts).
  const dps = round(computeDps(base.totalDamage, base.clearTime, base.duration));
  const goldPerSec = round(computeRate(base.goldGained, base.clearTime, base.duration));
  const xpPerSec = round(computeRate(base.xpGained, base.clearTime, base.duration));

  // 3. Seal the verdict. `degraded` comes from the legacy bug signature (no envelope to inspect —
  //    legacy records are bare numbers, so 0+"?" is the only signal that a read failed).
  const issues = legacyDegradeIssues(base);
  const { quality, partial } = classifyQuality({
    status: base.status,
    stageNo: base.stageNo,
    clearTime: base.clearTime,
    duration: base.duration,
    totalDamage: base.totalDamage,
    degraded: Object.keys(issues).length > 0,
  });

  return {
    ...base,
    dps,
    goldPerSec,
    xpPerSec,
    partial,
    quality,
    issues,
    // schemaVersion stays the legacy raw schema (provenance, set by normalizeRecord); structured
    // schema is the converter's own output version (so a re-convert is detectable).
    structuredSchemaVersion: STRUCTURED_SCHEMA_VERSION,
  };
}
