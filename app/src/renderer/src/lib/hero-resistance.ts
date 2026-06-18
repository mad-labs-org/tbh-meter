// Per-hero EFFECTIVE elemental resistance for the live overlay's Team tooltip.
//
// FORMULA — confirmed live against the game panel (2 data points; hero 201 in 3-9 Torment:
// AllElemental=27 → Fire/Cold/Lightning 33%, Chaos 60%; +10 Fire gem → Fire 23%, rest unchanged):
//
//   effective(element) = ownResistance(element) − difficultyPenalty
//   ownResistance(Fire|Cold|Lightning) = AllElementalResistance + perElementResistance
//   ownResistance(Chaos)                = ChaosResistance        ← AllElemental does NOT cover Chaos
//
// difficultyPenalty is the per-difficulty all-resistance debuff (datamined buffs 910001-3, validated):
// Normal 0 · Nightmare 20 · Hell 40 · Torment 60. A negative `effective` means the hero is VULNERABLE
// (taking extra damage of that element) — the stat the game only exposes one hero at a time in a panel.

// StatType ids — baked from the reader's StatType(IntEnum) in config/offsets.py (same source as
// game-data.ts STAT_NAMES). Only the resistance-relevant ids are needed here.
const STAT_FIRE_RES = 12;
const STAT_COLD_RES = 13;
const STAT_LIGHTNING_RES = 14;
const STAT_CHAOS_RES = 15;
const STAT_ALL_ELEMENTAL_RES = 52;

// Difficulty → flat all-resistance penalty, keyed by the cooked mode name (LiveSnapshot.mode).
const MODE_PENALTY: Record<string, number> = {
  Normal: 0,
  Nightmare: 20,
  Hell: 40,
  Torment: 60,
};

export type ResElement = "Fire" | "Cold" | "Lightning" | "Chaos";
export const RES_ELEMENTS: ResElement[] = ["Fire", "Cold", "Lightning", "Chaos"];

export interface HeroResistance {
  element: ResElement;
  /** The hero's own resistance to this element (AllElemental + per-element; Chaos = ChaosRes only). */
  own: number;
  /** Effective resistance after the stage penalty (= own − penalty). Negative = vulnerable. */
  effective: number;
}

export interface HeroResistanceInfo {
  /** The difficulty penalty applied (0 on Normal/unknown). */
  penalty: number;
  resistances: HeroResistance[];
}

/** Effective elemental resistances for one hero, given its live FINAL_STATS and the stage mode.
 *  Returns null when the hero has no stats (older reader / not deployed) so callers hide the tooltip. */
export function heroResistances(
  stats: Record<number, number> | undefined | null,
  mode: string,
): HeroResistanceInfo | null {
  if (!stats) return null;
  const penalty = MODE_PENALTY[mode] ?? 0;
  const all = stats[STAT_ALL_ELEMENTAL_RES] ?? 0;
  const own: Record<ResElement, number> = {
    Fire: all + (stats[STAT_FIRE_RES] ?? 0),
    Cold: all + (stats[STAT_COLD_RES] ?? 0),
    Lightning: all + (stats[STAT_LIGHTNING_RES] ?? 0),
    Chaos: stats[STAT_CHAOS_RES] ?? 0, // AllElemental excludes Chaos (confirmed live)
  };
  return {
    penalty,
    resistances: RES_ELEMENTS.map((element) => ({
      element,
      own: own[element],
      effective: own[element] - penalty,
    })),
  };
}
