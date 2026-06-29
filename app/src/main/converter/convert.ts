// convert(raw) -> structured RunRecord. The PURE heart of the redesign: the reader emits raw
// observation (one `raw/<id>.json` per run, every field a Result envelope); the converter unwraps
// it ONCE into the clean `RunRecord` the app reads from `logs/`. No I/O, no memory reads, no catalog
// lookups — given the same raw it always yields the same structured record (the golden test relies
// on this). Dispatch is by `raw_schema_version` (never game_version): additive, so an old raw keeps
// converting to a stable output forever. This is the converter.
//
// What it DERIVES (from what the reader emits): dps, gold/sec, xp/sec, the stage label, the mode
// label, and the quality verdict (counted/skipped/partial/degraded). What it does NOT do: recompute
// gold/xp (those need the live memory read — reader's job; the converter only unwraps them) and
// resolve localized hero/item/skill names (id-based; the render layer resolves those). The reader's
// `session_id` is passed THROUGH verbatim — the reader owns session identity, the converter never
// re-mints it (identity & session — which corrected the original "converter mints" idea).

import type { Field, AnyRawRun, RawHero, RawDrop, MetricSource } from "../../shared/raw-types.js";
import type {
  RunRecord,
  RunHero,
  RunItem,
  RunMod,
  RunSkill,
  RunStatus,
  RunDrop,
} from "../../shared/run-types.js";
import { classifyQuality, computeDps, computeRate, modeName, resolveStage, round } from "./helpers.js";
import { asStatus } from "../sources/runs-source.js";

/** Coerce a raw metric-source tag to the MetricSource union, defaulting an off-union value to "".
 *  `raw` is an untrusted JSON cast (ingest.readRaw), so a corrupt/hand-edited source must not
 *  flow into the structured log verbatim — mirrors the read-path coercion in runs-source.ts. */
function asMetricSource(v: unknown): MetricSource | "" {
  return v === "live" || v === "save" ? v : "";
}

/** Finite number or null. The SAME strictness runs-source.ts's normalizeMod/normalizeItem use, so a
 *  malformed hero/item value can't produce a DIFFERENT record on the new-raw path vs the legacy
 *  migration path (a wrong-typed non-null was previously passed through by `?? null`). */
function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** The converter's own output schema version. Regenerable: bump this to force a re-convert of
 *  every `logs/<id>.json` (the ingestor re-runs convert when a log's version is older). Distinct
 *  from the raw/reader schema version (provenance, carried as `schemaVersion`). */
export const STRUCTURED_SCHEMA_VERSION = 1;

/** Unwrap a Field: on `ok` return its value; on error return `fallback` AND record the reason under
 *  `issues[name]`. This is the whole point of the envelope — a failed read becomes a tracked issue,
 *  never a silent 0/"?" that looks like a real value (the 1.00.10 gold:0 bug). */
function unwrap<T>(field: Field<T>, fallback: T, name: string, issues: Record<string, string>): T {
  if (field && field.ok) return field.value;
  issues[name] = field && !field.ok ? field.error : "missing";
  return fallback;
}

/** True when a CRITICAL data field could not be read — the run's core numbers are untrustworthy, so
 *  the converter seals it `degraded` (honest + filterable; the value never existed, can't be
 *  recovered). The 1.00.10 bug is exactly this: `gold_gained` err. We also treat an unreadable
 *  `stageKey` or `total_damage` as degrading — without them the run can't be ranked or shown
 *  meaningfully. `heroes` err means the live party was unresolved (StageManager off): who played is
 *  unknown, so the run must NOT reach the leaderboard — it still shows locally, marked (the reader
 *  emits heroes:err instead of dumping the save roster; see party-live-resolution).
 *  (Stage sub-fields like act/stageNo failing show as "?", not degraded — cosmetic.) */
const CRITICAL_FIELDS = ["gold_gained", "stageKey", "total_damage", "heroes"] as const;

function isDegraded(issues: Record<string, string>): boolean {
  return CRITICAL_FIELDS.some((f) => f in issues);
}

function mapDrops(drops: RawDrop[]): RunDrop[] {
  return drops
    .map((d): RunDrop | null => {
      if (!d || typeof d.box_key !== "number" || typeof d.monster_type !== "number") return null;
      return { boxKey: d.box_key, monsterType: d.monster_type };
    })
    .filter((d): d is RunDrop => d !== null);
}

function mapHero(raw: RawHero): RunHero {
  const items: RunItem[] = (Array.isArray(raw.items) ? raw.items : []).map((it) => {
    const mods: RunMod[] = (Array.isArray(it?.mods) ? it.mods : []).map(
      (m): RunMod => ({
        recipeId: numOrNull(m?.recipeId),
        recipe: typeof m?.recipe === "string" ? m.recipe : "",
        statId: numOrNull(m?.statId),
        stat: typeof m?.stat === "string" ? m.stat : "",
        value: numOrNull(m?.value),
        tier: numOrNull(m?.tier),
      }),
    );
    return {
      slot: typeof it?.slot === "string" ? it.slot : "",
      slotId: numOrNull(it?.slotId),
      grade: typeof it?.grade === "string" ? it.grade : "",
      gradeId: numOrNull(it?.gradeId),
      itemKey: numOrNull(it?.itemKey),
      // uniqueId is a u64 the reader emits as a lossless string — keep it opaque.
      uniqueId: it?.uniqueId == null ? "" : String(it.uniqueId),
      level: numOrNull(it?.level),
      mods,
    };
  });
  const skills: RunSkill[] = (Array.isArray(raw.skills) ? raw.skills : [])
    .map((s): RunSkill | null =>
      s && typeof s.key === "number" ? { key: s.key, lv: typeof s.lv === "number" ? s.lv : null } : null,
    )
    .filter((s): s is RunSkill => s !== null);

  const stats: Record<string, number> = {};
  if (raw.stats && typeof raw.stats === "object") {
    for (const [k, v] of Object.entries(raw.stats)) {
      if (typeof v === "number" && Number.isFinite(v)) stats[k] = v;
    }
  }

  const hero: RunHero = {
    heroKey: raw.heroKey,
    class: typeof raw.class === "string" ? raw.class : "",
    classId: numOrNull(raw.classId),
    level: typeof raw.level === "number" ? raw.level : 0,
    exp: typeof raw.exp === "number" ? raw.exp : 0,
    items,
    skills,
    stats,
  };
  // Optional fields appended AFTER the base literal, BEFORE return (app-normalization invariant):
  // present = tracked (even 0), absent = not emitted for this hero.
  if (raw.skillLevels && typeof raw.skillLevels === "object") {
    const sl: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw.skillLevels)) {
      if (typeof v === "number" && Number.isFinite(v) && v > 0) sl[k] = v;
    }
    if (Object.keys(sl).length > 0) hero.skillLevels = sl;
  }
  // slot: 0-based party slot the reader emits only when known (absent/null = unknown). Carry the
  // number through verbatim (incl. 0); never default it — an unknown slot stays absent downstream.
  if (typeof raw.slot === "number") hero.slot = raw.slot;
  if (typeof raw.exp_start === "number") hero.expStart = raw.exp_start;
  if (typeof raw.exp_end === "number") hero.expEnd = raw.exp_end;
  if (typeof raw.xp_gained === "number") hero.xpGained = raw.xp_gained;
  // levelup: preserve any boolean (false is meaningful — "did not level"; mirrors legacy normalizeHero).
  if (typeof raw.levelup === "boolean") hero.levelup = raw.levelup;
  if (typeof raw.deaths === "number") hero.deaths = raw.deaths;
  if (typeof raw.revives === "number") hero.revives = raw.revives;
  if (Array.isArray(raw.killed_by)) {
    const kb = raw.killed_by.filter((k): k is number => typeof k === "number" && Number.isFinite(k));
    if (kb.length > 0) hero.killedBy = kb;
  }
  return hero;
}

/** Convert ONE raw run record into the structured RunRecord. Pure. Dispatches by
 *  `raw_schema_version`: v1 (legacy: id = session_id:run) and v2 (Redesign 2: id = the run's end-ts
 *  in ms, NO session_id/run). The observed DATA fields are identical (RawObserved); only the
 *  structural header differs, narrowed by the version discriminant below. */
export function convert(raw: AnyRawRun): RunRecord {
  // Dispatch by raw schema version. v1 + v2 are supported; an unknown version is converted
  // best-effort but flagged so the issue surfaces rather than silently mis-parsing.
  const issues: Record<string, string> = {};
  // Read the discriminant as a plain number first: the union narrows to `never` inside the
  // "neither 1 nor 2" branch (so `raw.raw_schema_version` is unreachable there per the types),
  // but a hand-edited/corrupt raw CAN carry an out-of-union version at runtime — flag it.
  const rawVersion: number = raw.raw_schema_version;
  if (rawVersion !== 1 && rawVersion !== 2) {
    issues.raw_schema_version = `unsupported raw_schema_version ${rawVersion}`;
  }

  const stageKey = unwrap(raw.stageKey, null, "stageKey", issues);
  const act = unwrap(raw.act, null, "act", issues);
  const stageNo = unwrap(raw.stageNo, null, "stageNo", issues);
  const difficulty = unwrap(raw.difficulty, null, "difficulty", issues);
  const totalMobs = unwrap(raw.total_mobs, null, "total_mobs", issues);
  const mobs = unwrap(raw.mobs, 0, "mobs", issues);
  const totalDamage = unwrap(raw.total_damage, 0, "total_damage", issues);
  const clearTime = unwrap(raw.clear_time, 0, "clear_time", issues);
  const goldGained = unwrap(raw.gold_gained, 0, "gold_gained", issues);
  const xpGained = unwrap(raw.xp_gained, 0, "xp_gained", issues);
  const drops = mapDrops(unwrap(raw.drops, [], "drops", issues));
  const heroes = unwrap(raw.heroes, [], "heroes", issues).map(mapHero);

  // Coerce status at the convert boundary (raw is an untrusted JSON cast), mirroring the read path
  // (loadStructured.asStatus). An off-union/garbage run_outcome (a hand-edited/corrupt raw) is
  // repaired to "abandoned" AND recorded as an issue, so a real success is never silently sealed
  // `skipped` by an invalid status — the same "don't trust raw input silently" the envelope exists for.
  const status: RunStatus = asStatus(raw.run_outcome);
  if (raw.run_outcome !== status) issues.run_outcome = `invalid run_outcome "${raw.run_outcome}"`;
  const duration = typeof raw.duration === "number" ? raw.duration : 0;

  const dps = round(computeDps(totalDamage, clearTime, duration));
  const goldPerSec = round(computeRate(goldGained, clearTime, duration));
  const xpPerSec = round(computeRate(xpGained, clearTime, duration));

  // Seal the verdict by the shared rule (helpers.classifyQuality): degraded (a critical read failed)
  // > partial (under-counted capture) > skipped (below the floor / not a clean success) > counted.
  // Never deletes a run — every verdict yields a record the user sees, marked + filterable
  // (skip != vanish). `degraded` here = an envelope error on a critical data field.
  const { quality, partial } = classifyQuality({
    status,
    stageNo,
    clearTime,
    duration,
    totalDamage,
    degraded: isDegraded(issues),
  });

  const record: RunRecord = {
    id: raw.id,
    ts: raw.ts,
    // v1: reader-owned session id, passed through (external_id = id continuity). v2: the reader no
    // longer emits a session — it's DERIVED by the app from run timestamps — so this is "" and the
    // app attaches the derived sessionId at read/index time (PR4). Never re-minted in the converter.
    sessionId: raw.raw_schema_version === 1 ? raw.session_id : "",
    schemaVersion: raw.raw_schema_version, // provenance: the raw/reader schema this came from
    structuredSchemaVersion: STRUCTURED_SCHEMA_VERSION,
    gameVersion: typeof raw.game_version === "string" ? raw.game_version : "",
    // v1: per-session counter (kept). v2: no counter — the app derives the display run# from the
    // run's position in its derived session; 0 is a placeholder until that derivation (PR4).
    run: raw.raw_schema_version === 1 ? raw.run : 0,
    status,
    quality,
    stage: resolveStage(act, stageNo),
    act,
    stageNo,
    stageKey,
    mode: modeName(difficulty),
    mobs,
    totalMobs,
    totalDamage,
    dps,
    clearTime,
    duration,
    goldGained,
    // Source tags are coerced to the MetricSource union (off-union -> "") so a corrupt raw can't
    // persist a garbage source string into the structured log.
    goldSource: asMetricSource(raw.gold_source),
    xpGained,
    xpSource: asMetricSource(raw.xp_source),
    xpPerSec,
    goldPerSec,
    partial,
    issues,
    heroes,
  };
  if (drops.length > 0) record.drops = drops;
  // Run-level deaths/revives = sum of the per-hero counts the reader emits (sparse: absent = 0).
  // raw v1 always tracks survival, so the totals are always meaningful — emit them (even 0, which
  // the detail view shows as "0 deaths") rather than leaving the field undefined.
  if (heroes.length > 0) {
    record.deaths = heroes.reduce((n, h) => n + (h.deaths ?? 0), 0);
    record.revives = heroes.reduce((n, h) => n + (h.revives ?? 0), 0);
  }
  return record;
}
