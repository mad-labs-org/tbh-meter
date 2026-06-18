import { cpSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Regenerates the committed game-data snapshot in `data/` from a tbh-wiki checkout.
// Maintainers run this AFTER a Task Bar Hero patch (once the wiki's datamine is refreshed):
//
//   node scripts/refresh-game-data.mjs --wiki /path/to/tbh-wiki
//
// Defaults to a sibling `../tbh-wiki`. Reads the wiki's datamined `data/*.json` + sprite assets,
// derives the slim maps the app needs, and writes everything under `data/{json,sprites,heroes}`.
// `app/scripts/sync-data.mjs` then copies that snapshot into the app's runtime dirs at build.
//
// This is the ONLY tie to the wiki. The app/build itself never needs the wiki — it uses the
// committed snapshot. (Derivation logic mirrors the wiki's original tbh-meter/app sync-data.)

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, ".."); // scripts -> repo root

const wikiArgIdx = process.argv.indexOf("--wiki");
const wiki =
  wikiArgIdx >= 0 && process.argv[wikiArgIdx + 1]
    ? process.argv[wikiArgIdx + 1]
    : join(root, "..", "tbh-wiki");

const dataSrc = join(wiki, "data"); // datamined JSON
const spritesSrc = join(wiki, "web", "public", "sprites"); // chest icons
const animSrc = join(spritesSrc, "anim", "heroes"); // hero idle GIFs

if (!existsSync(dataSrc)) {
  console.error(`refresh-game-data: wiki data not found at ${dataSrc}`);
  console.error("Pass --wiki <path-to-tbh-wiki> (defaults to ../tbh-wiki).");
  process.exit(1);
}

const jsonDest = join(root, "data", "json");
const spritesDest = join(root, "data", "sprites");
const heroesDest = join(root, "data", "heroes");
for (const d of [jsonDest, spritesDest, heroesDest]) {
  rmSync(d, { recursive: true, force: true }); // start clean so stale files don't linger
  mkdirSync(d, { recursive: true });
}

// Full copies: monsters/buffs/buffGroups feed the live overlay's stage-threat panel.
const files = [
  "heroes.json",
  "skills.json",
  "stages.json",
  "meta.json",
  "monsters.json",
  "buffs.json",
  "buffGroups.json",
];
for (const f of files) {
  const srcFile = join(dataSrc, f);
  if (existsSync(srcFile)) cpSync(srcFile, join(jsonDest, f));
}

// items-min: { key -> "en-us name" }; chests-min: { box_key -> sprite basename }.
// All variants of a chest tier share one icon (910*->Item_910011, 920*, 930*).
{
  const itemsFile = join(dataSrc, "items.json");
  const names = {};
  const chestIcons = {};
  if (existsSync(itemsFile)) {
    const items = JSON.parse(readFileSync(itemsFile, "utf-8"));
    const arr = Array.isArray(items) ? items : Object.values(items);
    for (const it of arr) {
      const key = it?.key ?? it?.itemKey ?? it?.id;
      if (key == null) continue;
      const name = it?.names?.["en-us"] ?? it?.name;
      if (name) names[key] = name;
      if (it?.itemType === "STAGEBOX" && it?.iconPath) chestIcons[key] = it.iconPath;
    }
  }
  writeFileSync(join(jsonDest, "items-min.json"), JSON.stringify(names));
  writeFileSync(join(jsonDest, "chests-min.json"), JSON.stringify(chestIcons));
  console.log(
    `refresh: items-min.json (${Object.keys(names).length} names), chests-min.json (${Object.keys(chestIcons).length} boxes)`,
  );

  // Copy the distinct chest sprites referenced above.
  let n = 0;
  for (const icon of new Set(Object.values(chestIcons))) {
    const sp = join(spritesSrc, `${icon}.png`);
    if (existsSync(sp)) {
      cpSync(sp, join(spritesDest, `${icon}.png`));
      n++;
    }
  }
  console.log(`refresh: chest sprites (${n})`);
}

// skillKey -> attributeKey bridge for the share payload. Mirrors reader/scripts/gen_skill_attr_map.py.
{
  const heroesFile = join(dataSrc, "heroes.json");
  const map = {};
  if (existsSync(heroesFile)) {
    const heroes = JSON.parse(readFileSync(heroesFile, "utf-8"));
    for (const hero of Array.isArray(heroes) ? heroes : []) {
      for (const node of hero?.skillTree ?? []) {
        if (node?.type !== "ACTIVESKILL" || node.refKey == null || node.attributeKey == null) {
          continue;
        }
        if (map[node.refKey] != null && map[node.refKey] !== node.attributeKey) {
          console.warn(
            `refresh: ambiguous skillKey ${node.refKey} (${map[node.refKey]} vs ${node.attributeKey}); keeping first`,
          );
          continue;
        }
        map[node.refKey] = node.attributeKey;
      }
    }
  }
  writeFileSync(join(jsonDest, "skill-attr-map.json"), JSON.stringify(map));
  console.log(`refresh: skill-attr-map.json (${Object.keys(map).length} skills)`);
}

// Socket-material reverse index for the share payload:
// family -> gear group -> statType -> tier ("*" = any) -> [materialKey, optionIndex, min, max].
{
  const materialsFile = join(dataSrc, "materials.json");
  const map = {};
  if (existsSync(materialsFile)) {
    const groupEffects = (effects, group) => {
      const v = effects?.[group];
      if (!v) return [];
      return Array.isArray(v) ? v : [v];
    };
    const slotEffects = (effects, group) => {
      const own = groupEffects(effects, group);
      return own.length > 0 ? own : groupEffects(effects, "COMMON");
    };
    const materials = JSON.parse(readFileSync(materialsFile, "utf-8"));
    for (const mat of Array.isArray(materials) ? materials : []) {
      if (mat?.key == null || !["DECORATION", "ENGRAVING", "INSCRIPTION"].includes(mat.materialType)) {
        continue;
      }
      for (const group of ["WEAPON", "ARMOR", "ACCESSORY"]) {
        slotEffects(mat.effects, group).forEach((eff, optIdx) => {
          if (!eff?.statType) return;
          const lo = eff.minTier ?? eff.maxTier;
          const hi = eff.maxTier ?? eff.minTier;
          const tiers = lo == null ? ["*"] : [];
          for (let t = lo; t <= hi; t++) tiers.push(String(t));
          for (const tier of tiers) {
            const byStat = ((map[mat.materialType] ??= {})[group] ??= {});
            ((byStat[eff.statType] ??= {})[tier] ??= []).push([
              mat.key,
              optIdx,
              eff.min ?? null,
              eff.max ?? null,
            ]);
          }
        });
      }
    }
  }
  writeFileSync(join(jsonDest, "socket-map.json"), JSON.stringify(map));
  console.log(`refresh: socket-map.json (${Object.keys(map).length} families)`);
}

// Hero idle animations (keys 101..601) for the runs-list Team column.
{
  let n = 0;
  for (const key of [101, 201, 301, 401, 501, 601]) {
    const sp = join(animSrc, `${key}.gif`);
    if (existsSync(sp)) {
      cpSync(sp, join(heroesDest, `Hero_${key}.gif`));
      n++;
    }
  }
  console.log(`refresh: hero sprites (${n})`);
}

console.log(`refresh: snapshot written to data/ from ${wiki}`);
