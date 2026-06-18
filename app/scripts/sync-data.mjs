import { cpSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Copies the committed game-data snapshot (repo-root `data/`) into the app's runtime dirs
// (all git-ignored, regenerated on every dev/build/test). The snapshot itself is the source
// of truth, refreshed per game patch by `scripts/refresh-game-data.mjs` (maintainers only).
// Skips gracefully if the snapshot is missing (e.g. a partial checkout) so the build never
// hard-fails on it.
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", ".."); // app/scripts -> app -> repo root
const snapshot = join(root, "data");

if (!existsSync(snapshot)) {
  console.log(`sync-data: snapshot not found (${snapshot}); skipping`);
  process.exit(0);
}

// snapshot subdir -> app runtime destination
const copies = [
  ["json", join(here, "..", "src", "shared", "data")], // full JSON + derived minified maps
  ["sprites", join(here, "..", "src", "renderer", "public", "sprites")], // chest tier icons
  ["heroes", join(here, "..", "src", "renderer", "public", "heroes")], // hero idle GIFs
];

for (const [sub, dest] of copies) {
  const srcDir = join(snapshot, sub);
  if (!existsSync(srcDir)) {
    console.log(`sync-data: ${sub} missing in snapshot; skipping`);
    continue;
  }
  mkdirSync(dest, { recursive: true });
  const entries = readdirSync(srcDir);
  for (const f of entries) cpSync(join(srcDir, f), join(dest, f));
  console.log(`sync-data: ${sub} (${entries.length}) -> ${dest.slice(root.length + 1)}`);
}

console.log("sync-data: done");
