// Navigate tbherohelper.com and capture real INTERNAL pages for the video:
// an item detail (loot table / what drops where), a build detail, and a player profile
// (formation/market value). Indices (leaderboards/database/builds) are already captured.
import { createRequire } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";
import fs from "node:fs";
const require = createRequire("/Users/tracefinance/projects/personal/tbh-wiki/web/");
const { chromium } = require("@playwright/test");

const OUT = "/Users/tracefinance/projects/personal/tbh-wiki/release-video/assets/site-real";
fs.mkdirSync(OUT, { recursive: true });
const BASE = "https://tbherohelper.com";
const ACCEPT = /^(accept|accept all|got it|ok|i agree|agree|allow all)$/i;

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2, locale: "en-US", colorScheme: "dark" });
const p = await ctx.newPage();

async function settle() {
  try { const btn = p.getByRole("button", { name: ACCEPT }); if (await btn.first().isVisible({ timeout: 1500 })) await btn.first().click(); } catch {}
  try { await p.waitForLoadState("networkidle", { timeout: 6000 }); } catch {}
  await p.evaluate(() => document.fonts?.ready).catch(() => {});
  await sleep(1600);
  await p.evaluate(() => window.scrollTo(0, 0));
  await sleep(200);
}
async function shot(name) {
  await p.screenshot({ path: `${OUT}/${name}.png` });
  await p.screenshot({ path: `${OUT}/${name}-full.png`, fullPage: true });
  console.log("shot", name, "->", p.url());
}
async function clickInto(indexUrl, hrefSel, name) {
  try {
    await p.goto(indexUrl, { waitUntil: "load", timeout: 30000 });
    await settle();
    const link = p.locator(`a[href*="${hrefSel}"]`).first();
    await link.click({ timeout: 6000 });
    await settle();
    await shot(name);
  } catch (e) { console.log(`${name} err:`, String(e).split("\n")[0]); }
}

await clickInto(`${BASE}/items`, "/items/", "item-detail");
await clickInto(`${BASE}/builds`, "/builds/", "build-detail");
await clickInto(`${BASE}/heroes`, "/heroes/", "hero-detail");

// profile: prefer a profile link from the leaderboard; fall back to a run page
try {
  await p.goto(`${BASE}/leaderboards`, { waitUntil: "load", timeout: 30000 });
  await settle();
  const prof = p.locator('a[href*="/profile/"]').first();
  if (await prof.count()) { await prof.click({ timeout: 6000 }); await settle(); await shot("profile"); }
  else {
    const run = p.locator('a[href*="/leaderboards/"]').first();
    await run.click({ timeout: 6000 }); await settle(); await shot("run-detail");
  }
} catch (e) { console.log("profile err:", String(e).split("\n")[0]); }

await b.close();
console.log("files:", fs.readdirSync(OUT).join(", "));
