/** The game outcome the reader observed. (Mirrors the RAW `run_outcome`; a later PR may rename
 *  the `RunRecord.status` field to `runOutcome` once its consumers are touched — see progress.md.) */
export type RunStatus = "success" | "fail" | "abandoned";
/** The converter's verdict on a run (PR3): `counted` = good data meeting the structural floor;
 *  `skipped` = below floor / not a clear; `partial` = capture incomplete (joined mid-run);
 *  `degraded` = critical fields unreadable (e.g. the 1.00.10 gold:0 bug). Orthogonal to the game
 *  outcome (`status`). Drives the leaderboard gate (backend) + the app's display filter (PR6). */
export type RunQuality = "counted" | "skipped" | "partial" | "degraded";

/** SYSTEM rule (versioned, NOT a user setting): below this many seconds a run does NOT count
 *  (the leaderboard floor) — EXCEPT stage x-10. The reader historically used 30s; the redesign
 *  lowers it to 15s while KEEPING the x-10 exception (that exception is the true invariant, not the
 *  number — run-lifecycle). Lives in `shared/` because BOTH the converter (`main/converter/helpers.ts`,
 *  which seals the verdict) AND the renderer (PR6's duration filter, which must never let the user set
 *  a minimum below this floor) need the SAME value — the renderer cannot import main-process code.
 *  Distinct from the user's display filter (`AppSettings.minDurationSec`): the floor is fixed, the
 *  filter is a preference clamped to it (progress.md "Configs" — never conflate the two). */
export const COUNT_FLOOR_SEC = 15;

/** The stage NUMBER (StageNo) exempt from the duration floor — the act boss fight. NOTE the stage
 *  NUMBER 10, NOT EStageType.ACTBOSS (different signals; conflating them dropped legitimate x-10
 *  runs — see run-lifecycle / anti-patterns). The display filter (PR6) honours the same exemption. */
export const ACT_BOSS_STAGE_NO = 10;
/** A chest that dropped during the run (captured from GetBoxLog; marks the drop, not the open). */
export interface RunDrop { boxKey: number; monsterType: number; }
export interface RunMod { recipeId: number | null; recipe: string; statId: number | null; stat: string; value: number | null; tier: number | null; }
export interface RunItem { slot: string; slotId: number | null; grade: string; gradeId: number | null; itemKey: number | null; uniqueId: string; level: number | null; mods: RunMod[]; }
/** A hero skill: `key` = skill key (equipped active: skillKey; invested passive: attributeKey == refKey); `lv` = invested level (null when unknown — e.g. an unmapped or innate active). v9+ `skills` includes invested passives alongside equipped actives; pre-v9 held equipped actives only. */
export interface RunSkill { key: number; lv: number | null; }
/** The hero's full invested skill tree (v8+): { [attributeKey]: level } for every node with points (actives + passives). Absent in pre-v8 runs (use `skills`). */
export interface RunHero { heroKey: number; class: string; classId: number | null; level: number; exp: number; items: RunItem[]; skills: RunSkill[]; skillLevels?: Record<string, number>; stats: Record<string, number>; expStart?: number; expEnd?: number; levelup?: boolean; xpGained?: number; deaths?: number; revives?: number; killedBy?: number[]; }
/** A finished run. The structured artifact the app reads from `logs/<id>.json` (produced by the
 *  converter, PR3) and the shape `normalizeRecord` still emits from the legacy `runs.jsonl` until
 *  PR4. The converter-only fields below are optional: absent on the legacy normalize path, always
 *  populated by the converter. `schemaVersion` = the RAW/reader schema version this was derived
 *  from (provenance; 1 for new raws, 5–11 for migrated legacy); `structuredSchemaVersion` = the
 *  converter's own output version (regenerable — bump it to force a re-convert). */
export interface RunRecord { id: string; ts: number; sessionId: string; schemaVersion: number; gameVersion: string; run: number; status: RunStatus; stage: string; act: number | null; stageNo: number | null; stageKey: number | null; mode: string; mobs: number; totalMobs: number | null; totalDamage: number; dps: number; clearTime: number; duration: number; goldGained: number; goldSource: string; xpGained: number; xpSource: string; xpPerSec: number; goldPerSec: number; partial: boolean; waveNow?: number | null; waveTotal?: number | null; drops?: RunDrop[]; deaths?: number; revives?: number; heroes: RunHero[]; quality?: RunQuality; issues?: Record<string, string>; structuredSchemaVersion?: number; }
export interface LiveSnapshot { runNumber: number | null; stage: string; mode: string; stageKey: number | null; mobs: number; totalMobs: number | null; elapsedSec: number; damage: number; dps: number; goldGain: number | null; xpGain: number | null; party: number[] | null; /** Live chest-drop counts by EMonsterLogType index: [common(0), stageBoss(1), actBoss(2)]. */ drops: number[] | null; /** Live FINAL_STATS per deployed hero — `{heroKey: {statId: value}}` (numeric keys). null when an older reader doesn't emit it (the resistance tooltip then hides). */ partyStats: Record<number, Record<number, number>> | null; approx: boolean; }
