import { EventEmitter } from "node:events";
import { existsSync, readFileSync, readdirSync, rmSync, statSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import type {
  RunRecord,
  RunHero,
  RunItem,
  RunMod,
  RunSkill,
  RunStatus,
  RunQuality,
  RunDrop,
} from "../../shared/run-types.js";
import type { RunIndexEntry } from "../../shared/ipc-types.js";
import { STRUCTURED_SCHEMA_VERSION } from "../converter/convert.js";
import { deriveSessions } from "../sessions.js";
import { readSessionCuts } from "../session-stats.js";

const POLL_INTERVAL_MS = 1_000;
// Coalesce fs.watch bursts (an atomic tmp+rename write fires 2+ events; one finished run can fire
// several) into ONE trailing reload. Short enough to stay imperceptible next to the 1s poll.
const WATCH_DEBOUNCE_MS = 150;

// --------------------------------------------------------------------------- //
// Coercion helpers — tolerate missing / wrong-typed JSON fields, never throw.
// --------------------------------------------------------------------------- //

function firstNum(...vals: unknown[]): number {
  for (const v of vals) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return 0;
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

/** Like firstNum, but returns undefined (not 0) when no candidate is a finite number. */
function firstDefinedNum(...vals: unknown[]): number | undefined {
  for (const v of vals) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return undefined;
}

/** Normalize a run timestamp to MILLISECONDS. raw v2 emits `ts` in ms; legacy v1 logs (and the
 *  migrated runs.jsonl) carry `ts` in SECONDS — a seconds epoch is ~1.7e9, a ms epoch ~1.7e12, so
 *  anything positive below 1e11 is seconds and gets ×1000. Keeps newest-first sorting AND date
 *  display consistent across the mixed v1/v2 set, so the renderer can always treat `ts` as ms
 *  (without this a v2 ms ts run through `new Date(ts*1000)` would render ~year 55000). */
export function tsToMs(ts: number): number {
  return ts > 0 && ts < 1e11 ? ts * 1000 : ts;
}

/** Map PT (≤v5) and EN (v6) status strings into the internal RunStatus union. */
function normalizeStatus(raw: unknown): RunStatus {
  switch (raw) {
    case "sucesso":
    case "success":
      return "success";
    case "falha":
    case "fail":
      return "fail";
    case "abandonada":
    case "abandoned":
      return "abandoned";
    default:
      return "abandoned";
  }
}

// --------------------------------------------------------------------------- //
// Legacy normalizers — map every reader schema era (v6 / v5 / none) of the
// `runs.jsonl` wire shape into one RunRecord (EN). First non-undefined wins;
// times are already in SECONDS in every era.
//
// These are NO LONGER the app's READ path (since PR4 the app reads `logs/`, the
// pre-converted structured records — see RunsSource below). They survive ONLY as
// the MIGRATION engine: `converter/legacy.ts` reuses `normalizeRecord` to adopt a
// pre-redesign `runs.jsonl` line into `logs/` preserving its external_id (then
// layers the quality verdict on top). Kept here (not moved into the converter) so
// the migration reuses the battle-tested era field-mapping verbatim.
// --------------------------------------------------------------------------- //

function normalizeMod(raw: Record<string, unknown>): RunMod {
  return {
    recipeId: numOrNull(raw.recipeId),
    recipe: str(raw.recipe),
    statId: numOrNull(raw.statId),
    stat: str(raw.stat),
    value: numOrNull(raw.value),
    tier: numOrNull(raw.tier),
  };
}

function normalizeItem(raw: Record<string, unknown>): RunItem {
  const mods = Array.isArray(raw.mods)
    ? raw.mods.map((m) => normalizeMod((m ?? {}) as Record<string, unknown>))
    : [];
  // WARNING: uniqueId can exceed Number.MAX_SAFE_INTEGER (2^53) and JSON.parse
  // mangles it. Store it as an opaque String — never display or match on it.
  const rawId = raw.uniqueId;
  return {
    slot: str(raw.slot),
    slotId: numOrNull(raw.slotId),
    grade: str(raw.grade),
    gradeId: numOrNull(raw.gradeId),
    itemKey: numOrNull(raw.itemKey),
    uniqueId: rawId == null ? "" : String(rawId),
    level: numOrNull(raw.level),
    mods,
  };
}

function normalizeHero(raw: Record<string, unknown>): RunHero {
  const items = Array.isArray(raw.items)
    ? raw.items.map((i) => normalizeItem((i ?? {}) as Record<string, unknown>))
    : [];
  // v7: [{ key, lv }]; ≤v6: bare number[] (keys only, no level). Normalize both to RunSkill[].
  const skills: RunSkill[] = Array.isArray(raw.skills)
    ? raw.skills
        .map((s): RunSkill | null => {
          if (typeof s === "number") return { key: s, lv: null };
          if (s && typeof s === "object") {
            const { key, lv } = s as Record<string, unknown>;
            if (typeof key === "number") return { key, lv: typeof lv === "number" ? lv : null };
          }
          return null;
        })
        .filter((s): s is RunSkill => s !== null)
    : [];
  const stats: Record<string, number> = {};
  if (raw.stats && typeof raw.stats === "object") {
    for (const [k, v] of Object.entries(raw.stats as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v)) stats[k] = v;
    }
  }
  // v8: full invested skill tree, { [attributeKey]: level } (actives + passives).
  const skillLevels: Record<string, number> = {};
  if (raw.skillLevels && typeof raw.skillLevels === "object") {
    for (const [k, v] of Object.entries(raw.skillLevels as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v) && v > 0) skillLevels[k] = v;
    }
  }

  // xp fields. normalizeHero serves TWO callers with DIFFERENT casing:
  //   • the structured-logs READ path (loadStructured) — convert.ts writes these CAMELCASE
  //     (expStart/expEnd/xpGained), the current on-disk truth → must come FIRST, else every
  //     converted run silently loses per-hero xp on read.
  //   • the legacy runs.jsonl MIGRATION (normalizeRecord) — snake_case eras: v6 exp_start/exp_end/
  //     xp_gained, v5 exp_live_start/exp_live_end/xp_gain_live → kept as fallbacks.
  const expStart = firstDefinedNum(raw.expStart, raw.exp_start, raw.exp_live_start);
  const expEnd = firstDefinedNum(raw.expEnd, raw.exp_end, raw.exp_live_end);
  const heroXp = firstDefinedNum(raw.xpGained, raw.xp_gained, raw.xp_gain_live);

  const hero: RunHero = {
    heroKey: firstNum(raw.heroKey),
    class: str(raw.class),
    classId: numOrNull(raw.classId),
    level: firstNum(raw.level),
    exp: firstNum(raw.exp),
    items,
    skills,
    stats,
  };
  if (Object.keys(skillLevels).length > 0) hero.skillLevels = skillLevels;
  if (expStart !== undefined) hero.expStart = expStart;
  if (expEnd !== undefined) hero.expEnd = expEnd;
  if (typeof raw.levelup === "boolean") hero.levelup = raw.levelup;
  if (heroXp !== undefined) hero.xpGained = heroXp;
  // v11: per-hero survival from HeroDie/Resurrection logs. Sparse — the reader emits these only
  // when nonzero, so absent = 0/none (leave undefined). The monsterKeys that killed this hero are
  // `killedBy` in the converted logs (convert.ts) / `killed_by` in the legacy runs.jsonl shape.
  // (deaths/revives share the same name in both shapes — no casing fork needed.)
  const heroDeaths = firstDefinedNum(raw.deaths);
  if (heroDeaths !== undefined) hero.deaths = heroDeaths;
  const heroRevives = firstDefinedNum(raw.revives);
  if (heroRevives !== undefined) hero.revives = heroRevives;
  const rawKilledBy = Array.isArray(raw.killedBy)
    ? raw.killedBy
    : Array.isArray(raw.killed_by)
      ? raw.killed_by
      : null;
  if (rawKilledBy) {
    const killedBy = rawKilledBy.filter(
      (k): k is number => typeof k === "number" && Number.isFinite(k),
    );
    if (killedBy.length > 0) hero.killedBy = killedBy;
  }
  return hero;
}

/**
 * Normalize one parsed legacy `runs.jsonl` object (any era) into a RunRecord.
 * `lineIndex` is used only as an id fallback when run/session_id are missing.
 *
 * Used by `converter/legacy.ts` (migration), NOT by the app's read path anymore.
 */
export function normalizeRecord(raw: Record<string, unknown>, lineIndex: number): RunRecord {
  const heroes = Array.isArray(raw.heroes)
    ? raw.heroes.map((h) => normalizeHero((h ?? {}) as Record<string, unknown>))
    : [];

  const sessionId = str(raw.session_id);
  const hasRun = typeof raw.run === "number" && Number.isFinite(raw.run);
  const run = hasRun ? (raw.run as number) : 0;
  const id = hasRun
    ? `${sessionId !== "" ? sessionId : "noSession"}:${run}`
    : `idx:${lineIndex}`;

  const record: RunRecord = {
    id,
    ts: firstNum(raw.ts),
    sessionId,
    schemaVersion: firstNum(raw.schema_version),
    gameVersion: str(raw.game_version),
    run,
    status: normalizeStatus(raw.status),
    stage: str(raw.stage, "?"),
    act: numOrNull(raw.act),
    stageNo: numOrNull(raw.stageNo),
    stageKey: numOrNull(raw.stageKey),
    mode: str(raw.mode, "?"),
    mobs: firstNum(raw.mobs),
    totalMobs: numOrNull(raw.total_mobs),
    // total_damage (v6) / dano_total (v5)
    totalDamage: firstNum(raw.total_damage, raw.dano_total),
    dps: firstNum(raw.dps),
    clearTime: firstNum(raw.clear_time),
    // duration (v6/v5) / medido (pre-v5)
    duration: firstNum(raw.duration, raw.medido),
    // gold_gained (v6) / gold_ganho (v5) / gold_delta (pre-v5)
    goldGained: firstNum(raw.gold_gained, raw.gold_ganho, raw.gold_delta),
    goldSource: str(raw.gold_source),
    // xp_gained (v6) / xp_delta_live (v5) / xp_delta (pre-v5)
    xpGained: firstNum(raw.xp_gained, raw.xp_delta_live, raw.xp_delta),
    xpSource: str(raw.xp_source),
    xpPerSec: firstNum(raw.xp_per_sec),
    goldPerSec: firstNum(raw.gold_per_sec),
    // partial: reader flags a run it joined mid-flight (under-counted). Absent in legacy records
    // (treated as false). The migration's quality verdict (classifyQuality in convertLegacy) and the
    // upload eligible() gate act on this flag — the read path no longer drops on it.
    partial: raw.partial === true,
    // wave_now / wave_total only present in old records
    waveNow: numOrNull(raw.wave_now),
    waveTotal: numOrNull(raw.wave_total),
    heroes,
  };

  // drops: present from schema_version 10 (GetBoxLog events, v10+). Absent in older records.
  if (Array.isArray(raw.drops) && raw.drops.length > 0) {
    const drops = raw.drops
      .map((d): RunDrop | null => {
        if (!d || typeof d !== "object" || Array.isArray(d)) return null;
        const { box_key, monster_type } = d as Record<string, unknown>;
        if (typeof box_key !== "number" || typeof monster_type !== "number") return null;
        return { boxKey: box_key, monsterType: monster_type };
      })
      .filter((d): d is RunDrop => d !== null);
    if (drops.length > 0) record.drops = drops;
  }

  // deaths/revives: run totals from HeroDie/Resurrection logs (schema_version 11+). The reader
  // always emits them (0+) on v11, so present = tracked (0 is meaningful), absent = pre-v11 run.
  const deaths = firstDefinedNum(raw.deaths);
  if (deaths !== undefined) record.deaths = deaths;
  const revives = firstDefinedNum(raw.revives);
  if (revives !== undefined) record.revives = revives;

  return record;
}

// --------------------------------------------------------------------------- //
// Structured loader — parse ONE `logs/<id>.json` (already converted by PR3) into
// a RunRecord. This is the app's READ path: the heavy lifting (era mapping,
// dps/rate derivation, the quality verdict) already happened ONCE in the
// converter, so here we only PARSE + coerce defensively (app-normalization
// invariant: never crash on a corrupt/old file, never fabricate a wrong default).
// NO re-derivation — the structured record is the source of truth.
// --------------------------------------------------------------------------- //

const QUALITIES: ReadonlySet<string> = new Set(["counted", "skipped", "partial", "degraded"]);

function asQuality(v: unknown): RunQuality | undefined {
  return typeof v === "string" && QUALITIES.has(v) ? (v as RunQuality) : undefined;
}

export function asStatus(v: unknown): RunStatus {
  return v === "success" || v === "fail" || v === "abandoned" ? v : "abandoned";
}

/**
 * Parse a structured `logs/<id>.json` object into a RunRecord. Defensive: an old log missing a
 * converter-only field (quality/issues) loads fine (the fields stay undefined); a malformed file
 * is rejected by the caller (returns via the `id` guard). Heroes/items/drops reuse the legacy
 * normalizers — the structured shape is the SAME RunRecord, so the same defensive coercion applies
 * (and a hand-edited or legacy-mirror log with a slightly different hero shape still loads).
 */
export function loadStructured(raw: Record<string, unknown>): RunRecord | null {
  // id is the one field every structured record MUST have (it is the run identity); without it the
  // file is not a run record — skip it rather than fabricate an id.
  if (typeof raw.id !== "string" || raw.id === "") return null;
  // ts drives the newest-first sort + the oldest-first upload cycle. A missing/non-finite ts would
  // default to 0 (firstNum) and silently mis-sort the run as epoch-0 — reject it like a missing id
  // (never fabricate a wrong default), so a corrupt log is skipped rather than mis-ordered.
  if (typeof raw.ts !== "number" || !Number.isFinite(raw.ts)) return null;

  const heroes = Array.isArray(raw.heroes)
    ? raw.heroes.map((h) => normalizeHero((h ?? {}) as Record<string, unknown>))
    : [];

  const record: RunRecord = {
    id: raw.id,
    // Normalize to ms: v2 logs carry ms, legacy v1 logs carry seconds — unify so sort + date
    // display are consistent across the mixed set (the renderer always treats ts as ms).
    ts: tsToMs(firstNum(raw.ts)),
    sessionId: str(raw.sessionId),
    schemaVersion: firstNum(raw.schemaVersion),
    gameVersion: str(raw.gameVersion),
    run: firstNum(raw.run),
    status: asStatus(raw.status),
    stage: str(raw.stage, "?"),
    act: numOrNull(raw.act),
    stageNo: numOrNull(raw.stageNo),
    stageKey: numOrNull(raw.stageKey),
    mode: str(raw.mode, "?"),
    mobs: firstNum(raw.mobs),
    totalMobs: numOrNull(raw.totalMobs),
    totalDamage: firstNum(raw.totalDamage),
    dps: firstNum(raw.dps),
    clearTime: firstNum(raw.clearTime),
    duration: firstNum(raw.duration),
    goldGained: firstNum(raw.goldGained),
    goldSource: str(raw.goldSource),
    xpGained: firstNum(raw.xpGained),
    xpSource: str(raw.xpSource),
    xpPerSec: firstNum(raw.xpPerSec),
    goldPerSec: firstNum(raw.goldPerSec),
    partial: raw.partial === true,
    waveNow: numOrNull(raw.waveNow),
    waveTotal: numOrNull(raw.waveTotal),
    heroes,
  };

  // Converter-only optionals (app-normalization: append AFTER the literal, BEFORE return; present =
  // populated by the converter, absent = a legacy-mirror log produced before PR3).
  const quality = asQuality(raw.quality);
  if (quality !== undefined) record.quality = quality;
  if (raw.issues && typeof raw.issues === "object" && !Array.isArray(raw.issues)) {
    const issues: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw.issues as Record<string, unknown>)) {
      if (typeof v === "string") issues[k] = v;
    }
    if (Object.keys(issues).length > 0) record.issues = issues;
  }
  const structuredSchemaVersion = firstDefinedNum(raw.structuredSchemaVersion);
  if (structuredSchemaVersion !== undefined) record.structuredSchemaVersion = structuredSchemaVersion;

  // drops: keep the structured camelCase shape (the converter already mapped snake_case -> camelCase).
  if (Array.isArray(raw.drops) && raw.drops.length > 0) {
    const drops = raw.drops
      .map((d): RunDrop | null => {
        if (!d || typeof d !== "object" || Array.isArray(d)) return null;
        const { boxKey, monsterType } = d as Record<string, unknown>;
        if (typeof boxKey !== "number" || typeof monsterType !== "number") return null;
        return { boxKey, monsterType };
      })
      .filter((d): d is RunDrop => d !== null);
    if (drops.length > 0) record.drops = drops;
  }

  const deaths = firstDefinedNum(raw.deaths);
  if (deaths !== undefined) record.deaths = deaths;
  const revives = firstDefinedNum(raw.revives);
  if (revives !== undefined) record.revives = revives;

  return record;
}

// Favorite lookup injected by main (favorites-store), so this module — which is also exercised by
// pure unit tests — never imports the Electron-bound settings/favorites code. Defaults to "nothing
// favorited" until main wires the real predicate in (setFavoritePredicate, called from ipc.ts).
let isFavoriteId: (id: string) => boolean = () => false;

/** Wire the favorite-id predicate (main only). Lets projectIndex stamp `favorite` on each entry
 *  without runs-source statically depending on the favorites store / settings (and thus Electron). */
export function setFavoritePredicate(fn: (id: string) => boolean): void {
  isFavoriteId = fn;
}

function projectIndex(r: RunRecord): RunIndexEntry {
  return {
    id: r.id,
    ts: r.ts,
    // Favorite flag (Feature 3): a main-owned sidecar, NOT a field on the immutable logs record.
    // Stamped here so the renderer can render the star + filter "favorites only" off the index.
    favorite: isFavoriteId(r.id),
    // The list gates the "new session" button on runs in the reader's CURRENT session.
    sessionId: r.sessionId,
    status: r.status,
    // The display filter (PR6) gates on the converter verdict + stageNo (x-10 exemption). Carry
    // both so the list filters without fetching full records. quality is omitted on a pre-converter
    // legacy-mirror log (RunRecord.quality undefined) → the filter treats it as visible.
    ...(r.quality !== undefined ? { quality: r.quality } : {}),
    stage: r.stage,
    stageNo: r.stageNo,
    mode: r.mode,
    dps: r.dps,
    totalDamage: r.totalDamage,
    goldGained: r.goldGained,
    xpGained: r.xpGained,
    xpPerSec: r.xpPerSec,
    goldPerSec: r.goldPerSec,
    mobs: r.mobs,
    totalMobs: r.totalMobs,
    duration: r.duration,
    clearTime: r.clearTime,
    schemaVersion: r.schemaVersion,
    party: r.heroes.slice(0, 3).map((h) => ({
      heroKey: h.heroKey,
      class: h.class,
      level: h.level,
      // Per-hero run XP — the Leveling Planner's measured-XP source (only emitted when present so the
      // index stays minimal; older records without per-hero gain simply omit it).
      ...(typeof h.xpGained === "number" ? { xpGained: h.xpGained } : {}),
    })),
    // Carry drops so the list's Drops column renders without fetching full records.
    ...(r.drops && r.drops.length > 0 ? { drops: r.drops } : {}),
  };
}

/** Content signature of a run: only RAW, STABLE fields — never the derived dps/duration or the
 *  write timestamp, which can drift between two finalizations of the same run. Two records with the
 *  same signature describe the SAME finished run. Used by dedupeSessionScoped (the cross-session
 *  phantom collapse). */
function contentSig(r: RunRecord): string {
  return [
    r.stage,
    r.mode,
    r.status,
    r.totalDamage,
    r.clearTime,
    r.goldGained,
    r.xpGained,
    r.mobs,
    r.totalMobs,
  ].join("|");
}

/**
 * Collapse the two-reader PHANTOM duplicate — content-identical runs written under DIFFERENT
 * `sessionId`s — while NEVER collapsing a real farm (two genuinely-distinct runs in the SAME
 * session that happen to look identical).
 *
 * The cause (dedup): AV kills the reader, the app respawns it; if the old process did
 * not die, BOTH readers write the same finished run — but each reader owns its own session, so the
 * two copies carry DIFFERENT session ids (and thus different `id`s). Collapsing only ACROSS sessions
 * catches exactly that phantom and nothing else: a farm's repeated runs all share ONE session id, so
 * they are never candidates here → zero false-hide of a real grind (the primary defence, the
 * single-writer guarantee, is PR7; this net is the safety layer).
 *
 * Algorithm: walk newest-first (input is pre-sorted); the FIRST session to carry a given content
 * signature owns it. Drop a later record only when its signature is owned by a DIFFERENT session.
 * A same-session repeat keeps owner === its own sessionId, so it never collapses (farm intact).
 * The design accepts the doubly-rare residue (a reader restart between two exact-identical runs)
 * over ever hiding a real run (the accepted residue).
 */
export function dedupeSessionScoped(records: RunRecord[]): RunRecord[] {
  // content signature -> the sessionId of the first (newest) record seen with that content.
  const sigOwner = new Map<string, string>();
  const out: RunRecord[] = [];
  for (const r of records) {
    const sig = contentSig(r);
    const owner = sigOwner.get(sig);
    if (owner !== undefined && owner !== r.sessionId) {
      // Identical content from a DIFFERENT session → the two-reader phantom. Drop it.
      continue;
    }
    // First sighting of this content -> its session owns the signature; a same-session repeat
    // keeps owner === r.sessionId, so it never hits the drop above (a real farm stays intact).
    if (owner === undefined) sigOwner.set(sig, r.sessionId);
    out.push(r);
  }
  return out;
}

/** Collapse records sharing a run `id` (the unique run identity) to the FIRST occurrence. Over a
 *  newest-first list this keeps the newest copy of a re-finalized run (the same run written to a
 *  second logs file under a different ts -> a different filename, same id). Always safe: a shared id
 *  is by definition the same run. Distinct from dedupeSessionScoped (which collapses by CONTENT
 *  across sessions); both run on read so the list never shows a run twice. */
export function dedupeById(records: RunRecord[]): RunRecord[] {
  const seen = new Set<string>();
  const out: RunRecord[] = [];
  for (const r of records) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out;
}

// --------------------------------------------------------------------------- //
// RunsSource — watch <outputDir>/logs/, keep RunRecord[] newest-first.
//
// Since PR4 the app READS the converted structured records (one `logs/<id>.json`
// per run, produced ONCE by the converter/Ingestor, PR3) instead of
// re-normalizing the reader's `runs.jsonl` on every change (which was O(history)
// per new run). The watch mirrors the Ingestor's belt-and-braces (dir fs.watch
// + a poll by entry-count, since fs.watch misses atomic-rename / SMB writes).
// --------------------------------------------------------------------------- //

export class RunsSource extends EventEmitter {
  private dir: string | null = null;
  private records: RunRecord[] = [];
  private watcher: FSWatcher | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private lastCount = -1;
  private started = false;
  // raw file stems already asked to re-convert this process — fire each at most once so a
  // permanently-stale log (re-convert keeps failing) can't spin the converter every poll.
  private staleRequested = new Set<string>();
  // Per-file parse cache: reload used to readFileSync + JSON.parse EVERY logs/<id>.json on every
  // change — O(history) main-thread work per finished run, which is what made a months-old install
  // freeze (slow list/pin/quit until the user cleared the history). A logs file only ever changes
  // by being REPLACED (the converter's tmp+rename advances its mtime), so an unchanged
  // (mtimeMs, size) pair means unchanged bytes and the previous parse can be reused. The cached
  // record is the PRISTINE parse — reload hands a SHALLOW CLONE downstream, because deriveSessions
  // writes the derived sessionId onto the working set and the session-scoped dedup is only safe
  // while every v2 run still carries the on-disk "" at dedup time, exactly like a fresh parse
  // (see the reload comments). `record: null` is a tombstone: parsing is deterministic, so an
  // unparseable / not-a-run file stays skipped without re-parsing until its bytes change.
  // Validated by a fresh stat every reload; pruned to the live dir listing; cleared on setDir/stop.
  private fileCache = new Map<string, { mtimeMs: number; size: number; record: RunRecord | null }>();
  // Trailing-edge debounce for fs.watch-driven reloads (the poll path stays direct: it is already
  // 1s-gated and the tests drive it deterministically with fake timers).
  private watchDebounce: ReturnType<typeof setTimeout> | null = null;

  private logsPath(): string | null {
    return this.dir ? join(this.dir, "logs") : null;
  }

  setDir(dir: string | null): void {
    if (dir === this.dir) return;
    this.dir = dir;
    this.staleRequested.clear();
    this.fileCache.clear();
    if (this.started) {
      this.rewatch();
      this.reload();
    }
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.rewatch();
    this.reload();
  }

  stop(): void {
    this.started = false;
    this.clearWatch();
    this.records = [];
    this.lastCount = -1;
    this.staleRequested.clear();
    this.fileCache.clear();
  }

  listIndex(): RunIndexEntry[] {
    return this.records.map(projectIndex);
  }

  getById(id: string): RunRecord | null {
    return this.records.find((r) => r.id === id) ?? null;
  }

  /** All loaded records (newest-first). Used by the auto-uploader + session-stats. */
  all(): RunRecord[] {
    return this.records;
  }

  /** Local "clear history": delete every structured `logs/<id>.json`, then reload so the UI
   *  empties immediately. The reader's raw/ must be cleared TOO (runs-store.clearAllRuns handles
   *  that) — else the Ingestor re-converts the orphaned raws straight back into logs/ on the next
   *  pass. Returns false only if there is no dir yet. */
  clearFile(): boolean {
    const path = this.logsPath();
    if (!path) return false;
    clearJsonDir(path);
    this.reload();
    return true;
  }

  /** Force an immediate reload + "changed" emit. Used after an external delete (max-runs prune /
   *  selective clear-all in runs-store) so the in-memory list drops the removed files at once —
   *  the per-file cache's stat check sees the vanished files and prunes them (the deleted run can
   *  never be resurrected from the cache). SYNC by the same contract as reload(). */
  reloadNow(): void {
    this.reload();
  }

  private clearWatch(): void {
    if (this.watcher) {
      try {
        this.watcher.close();
      } catch {
        // ignore
      }
      this.watcher = null;
    }
    if (this.poll) {
      clearInterval(this.poll);
      this.poll = null;
    }
    if (this.watchDebounce) {
      clearTimeout(this.watchDebounce);
      this.watchDebounce = null;
    }
  }

  /** Coalesce a burst of fs.watch events into ONE reload (trailing edge). A single finished run
   *  fires several dir events (tmp create + rename, sometimes more); reloading on each one was
   *  pure repeat work. */
  private scheduleReload(): void {
    if (this.watchDebounce) clearTimeout(this.watchDebounce);
    this.watchDebounce = setTimeout(() => {
      this.watchDebounce = null;
      this.reload();
    }, WATCH_DEBOUNCE_MS);
  }

  private rewatch(): void {
    this.clearWatch();
    const path = this.logsPath();
    if (!path) return;

    // fs.watch fires on dir entries changing (a new/rewritten logs/<id>.json) — but it is
    // unreliable across atomic-rename / SMB, so we also poll by entry count as a fallback.
    try {
      if (existsSync(path)) {
        this.watcher = watch(path, () => this.scheduleReload());
      }
    } catch {
      this.watcher = null;
    }

    this.poll = setInterval(() => {
      const p = this.logsPath();
      if (!p) return;
      try {
        if (!existsSync(p)) {
          // logs/ vanished (e.g. a clear) — drain to empty once.
          if (this.records.length > 0) this.reload();
          return;
        }
        const count = jsonNames(p).length;
        if (count !== this.lastCount) {
          // (Re)attach fs.watch if it was never set up (dir appeared later).
          if (!this.watcher) {
            try {
              this.watcher = watch(p, () => this.scheduleReload());
            } catch {
              this.watcher = null;
            }
          }
          this.reload();
        }
      } catch {
        // ignore transient stat errors
      }
    }, POLL_INTERVAL_MS);
  }

  /** Read every logs/<id>.json, load (parse + coerce, NO re-derive), dedup session-scoped, sort
   *  newest-first, emit "changed". A stale log (older structured schema) triggers an on-use
   *  re-convert (fire-and-forget; the fresh log lands and the watcher reloads). */
  private reload(): void {
    const path = this.logsPath();
    if (!path || !existsSync(path)) {
      if (this.records.length > 0) {
        this.records = [];
        this.lastCount = -1;
        this.emit("changed");
      }
      return;
    }

    let names: string[];
    try {
      names = jsonNames(path);
    } catch {
      // transient readdir error — keep the last good state, never crash the watcher
      return;
    }
    this.lastCount = names.length;

    const out: RunRecord[] = [];
    for (const name of names) {
      const filePath = join(path, name);
      // Stat first: an unchanged (mtimeMs, size) means unchanged bytes (logs are only ever
      // REPLACED via tmp+rename, which advances the mtime), so the cached parse is reusable and
      // the O(history) read+parse storm collapses to O(changed files) per reload.
      let mtimeMs: number;
      let size: number;
      try {
        const st = statSync(filePath);
        mtimeMs = st.mtimeMs;
        size = st.size;
      } catch {
        continue; // vanished between readdir and stat (a clear mid-pass) — treat as gone
      }
      const cached = this.fileCache.get(name);
      let record: RunRecord | null;
      if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
        record = cached.record; // unchanged bytes — reuse the pristine parse (or its tombstone)
      } else {
        record = parseLogFile(filePath);
        this.fileCache.set(name, { mtimeMs, size, record });
      }
      if (record === null) continue; // not a run record (corrupt / no id / bad ts) — skip
      // SHALLOW clone: deriveSessions (below) writes the derived sessionId onto the working copy;
      // the cached pristine record must keep the on-disk value (v2 = "") so the NEXT reload's dedup
      // still sees every v2 run under the one "" owner — identical to a fresh parse. Nested fields
      // (heroes/drops/issues) are shared by reference: nothing downstream mutates them.
      out.push({ ...record });
      // On-use staleness (PR4 step 3): a log from an OLDER converter is re-converted
      // from its raw so the freshest derivation/quality lands. Fire-and-forget — the converter
      // rewrites the log and the watcher picks up the current version on the next reload.
      if (
        record.structuredSchemaVersion !== undefined &&
        record.structuredSchemaVersion < STRUCTURED_SCHEMA_VERSION
      ) {
        this.requestReconvert(record.id);
      }
    }
    // Prune cache entries whose file is gone (clear-history, manual deletes) so a deleted run can
    // never be resurrected from memory and the cache stays bounded by the live dir listing.
    const live = new Set(names);
    for (const name of this.fileCache.keys()) {
      if (!live.has(name)) this.fileCache.delete(name);
    }

    // newest-first: by ts desc, then run desc
    out.sort((a, b) => (b.ts - a.ts) || (b.run - a.run));

    // (1) ID-dedup: a run `id` is the unique run identity, so two logs sharing an id are the SAME
    // run written twice (a re-finalization wrote a second file under a different ts -> a different
    // filename). Keep the newest (first, post-sort). This is identity collapse — orthogonal to the
    // content dedup below, and always safe (same id == same run, never two distinct runs).
    const byId = dedupeById(out);

    // (2) Collapse the two-reader phantom: content-identical runs across DIFFERENT sessions. A real
    // farm (same session) is NEVER collapsed (dedup — the session-scoped net).
    const records = dedupeSessionScoped(byId);

    // (3) Derive the session for raw-v2 runs (Redesign 2). v2 carries NO reader session (the reader
    // stopped emitting it) -> sessionId === "" out of the converter; the app DERIVES it here from the
    // run timestamps (6h gap). Done AFTER dedup ON PURPOSE: during dedup every v2 run shares "" -> the
    // cross-session content-collapse treats them as one session -> a real farm is never false-hidden.
    // Legacy v1 runs keep their original sessionId. Pure + deterministic -> stable across reloads.
    const v2 = records.filter((r) => r.sessionId === "");
    if (v2.length > 0) {
      const derived = deriveSessions(v2.map((r) => ({ id: r.id, ts: r.ts })), readSessionCuts(this.dir));
      for (const r of v2) {
        const sid = derived.get(r.id);
        if (sid !== undefined) r.sessionId = sid;
      }
    }

    this.records = records;
    this.emit("changed");
  }

  /** Ask the converter to re-convert one run from its raw (on-use staleness). Lazy-imports
   *  ingest to avoid a static import cycle (ingest -> legacy -> runs-source). At most one
   *  request per raw stem per process. Best-effort: a failure is swallowed (the log stays usable). */
  private requestReconvert(id: string): void {
    const dir = this.dir;
    if (!dir) return;
    // raw file stem mirrors the reader's `raw/<session_id>-<run>.json` (':' -> '-' for Windows).
    const stem = `${id.replace(/:/g, "-")}.json`;
    if (this.staleRequested.has(stem)) return;
    this.staleRequested.add(stem);
    void import("../converter/ingest.js")
      .then(({ ingestOne }) => {
        ingestOne(dir, stem);
      })
      .catch(() => {
        // best effort — leave the stale-but-usable record in place
      });
  }
}

// --------------------------------------------------------------------------- //
// Small dir helpers (shared by the watch + clear). Local to this module so the
// READ path has no dependency on logs-archive (which only owns the CLEAR action).
// --------------------------------------------------------------------------- //

function jsonNames(dir: string): string[] {
  return readdirSync(dir).filter((n) => n.endsWith(".json") && !n.endsWith(".tmp"));
}

/** Parse ONE logs/<name>.json with the defensive guards reload always applied: an un-parseable /
 *  half-written file, a non-object, a loader throw, or a not-a-run record (no id / bad ts) all
 *  yield null — never a throw. Deterministic on the file's bytes, so the per-file cache can hold
 *  the result (including the null tombstone) until the bytes change. */
function parseLogFile(filePath: string): RunRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  try {
    return loadStructured(parsed as Record<string, unknown>);
  } catch {
    return null;
  }
}

/** Delete every .json in `dir` (best-effort; never crashes the app over a delete). */
function clearJsonDir(dir: string): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return; // dir missing — nothing to clear
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      rmSync(join(dir, name));
    } catch {
      // best effort — never crash the app over a delete
    }
  }
}

let singleton: RunsSource | null = null;

export function getRunsSource(): RunsSource {
  if (!singleton) singleton = new RunsSource();
  return singleton;
}
