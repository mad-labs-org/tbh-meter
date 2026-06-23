// Capture real, retina screenshots of tbherohelper.com for the release-video prototype.
// Uses the Playwright + Chromium already installed in web/node_modules (resolved via createRequire),
// the same trick the meter mac dev-drive uses. App is dark-only, so screenshots come out dark.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire("/Users/tracefinance/projects/personal/tbh-wiki/web/");
const { chromium } = require("@playwright/test");

const OUT = join(dirname(fileURLToPath(import.meta.url)), "assets");
const BASE = "https://tbherohelper.com";

// name → path. Picked for visual punch; we'll choose the best 3-4 frames after seeing them.
const PAGES = [
  { name: "home", path: "/" },
  { name: "meter", path: "/meter" },
  { name: "leaderboards", path: "/leaderboards" },
  { name: "heroes", path: "/heroes" },
  { name: "items", path: "/items" },
  { name: "builds", path: "/builds" },
  { name: "database", path: "/database/heroes" },
];

const ACCEPT = /^(accept|accept all|aceitar|allow all|got it|ok|i agree|agree|entendi|concordo)$/i;

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  deviceScaleFactor: 2, // → 2560×1440 retina PNGs
  locale: "en-US",
  colorScheme: "dark",
});
const page = await ctx.newPage();

for (const { name, path } of PAGES) {
  try {
    await page.goto(BASE + path, { waitUntil: "load", timeout: 30_000 });
    // Dismiss any consent/cookie banner.
    try {
      const btn = page.getByRole("button", { name: ACCEPT });
      if (await btn.first().isVisible({ timeout: 2000 })) await btn.first().click();
    } catch {}
    try {
      await page.waitForLoadState("networkidle", { timeout: 6000 });
    } catch {}
    await page.evaluate(() => document.fonts?.ready).catch(() => {});
    await page.waitForTimeout(1800); // sprites, fade-ins
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(200);

    const vp = join(OUT, `${name}.png`);
    await page.screenshot({ path: vp });
    const full = join(OUT, `${name}-full.png`);
    await page.screenshot({ path: full, fullPage: true });
    const dims = await page.evaluate(() => ({ w: document.body.scrollWidth, h: document.body.scrollHeight }));
    console.log(`✓ ${name.padEnd(13)} viewport+full  (page ${dims.w}×${dims.h})`);
  } catch (e) {
    console.log(`✗ ${name.padEnd(13)} ${String(e).split("\n")[0]}`);
  }
}

await browser.close();
console.log("done →", OUT);
