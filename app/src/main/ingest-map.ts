import skillAttrJson from "../shared/data/skill-attr-map.json";
import socketJson from "../shared/data/socket-map.json";
import type { RunItem, RunMod, RunSkill } from "../shared/run-types.js";

// --------------------------------------------------------------------------- //
// RunHero build data -> ingest (planner) shapes, used by share.ts to fill the
// POST /runs payload so the website's run page renders the full build (gear
// paper-doll + skill grid), like a saved build.
//
// Two generated bridges (scripts/sync-data.mjs, from the repo's datamined data):
//  - skill-attr-map.json: skillKey -> attributeKey. Equipped skills are stored by
//    skillKey, but ingest skillLevels is keyed by the skill-tree node's attributeKey.
//  - socket-map.json: reverse index of socket materials. The reader sees a socketed
//    item as mods (recipe family + stat + tier + rolled value), while the planner
//    stores the socketed material.key per family slot. Candidates are
//    [materialKey, optionIndex, min, max]; when (family, group, stat, tier) is
//    ambiguous, the rolled value picks the candidate whose roll range contains it.
// --------------------------------------------------------------------------- //

/** Mirror of @tbh/shared partyGearSlotStateSchema (the meter cannot import that package). */
export interface IngestGearSlot {
  itemKey: number | null;
  decorations: (number | null)[];
  engravings: (number | null)[];
  inscriptions: (number | null)[];
  /** Chosen stat per multi-option socket, keyed by "<family>:<index>". */
  effectChoices?: Record<string, number>;
}

type SocketCandidate = [number, number, number | null, number | null];
type SocketMap = Record<string, Record<string, Record<string, Record<string, SocketCandidate[]>>>>;
// A JSON import widens each fixed-length candidate row to an array, so `socketJson as SocketMap`
// is rejected (array vs 4-tuple). Cast via an array-leaf shape instead of `as unknown`: TS still
// verifies the 4-level family→group→stat→tier nesting against the import (a wrong shape would
// fail here), and only the tuple LENGTH is asserted — every row is [materialKey, optionIndex,
// min, max] (all 1662 rows are length-4; sync-data.mjs emits them).
type SocketMapJson = Record<string, Record<string, Record<string, Record<string, (number | null)[][]>>>>;

const SKILL_ATTR = skillAttrJson as Record<string, number>;
const SOCKET_MAP = socketJson as SocketMapJson as SocketMap;

/** Planner gear slot -> material-effect gear group (mirrors the wiki's gearGroupForSlot). */
const SLOT_GROUP: Record<string, "WEAPON" | "ARMOR" | "ACCESSORY"> = {
  MAIN_WEAPON: "WEAPON",
  SUB_WEAPON: "WEAPON",
  HELMET: "ARMOR",
  ARMOR: "ARMOR",
  GLOVES: "ARMOR",
  BOOTS: "ARMOR",
  RING: "ACCESSORY",
  AMULET: "ACCESSORY",
  EARING: "ACCESSORY",
  BRACER: "ACCESSORY",
};

/** ERecipeType name -> planner socket family. Other recipes (ALCHEMY...) have no socket. */
const MOD_FAMILY: Record<string, "decorations" | "engravings" | "inscriptions"> = {
  DECORATION: "decorations",
  ENGRAVING: "engravings",
  INSCRIPTION: "inscriptions",
};

/** Ingest schema caps: socket arrays max 16 entries, skill levels 0..9999. */
const MAX_SOCKETS = 16;
const MAX_SKILL_LEVEL = 9999;

/**
 * Equipped skills -> ingest skillLevels ({ [attributeKey]: level }). Skills with an
 * unknown level (pre-v7 runs) or no map entry are skipped. undefined when empty so
 * the field is omitted from the payload.
 */
export function mapSkillLevels(
  skills: RunSkill[],
  skillAttr: Record<string, number> = SKILL_ATTR,
): Record<string, number> | undefined {
  const out: Record<string, number> = {};
  for (const s of skills ?? []) {
    if (!s || s.lv == null || s.lv <= 0) continue;
    const attr = skillAttr[String(s.key)];
    if (attr == null) continue;
    out[String(attr)] = Math.min(MAX_SKILL_LEVEL, Math.trunc(s.lv));
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The socket-map candidate for one mod, value-disambiguated. Null when unmapped. */
function matchSocket(
  socketMap: SocketMap,
  group: string,
  mod: RunMod,
): { key: number; optIdx: number } | null {
  const byTier = socketMap[mod.recipe]?.[group]?.[mod.stat];
  if (!byTier) return null;
  const candidates = (mod.tier != null ? byTier[String(mod.tier)] : undefined) ?? byTier["*"];
  if (!candidates || candidates.length === 0) return null;
  const byValue =
    mod.value != null
      ? candidates.find(
          ([, , min, max]) =>
            (min == null || mod.value! >= min) && (max == null || mod.value! <= max),
        )
      : undefined;
  const [key, optIdx] = byValue ?? candidates[0];
  return { key, optIdx };
}

/**
 * Equipped items -> ingest gear ({ [GearSlot]: planner slot state }). Slot names come
 * from the same EItemParts enum on both sides, so they pass through. Mods in a socket
 * family map to that family's array (null when the material can't be resolved — the
 * socket still shows as filled-but-unknown count-wise); other recipes are dropped.
 * undefined when no item maps, so the field is omitted from the payload.
 */
export function mapGear(
  items: RunItem[],
  socketMap: SocketMap = SOCKET_MAP,
): Record<string, IngestGearSlot> | undefined {
  const out: Record<string, IngestGearSlot> = {};
  for (const item of items ?? []) {
    if (!item || item.itemKey == null) continue;
    const group = SLOT_GROUP[item.slot];
    if (!group || out[item.slot]) continue;

    const slot: IngestGearSlot = {
      itemKey: Math.trunc(item.itemKey),
      decorations: [],
      engravings: [],
      inscriptions: [],
    };
    const effectChoices: Record<string, number> = {};
    for (const mod of item.mods ?? []) {
      const family = mod?.recipe ? MOD_FAMILY[mod.recipe] : undefined;
      if (!family || slot[family].length >= MAX_SOCKETS) continue;
      const matched = mod.stat ? matchSocket(socketMap, group, mod) : null;
      if (matched && matched.optIdx > 0) {
        effectChoices[`${family}:${slot[family].length}`] = matched.optIdx;
      }
      slot[family].push(matched?.key ?? null);
    }
    if (Object.keys(effectChoices).length > 0) slot.effectChoices = effectChoices;
    out[item.slot] = slot;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
