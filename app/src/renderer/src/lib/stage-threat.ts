import monstersData from "../../../shared/data/monsters.json";
import buffsData from "../../../shared/data/buffs.json";
import buffGroupsData from "../../../shared/data/buffGroups.json";
import { stageMap, stageDifficulty } from "./game-data";

// ── Stage threat profile (live overlay) ──────────────────────────────────────
// What a stage throws at the player, derived ONLY from already-datamined facts:
//   elements  — stage spawn table + boss → each monster's attackTypes (verified 1:1
//               with the monster's skill damageTypes across all 61 monsters).
//   penalty   — the per-difficulty all-resistance debuff. BuffGroups 910001/2/3 are
//               referenced by nothing in the extracted data (the game applies them in
//               code); the game's own stat tooltip ("A penalty applies based on stage
//               difficulty") proves the mechanism. The Nightmare/Hell/Torment → group
//               order is inferred from the monotone -20/-40/-60 tiers and the exact
//               in-game number is still unverified, so the UI words it as "base".

/** Elemental damage types only. Physical is deliberately excluded: every stage deals
 *  it and there is no physical-resistance stat, so a badge would be pure noise. */
export type ThreatElement = "Fire" | "Cold" | "Lightning" | "Chaos";

export const THREAT_ELEMENTS: ThreatElement[] = ["Fire", "Cold", "Lightning", "Chaos"];

export interface ThreatMonster {
  name: string;
  /** True for the stage's boss slot (bossMonsterKey), not the catalog isBoss flag. */
  boss: boolean;
}

export interface ElementThreat {
  element: ThreatElement;
  monsters: ThreatMonster[];
}

export interface StageThreatInfo {
  /** Elements present on the stage, in THREAT_ELEMENTS order; empty when all-physical. */
  elements: ElementThreat[];
  /** Flat all-resistance penalty (20/40/60) for the stage's difficulty, null on Normal. */
  penalty: number | null;
  /** Title-cased difficulty ("Hell"), null when unknown. */
  mode: string | null;
}

interface MonsterRecord {
  key: number;
  name: string;
  attackTypes?: string[];
}

const monsters = monstersData as MonsterRecord[];
const monsterMap = new Map<number, MonsterRecord>(monsters.map((m) => [m.key, m]));

interface BuffRecord {
  key: number;
  type: string;
  statType: string;
  value: number | null;
}
interface BuffGroupRecord {
  key: number;
  buffKeys: string[];
}

const buffMap = new Map<number, BuffRecord>(
  (buffsData as BuffRecord[]).map((b) => [b.key, b]),
);
const buffGroupMap = new Map<number, BuffGroupRecord>(
  (buffGroupsData as BuffGroupRecord[]).map((g) => [g.key, g]),
);

// Difficulty → orphaned debuff buff-group (see header note on the inferred order).
const PENALTY_GROUP: Record<string, number> = {
  NIGHTMARE: 910001,
  HELL: 910002,
  TORMENT: 910003,
};

/** The flat all-resistance penalty of a difficulty, read from the buff data (never
 *  hard-coded values). Null for Normal/unknown or if the group ever disappears. */
export function difficultyPenalty(difficulty: string | null | undefined): number | null {
  const groupKey = difficulty ? PENALTY_GROUP[difficulty.toUpperCase()] : undefined;
  if (groupKey == null) return null;
  const group = buffGroupMap.get(groupKey);
  if (!group) return null;
  let penalty: number | null = null;
  for (const k of group.buffKeys) {
    const buff = buffMap.get(Number(k));
    if (buff?.type !== "Debuff" || !buff.statType.endsWith("Resistance")) continue;
    if (typeof buff.value !== "number") continue;
    // The four per-element entries share one value; keep the worst if they ever diverge.
    penalty = penalty == null ? buff.value : Math.max(penalty, buff.value);
  }
  return penalty;
}

/** The threat profile of a stage, or null when the stage is unknown. An all-physical
 *  Normal stage yields `{ elements: [], penalty: null }` — callers hide the UI then. */
export function stageThreat(stageKey: number | null | undefined): StageThreatInfo | null {
  if (stageKey == null) return null;
  const stage = stageMap.get(stageKey);
  if (!stage) return null;

  // Spawn table first, boss last; dedupe (the boss can also appear in the table).
  const keys: number[] = [];
  for (const m of stage.monsters ?? []) {
    const k = Number(m.monster);
    if (Number.isFinite(k) && !keys.includes(k)) keys.push(k);
  }
  const bossKey = stage.bossMonsterKey ?? null;
  if (bossKey != null && !keys.includes(bossKey)) keys.push(bossKey);

  const byElement = new Map<ThreatElement, ThreatMonster[]>();
  for (const k of keys) {
    const rec = monsterMap.get(k);
    if (!rec) continue;
    for (const t of rec.attackTypes ?? []) {
      if (!(THREAT_ELEMENTS as string[]).includes(t)) continue; // skips Physical
      const el = t as ThreatElement;
      let list = byElement.get(el);
      if (!list) byElement.set(el, (list = []));
      list.push({ name: rec.name, boss: k === bossKey });
    }
  }

  const elements: ElementThreat[] = THREAT_ELEMENTS.filter((el) => byElement.has(el)).map(
    (el) => ({ element: el, monsters: byElement.get(el)! }),
  );

  return {
    elements,
    penalty: difficultyPenalty(stage.difficulty ?? null),
    mode: stageDifficulty(stageKey),
  };
}

/** True when there is anything worth showing (an element badge or a penalty). */
export function hasThreat(info: StageThreatInfo | null): info is StageThreatInfo {
  return info != null && (info.elements.length > 0 || info.penalty != null);
}
