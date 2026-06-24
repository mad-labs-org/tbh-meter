// Capture the meter while the live loop animates: overlay (ONLINE, live run + chest cards),
// plus the main window's Tracker and Runs tabs. Playwright over CDP :9222.
import { createRequire } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";
import fs from "node:fs";
const require = createRequire("/Users/tracefinance/projects/personal/tbh-wiki/web/");
const { chromium } = require("@playwright/test");

const OUT = "/Users/tracefinance/projects/personal/tbh-wiki/release-video/assets/meter-real";
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
const ctx = browser.contexts()[0];
const http = () => ctx.pages().filter((p) => p.url().startsWith("http"));

await sleep(5500); // let the live loop flip the overlay online
let pages = http();
console.log("pages:", pages.map((p) => p.url()));

const overlay = pages.find((p) => !p.url().includes("#")) || pages[0];
if (overlay) {
  await overlay.bringToFront().catch(() => {});
  await sleep(700);
  await overlay.screenshot({ path: `${OUT}/overlay.png`, omitBackground: true });
  await overlay.screenshot({ path: `${OUT}/overlay-bg.png` });
  console.log("overlay captured");
}

const list = pages.find((p) => p.url().includes("#list"));
if (list) {
  await list.bringToFront().catch(() => {});
  for (const [tab, file] of [["Tracker", "tracker"], ["Runs", "runs"]]) {
    try {
      await list.getByText(tab, { exact: true }).first().click({ timeout: 4000 });
      await sleep(1600);
      await list.screenshot({ path: `${OUT}/${file}.png` });
      console.log(`captured ${file}`);
    } catch (e) {
      console.log(`${tab} err:`, String(e).split("\n")[0]);
    }
  }
}
await browser.close();
console.log("files:", fs.readdirSync(OUT).join(", "));
