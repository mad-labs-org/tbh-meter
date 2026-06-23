// Animate ~/tbh-meter/live.json so the overlay flips ONLINE and the run progresses.
// 3-9 Torment (real stageKey 4309), values in the range of a real run. ~45s then stops.
import fs from "node:fs";
const P = `${process.env.HOME}/tbh-meter/live.json`;
let mobs = 380, dmg = 11_500_000, gold = 1_500_000, xp = 26_000_000, elapsed = 108;
const start = Date.now();
const tick = () => {
  elapsed += 0.7;
  mobs = Math.min(652, mobs + 6);
  const dps = Math.round(115000 * (0.94 + Math.random() * 0.12));
  dmg += dps * 0.7; gold += 13430 * 0.7; xp += 236330 * 0.7;
  const live = {
    raw_schema_version: 1, run: 7, stageKey: 4309, act: 3, stageNo: 9, difficulty: 3,
    mobs: Math.round(mobs), total_mobs: 652, damage_now: Math.round(dmg), elapsed: Math.round(elapsed),
    gold_now: Math.round(gold), xp_now: Math.round(xp), party: [101, 201, 301], drops: [2, 1, 0],
  };
  fs.writeFileSync(P, JSON.stringify(live));
  if (mobs >= 652) { mobs = 8; dmg = 200000; } // loop the run
  if (Date.now() - start > 45000) { clearInterval(id); console.log("live loop done"); }
};
const id = setInterval(tick, 700);
tick();
console.log("animating live.json (3-9 Torment) …");
