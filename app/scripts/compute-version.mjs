// Computes the next tbh-meter release version from conventional-commit history.
//
// Source of truth = the git tags `tbh-meter-v*` (NOT the committed package.json).
// This mirrors semantic-release's default model: the committed "version" field is a
// FLOOR, not a mirror — CI writes the computed version into package.json only for the
// build artifact and never commits it back.
//
// Algorithm
//   base   = highest `tbh-meter-v*` tag (semver), or 0.0.0 if none.
//   intent = strongest conventional-commit signal among commits touching tbh-meter/
//            since that tag (breaking > feat > fix); defaults to PATCH otherwise, so
//            every push to main that reaches CI yields a unique, increasing version.
//   bump   = applyBump(base, intent)            // 0.x is special — see below
//   final  = max(bump, package.json version)    // floor / manual override
//
// Conventional-commit -> intent
//   `type(scope)!:` header, or `BREAKING CHANGE` / `BREAKING-CHANGE` in the body  -> major
//   `feat:` / `feat(scope):`                                                      -> minor
//   `fix:`  / `fix(scope):`                                                       -> patch
//   anything else                                                                -> patch (default)
//
// 0.x guard: while the major is 0, a breaking change does NOT auto-cross into 1.0.0
//   (SemVer §4: 0.y.z is initial development — the API is explicitly unstable). Both
//   `major` and `minor` intents bump the MINOR (0.1.0 -> 0.2.0); `patch` bumps the
//   patch (0.1.0 -> 0.1.1). Graduating to 1.0.0 is a deliberate human act: set
//   "version": "1.0.0" in package.json (the floor) and CI releases exactly that, then
//   continues bumping from 1.x onward.
//
// Usage
//   node scripts/compute-version.mjs                    # dry run: print the next version
//   node scripts/compute-version.mjs --write            # write it into package.json (CI)
//   node scripts/compute-version.mjs --prerelease rc    # print <version>-rc.<N> (next RC)
//   node scripts/compute-version.mjs --prerelease rc --write
//   node scripts/compute-version.mjs --set 0.5.0-rc.3 --write   # stamp an EXACT version
//   node scripts/compute-version.mjs --allow-empty      # mint even with zero meter commits
//   node scripts/compute-version.mjs --json             # emit {version,base,commitCount,…}
//
// --set <version> skips all computation and just prints (and, with --write, stamps) the
// given version — used by the build workflow to build the exact version named by a chosen
// rc tag rather than recomputing it.
//
// --prerelease <id> turns the computed stable version into a prerelease: it scans the
// existing `tbh-meter-v<version>-<id>.*` tags and appends the next free counter, so each
// RC built off the same base gets a distinct, increasing SemVer prerelease tag
// (0.5.0-rc.1, 0.5.0-rc.2, …). These `-id.N` tags never become the base (parseSemver only
// matches X.Y.Z), so every RC keeps targeting the same stable version until a clean
// `tbh-meter-v<version>` tag is pushed (at ship/promote time).
//
// --allow-empty / refusal (the P1 guard): with ZERO commits touching tbh-meter/ since the
// base tag, the default mode now REFUSES — it prints the reason to stderr and exits 2,
// instead of silently patch-bumping an unchanged tree into a phantom release. Pass
// --allow-empty to override (e.g. a deliberate forced rebuild via direct-to-stable). A
// 1.0.0 graduation is NOT an empty case: bumping the package.json "version" floor is itself
// a meter commit, so it computes normally. (Seed re-calibration after a game patch writes
// tbh-meter/reader/config/calib_seed.json — also a meter commit — so it is never refused.)
//
// --json switches stdout to a single JSON object {version, base, commitCount, signal,
// refused} (version is null on refusal) so a workflow can surface the computed version in a
// ::notice, a matrix job name, and the step summary without scraping stderr.
//
// Diagnostics go to stderr; without --json the bare version is the only thing on stdout, so
// `VERSION=$(node scripts/compute-version.mjs)` captures just the number.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgPath = join(here, "..", "package.json"); // app/scripts -> app/package.json
const TAG_PREFIX = "tbh-meter-v";
// Commits that touch the buildable meter. In the standalone repo the whole tree IS the meter,
// but a docs-/CI-only change should not mint a release, so we filter to the build inputs.
const PATHSPECS = ["app", "reader", "data"];
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/;

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
}

export function parseSemver(v) {
  const m = SEMVER_RE.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Negative if a<b, positive if a>b, 0 if equal. */
export function cmp(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/** Strongest signal of a single commit message: 3=major, 2=minor (feat), 1=fix, 0=other. */
export function intentOf(message) {
  const header = message.split("\n", 1)[0];
  // `!` directly before the `:` of a `type(scope)!:` header marks a breaking change.
  if (/^[a-z]+(\([^)]*\))?!:/i.test(header)) return 3;
  if (/(^|\n)\s*BREAKING[ -]CHANGE\s*:/.test(message)) return 3;
  if (/^feat(\([^)]*\))?:/i.test(header)) return 2;
  if (/^fix(\([^)]*\))?:/i.test(header)) return 1;
  return 0;
}

export function applyBump([maj, min, pat], intent) {
  if (maj === 0) {
    // 0.x: breaking & feat both bump minor; never auto-cross into 1.0.0.
    return intent >= 2 ? [0, min + 1, 0] : [0, min, pat + 1];
  }
  if (intent === 3) return [maj + 1, 0, 0];
  if (intent === 2) return [maj, min + 1, 0];
  return [maj, min, pat + 1];
}

function highestTag(repoRoot) {
  let out = "";
  try {
    out = git(["tag", "--list", `${TAG_PREFIX}*`], repoRoot);
  } catch {
    return null;
  }
  let best = null;
  for (const line of out.split("\n")) {
    const tag = line.trim();
    if (!tag) continue;
    const v = parseSemver(tag.slice(TAG_PREFIX.length));
    if (v && (!best || cmp(v, best.version) > 0)) best = { tag, version: v };
  }
  return best;
}

function commitsSince(repoRoot, tag) {
  // -z: NUL-separate full commit messages (%B); range is `tag..HEAD` (or all history
  // when there is no tag yet), filtered to commits that touch the meter build inputs.
  const range = tag ? `${tag}..HEAD` : "HEAD";
  let out = "";
  try {
    out = git(["log", "-z", "--format=%B", range, "--", ...PATHSPECS], repoRoot);
  } catch (e) {
    process.stderr.write(`compute-version: git log failed (${e.message}); assuming no commits\n`);
    return [];
  }
  return out.split("\0").filter((m) => m.trim());
}

export const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The value following `--name` (or `--name=value`) in argv, or null. */
function flagValue(name) {
  const argv = process.argv;
  const i = argv.indexOf(name);
  if (i !== -1 && i + 1 < argv.length && !argv[i + 1].startsWith("--")) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : null;
}

/** The `tbh-meter-v<version>-<id>.*` tags currently in the repo. */
function prereleaseTags(repoRoot, version, id) {
  try {
    return git(["tag", "--list", `${TAG_PREFIX}${version}-${id}.*`], repoRoot)
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Next prerelease counter for `<version>-<id>.<N>`: the highest existing N + 1 (1 if none).
 *  Pure (takes the tag list) so the counter logic is unit-testable without git. Gives every
 *  RC built off the same base version a distinct, increasing tag. */
export function nextPrereleaseNum(tags, version, id) {
  const re = new RegExp(`^${escapeRe(`${TAG_PREFIX}${version}-${id}.`)}(\\d+)$`);
  let max = 0;
  for (const tag of tags) {
    const m = re.exec(tag);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

/** Decide the next STABLE version (or refuse). Pure — takes the inputs git would supply, so
 *  the P1 refusal and bump math are unit-testable without a repo.
 *
 *  Returns {refused:true, reason} when `commits` is empty and !allowEmpty (the P1 guard:
 *  never mint a version for an unchanged tree). Otherwise {refused:false, version:[M,m,p],
 *  signal} where signal is the strongest conventional-commit intent (0..3) and version is
 *  the bump applied to baseVer, floored at `floor` (deliberate graduation, e.g. 1.0.0). */
export function computeNext({ baseVer, commits, floor, allowEmpty }) {
  if (commits.length === 0 && !allowEmpty) {
    return { refused: true, reason: "no commits touching the meter since the base tag" };
  }
  const signal = commits.reduce((max, m) => Math.max(max, intentOf(m)), 0);
  const intent = signal === 0 ? 1 : signal; // chore-only still advances (patch)
  const bumped = applyBump(baseVer, intent);
  const version = cmp(bumped, floor) >= 0 ? bumped : floor; // floor wins (manual override)
  return { refused: false, version, signal };
}

/** Replace ONLY the package.json "version" line with `version` (byte-stable otherwise). */
function stampVersion(pkgRaw, version) {
  const next = pkgRaw.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`);
  if (next === pkgRaw && !pkgRaw.includes(`"version": "${version}"`)) {
    throw new Error('compute-version: could not find a "version" field to update');
  }
  writeFileSync(pkgPath, next);
  process.stderr.write(`compute-version: wrote ${version} to package.json\n`);
}

/** stdout contract: a single JSON object with --json, else the bare version (or nothing on
 *  a refusal — stderr + exit 2 carry that). Keeps `VERSION=$(compute-version…)` working. */
function emitResult(json, payload) {
  if (json) process.stdout.write(JSON.stringify(payload));
  else if (payload.version != null) process.stdout.write(payload.version);
}

function main() {
  const write = process.argv.includes("--write");
  const json = process.argv.includes("--json");
  const allowEmpty = process.argv.includes("--allow-empty");
  const prereleaseId = flagValue("--prerelease");
  const setVersion = flagValue("--set");
  const pkgRaw = readFileSync(pkgPath, "utf-8");

  // --set <version>: stamp/print an explicit version, skipping ALL computation. The build
  // workflow uses this to build the EXACT version named by a chosen rc tag (e.g.
  // --set 0.20.2-rc.3), instead of recomputing (which would mint the NEXT rc number).
  if (setVersion) {
    process.stderr.write(`compute-version: --set ${setVersion} (computation skipped)\n`);
    if (write) stampVersion(pkgRaw, setVersion);
    emitResult(json, { version: setVersion, base: null, commitCount: null, signal: null, refused: false });
    return;
  }

  const floor = parseSemver(JSON.parse(pkgRaw).version) ?? [0, 0, 0];

  let repoRoot;
  try {
    repoRoot = git(["rev-parse", "--show-toplevel"], here).trim();
  } catch {
    // Not a git checkout (e.g. a tarball build): fall back to the committed floor.
    process.stderr.write("compute-version: not a git repo; using package.json version\n");
    emitResult(json, { version: floor.join("."), base: null, commitCount: null, signal: null, refused: false });
    return;
  }

  const base = highestTag(repoRoot);
  const baseVer = base ? base.version : [0, 0, 0];
  const commits = commitsSince(repoRoot, base?.tag);
  const baseLabel = base ? base.tag : "(none)";

  const decision = computeNext({ baseVer, commits, floor, allowEmpty });

  // P1: an unchanged tree mints nothing. Loud on stderr, exit 2 so a workflow can branch on
  // it (Stage → green no-op "nothing staged"; Ship → red "nothing to ship").
  if (decision.refused) {
    process.stderr.write(
      `compute-version: no commits touching ${PATHSPECS.join("/")} since ${baseLabel} — ` +
        `refusing to mint a version (pass --allow-empty to override)\n`,
    );
    emitResult(json, { version: null, base: baseVer.join("."), commitCount: 0, signal: 0, refused: true });
    process.exitCode = 2;
    return;
  }

  const version = decision.version.join(".");

  // Optional prerelease suffix: <version>-<id>.<N>, N = next free counter for that base.
  const outVersion = prereleaseId
    ? `${version}-${prereleaseId}.${nextPrereleaseNum(
        prereleaseTags(repoRoot, version, prereleaseId),
        version,
        prereleaseId,
      )}`
    : version;

  const label = ["other/none", "fix→patch", "feat→minor", "breaking→major"][decision.signal];
  process.stderr.write(
    `compute-version: base ${baseLabel} = ${baseVer.join(".")}, ` +
      `${commits.length} commit(s) since, strongest signal: ${label}, ` +
      `floor ${floor.join(".")} -> ${outVersion}\n`,
  );

  // Targeted replace of the version line only — keeps the rest of the file (and its
  // formatting) byte-for-byte identical, so the build diff is minimal.
  if (write) stampVersion(pkgRaw, outVersion);

  emitResult(json, {
    version: outVersion,
    base: baseVer.join("."),
    commitCount: commits.length,
    signal: decision.signal,
    refused: false,
  });
}

// Run only when invoked directly (node scripts/compute-version.mjs), not when imported by
// tests — so the pure helpers above can be unit-tested without executing the CLI.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
