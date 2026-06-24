// Seed ~/tbh-meter with REAL stageKeys read from the game data (stages.json), so the
// meter resolves the blue-chest sprite, level, stage code, mode and SPOTS correctly.
// No invented keys. Run: node release-video/seed-meter.mjs
import fs from "node:fs";

const ROOT = "/Users/tracefinance/projects/personal/tbh-wiki";
const raw = JSON.parse(fs.readFileSync(`${ROOT}/tbh-meter/app/src/shared/data/stages.json`, "utf8"));
const list = Array.isArray(raw) ? raw : Object.entries(raw).map(([k, v]) => ({ key: Number(k), ...v }));
const byKey = new Map(list.map((s) => [s.key, s]));
const title = (d) => d.charAt(0) + d.slice(1).toLowerCase(); // "TORMENT" -> "Torment"

const DIR = `${process.env.HOME}/tbh-meter`;
const SUP = `${process.env.HOME}/Library/Application Support/tbh-meter`;
fs.mkdirSync(`${DIR}/logs`, { recursive: true });
fs.mkdirSync(SUP, { recursive: true });
const NOW = Date.now();

// cooldown entry from a REAL stageKey; remainingSec=0 => READY
const cd = (key, remainingSec) => {
  const s = byKey.get(key);
  if (!s) throw new Error(`stageKey ${key} not in game data`);
  const dropAt = remainingSec <= 0 ? NOW - 12.2 * 60 * 1000 : NOW - (720 - remainingSec) * 1000;
  return { stageKey: key, stage: `${s.act}-${s.stageNo}`, mode: title(s.difficulty), dropAt };
};
const cds = [cd(2109, 0), cd(4309, 61)]; // 1-9 NM READY, 3-9 TO 1:01 (real keys)

const settings = {
  outputDir: null, opacity: 1, alwaysOnTop: true, liveBounds: null, listBounds: null,
  hideSignInPrompt: true, liveExpanded: true, runColumns: [], anonymousUpload: true,
  hideNonCounted: true, minDurationSec: null, cooldownTrackerEnabled: true,
  chestCooldowns: cds, chestDropLog: cds.map((c) => ({ ...c })),
};
fs.writeFileSync(`${SUP}/settings.json`, JSON.stringify(settings, null, 2));

// live overlay: 3-9 Torment (4309), values matched to a real run, blue chest in drops[1]
const t = byKey.get(4309);
const live = {
  raw_schema_version: 1, run: 7, stageKey: 4309, act: t.act, stageNo: t.stageNo, difficulty: 3,
  mobs: 496, total_mobs: 652, damage_now: 15_640_000, elapsed: 136,
  gold_now: 1_830_000, xp_now: 32_140_000, party: [101, 201, 301], drops: [2, 1, 0],
};
fs.writeFileSync(`${DIR}/live.json`, JSON.stringify(live));

// a few completed runs (3-9 Torment) for the Runs list / sessions
for (const r of [5, 6, 7]) {
  const dps = [115010, 121400, 118700][r - 5];
  const rec = {
    id: `1717799000-12345:${r}`, ts: NOW - (8 - r) * 60000, sessionId: "1717799000-12345",
    schemaVersion: 1, structuredSchemaVersion: 1, gameVersion: "1.00.10", run: r,
    status: "success", quality: "counted", stage: "3-9", act: 3, stageNo: 9, stageKey: 4309,
    mode: "Torment", mobs: 652, totalMobs: 652, totalDamage: 15_640_000, dps, clearTime: 136,
    duration: 138, goldGained: 1_830_000, goldSource: "live", xpGained: 32_140_000, xpSource: "live",
    xpPerSec: 236330, goldPerSec: 13430, partial: false,
    drops: [{ boxKey: 920801, monsterType: 2 }], deaths: 0, revives: 0, issues: {},
    heroes: [101, 201, 301].map((h) => ({ heroKey: h, class: "0x1", classId: 1, level: 95, exp: 9e6, items: [], skills: [], stats: {}, deaths: 0, revives: 0 })),
  };
  fs.writeFileSync(`${DIR}/logs/1717799000-12345:${r}.json`, JSON.stringify(rec));
}
console.log("seeded REAL:", cds.map((c) => `${c.stage} ${c.mode} (key ${c.stageKey})`).join(" · "), "+ live 3-9 Torment + 3 runs");
