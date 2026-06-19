---
name: meter-game-update
description: The TaskBarHero game updated (new version) and the tbh-meter reader needs re-calibration — symptoms are gold showing 0 and/or stage mode "?" after a patch, or you're prepping a meter release for a new game build. Runs the diagnose→dump→diff→reseed→bump→verify playbook. Use when the game version changed, after a TBH patch, when a player reports gold/stage broken following an update, or when asked to re-seed / re-calibrate the reader for a new build.
---

# Updating the reader for a new game build

**Canonical playbook (the drift-tested source of truth): `reader/docs/guides/game-update.md`.**
This skill is the *operational layer* — how to run that playbook on the maintainer's machine, with the
exact commands and paths. Read the doc for the why (the three buckets, the invariants it links).

## TL;DR

Every game patch rebuilds `GameAssembly.dll` → the build fingerprint changes → the bundled seed
(`config/calib_seed.json`) misses → the client falls to the fragile **cold scan** → **gold 0** and
**stage mode "?"** (dps/damage/xp keep working — managers are always in memory). **The fix is almost
always re-seed + bump `GAME_VERSION`, NOT editing offsets.** The dump+diff (step 3) is the tripwire
that tells you whether you're in the rare case where an offset actually shifted. Proven on 1.00.10:
recompile, but every offset/enum/index was identical — only `anchor_rva` moved → reseed fixed it (#242).

## Machine setup (maintainer's Mac — the Windows shares are SMB-mounted)

| Path | Role |
|---|---|
| `/Volumes/TaskbarHero` | game install: `GameAssembly.dll`, `Version.txt`, `TaskBarHero_Data/il2cpp_data/Metadata/global-metadata.dat` |
| `/Volumes/tbh-meter-dev` | dev share = `C:\Users\mario\tbh-meter-dev` (has `reader/`); where the reseed runs on Windows |
| `/private/tmp/tbhm` | the reader's `~/tbh-meter` output (`meter.log`, `runs.jsonl`, `resolve_cache.json`) — readable from the Mac |
| `~/tbh-dump` | Il2CppDumper (net6) + a local copy of the game files for dumping |

> **SMB caches file CONTENT** (stale reads even when mtime is fresh). Force a fresh read with
> `cp /private/tmp/tbhm/<file> /tmp/ && <read /tmp/<file>>`.

## How the agent runs this (the one handoff)

The agent runs steps **1–3** and **5** autonomously. **Steps 4 (reseed) and 6 (live-validation gate)
are HUMAN steps** — both need the Windows game open and IN COMBAT, which the agent can't drive. So: run
1–3 (the static work — step 3 is the one-command `preflight_calib.py`, which bundles ruff + pytest + the
code↔game tripwire and exits 0 only if all pass), then **STOP** and hand the maintainer the reseed
command (step 4); resume at 5 once the new seed is on the share; then **STOP again** for the maintainer
to run `validate_live.py` (step 6) and **do NOT ship until it PASSes on ALL metrics** (not just the field
you fixed) — both halves are gated by the **🔒 SHIP GATE** checklist under step 6. (Don't auto-merge/
release either — step 7 stops at the PR; the release/promote are the maintainer's manual triggers.)

## Steps (mirror `guides/game-update.md`; **run every command from the repo/worktree root** — the ones that need the reader `cd` into it themselves)

**1 — Fingerprint (recompile vs content-only).** Parse the PE header of the new DLL and compare its
native part to the committed seed key:
```bash
python3 -c "
import struct,json
f=open('/Volumes/TaskbarHero/GameAssembly.dll','rb')
f.seek(0x3C); pe=struct.unpack('<I',f.read(4))[0]
f.seek(pe+0x8); tds=struct.unpack('<I',f.read(4))[0]
f.seek(pe+0x50); soi=struct.unpack('<I',f.read(4))[0]
ver=open('/Volumes/TaskbarHero/Version.txt',encoding='utf-8-sig').read().strip()
print(f'live  fp = {ver}-{tds:#x}-{soi:#x}')
print('seed key =', list(json.load(open('reader/config/calib_seed.json'))['calib'])[0])
"
```
Same native part (`-0x…-0x…`) → content-only patch, offsets intact → skip to step 4. Different → recompile → do steps 2–3.

**2 — Dump the new build (Il2CppDumper, no game needed — static).**
```bash
cd ~/tbh-dump
cp /Volumes/TaskbarHero/GameAssembly.dll . && cp /Volumes/TaskbarHero/TaskBarHero_Data/il2cpp_data/Metadata/global-metadata.dat .
DOTNET_ROLL_FORWARD=Major dotnet tool/Il2CppDumper.dll GameAssembly.dll global-metadata.dat out < /dev/null
```
If `~/tbh-dump/tool/Il2CppDumper.dll` is missing, fetch it once (needs `dotnet`; metadata is unencrypted, magic `af1bb1fa`):
```bash
mkdir -p ~/tbh-dump/tool && cd ~/tbh-dump
curl -sL -o tool.zip "$(curl -s https://api.github.com/repos/Perfare/Il2CppDumper/releases/latest | python3 -c "import sys,json;print(next(a['browser_download_url'] for a in json.load(sys.stdin)['assets'] if a['name'].startswith('Il2CppDumper-net6-') and 'win' not in a['name']))")"
unzip -o -q tool.zip -d tool && python3 -c "import json;c=json.load(open('tool/config.json'));c['RequireAnyKey']=False;json.dump(c,open('tool/config.json','w'),indent=2)"
```

**3 — Static preflight (the ONE-COMMAND gate: ruff + pytest + the code↔game tripwire).**
Run the consolidated static gate — it runs `ruff`, `pytest` (the regression suite, incl. the
docs↔code drift test and the PlayerSaveData-offset pins), then `diff_offsets_vs_dump` against the
fresh dump, and prints the live-gate command you must run later:
```bash
cd reader && python scripts/preflight_calib.py --dump ~/tbh-dump/out/dump.cs --seed config/calib_seed.json
```
**ALWAYS pass `--seed config/calib_seed.json`** so the tripwire also checks the seed's `TypeDefIndex`
+ `idx_ut` (a stale seed surfaces as a `✗` to investigate, not a silent miss — without `--seed`,
index/`idx_ut` drift is invisible until you reseed). Exit 0 → every static layer passed and nothing
the reader tracks shifted. Any non-zero → **STOP**: a `✗` in the diff means update that symbol in
`config/offsets.py` from `out/dump.cs` (the single source — `docs/invariants/offsets-single-source.md`)
and re-run until clean; a ruff/pytest failure means a code regression. **Eyeball the diff's per-class
field dump** for any class whose net offsets are unchanged but whose field NAMES shifted (the only
residual silent case the name-check is built to surface). Obfuscated classes (`UnitHealthController`/
`HeroRuntime`/`StatsHolder`/`AggregateManager`/`StatModifier`) report "não-verificável" — the live run
(step 6) validates those. (You can still run `diff_offsets_vs_dump.py` directly when you only want the
tripwire; the preflight just wraps ruff+pytest around it so a re-seed never skips the regression suite.)

**4 — Reseed — ⚠ HUMAN STEP. Agent: STOP here and ask the maintainer to run this; you CANNOT (it needs
the Windows game open and IN COMBAT, gold ticking). Wait for them to confirm, then continue at step 5.**
```bat
cd C:\Users\mario\tbh-meter-dev
python reader\scripts\seed_calib_capture.py
```
Then read the new seed back and verify before committing:
```bash
python3 -c "
import json; d=json.load(open('/Volumes/tbh-meter-dev/reader/config/calib_seed.json'))
e=list(d['calib'].values())[0]
print('fmt',d['fmt'],'fp',list(d['calib'])[0],'idx_ut',e['idx_ut'],
      'stages',len(e['stage_info']),'items',len(e['item_cat']),'heroes',len(e['hero_cat']))
"
cp /Volumes/tbh-meter-dev/reader/config/calib_seed.json reader/config/calib_seed.json
```
Confirm `fmt == CACHE_FMT`, the fp matches step 1's live fp, `idx_ut` is sane, and catalogs are non-empty
(incl. ACTBOSS x-10). If catalogs are empty → the capture ran outside combat; redo it in a stage.

**5 — Bump `GAME_VERSION`** in `reader/meter_windows.py` (the only definition — fallback only,
the live version comes from `Version.txt`).

**6 — Validate — ⚠ MANDATORY LIVE GATE, ALL metrics. Agent: STOP and have the maintainer run this;
do NOT ship without PASS.** First, agent autonomously: `cd reader && python meter_windows.py
--selftest` (seed shape: `fmt == CACHE_FMT` + calib non-empty). Then sync the gate to the share
(`rsync … reader/scripts/validate_live.py` or the whole `reader/`) and the maintainer runs it with the
game OPEN and IN COMBAT in a stage:
```bat
cd C:\Users\mario\tbh-meter-dev
python reader\scripts\validate_live.py
```
It resolves via the embedded seed (same path as the RC's first launch) and requires **PASS on ALL**:
`calib/seed`, `gold`, `party-viva`, `hero-class`, `save-build`, `build-record`, `xp-viva`, `dps`,
`stats`, `stage`, `run-cycle`, `catálogos` (writes `validate_live_out.txt` on the share — read it
back). **Exit != 0 → DO NOT SHIP.** This is the ONLY check that covers the OBFUSCATED classes the
step-3 diff can't (`AggregateManager`/gold, `HeroRuntime`/party+xp, `StatsHolder`) AND the SAVE/record
paths the run actually uploads (`save-build`+`build-record`, the 1.00.12 fleet-stoppage path). ⚠
**NEVER validate only the field you just fixed** — on 1.00.11 the gold was confirmed but the party
(`HeroRuntime`) shipped broken because nobody checked the rest; selftest + diff are NOT enough alone.
See `docs/process/live-validation-gate.md`.

**🔒 SHIP GATE — non-skippable checklist (both layers must be green BEFORE step 7).** The reader has
shipped a wrong seed/calibration THREE times, each silent, each because verification was PARTIAL:
**(1)** gold read 1.97T then 0 — `AggregateManager` (`idx_ut`) resolved by a value-scan that didn't
converge; **(2)** party fell back to the save roster — `pick_live_sm`'s cap blew past the live
`StageManager` (+0 xp, 6 heroes shown solo); **(3)** 1.00.12 — the bucket-box inserted fields into
`PlayerSaveData` and shifted every save list +0x10, so `read_gold`/`read_heroes` read the WRONG list →
`pick_live_psd` None → run `heroes=[]` → the app's `eligible()` (heroes>0) skipped every run →
**fleet-wide upload stoppage**. Each passed GREEN because the gate it had was the wrong one (static
"offset exists" ≠ "offset correct"; the live gate exercised only the LIVE path, never the SAVE build
the run record uses). So do NOT bump `GAME_VERSION` or ship until BOTH are checked:

- [ ] **STATIC (agent, this machine):** `python reader/scripts/preflight_calib.py --dump
  ~/tbh-dump/out/dump.cs --seed reader/config/calib_seed.json` → **exit 0** (ruff + pytest +
  the code↔game tripwire all green). A non-zero here = fix offsets/code and re-run; never proceed.
- [ ] **LIVE (maintainer, Windows, game OPEN + IN COMBAT):** `python reader\scripts\validate_live.py`
  → **exit 0, PASS on ALL** the checks listed above (read back `validate_live_out.txt`). This is the
  ONLY layer that catches the obfuscated singletons and the SAVE/record paths — the exact blind spots
  of breaks (1)/(2)/(3). A non-zero or any FAIL = regression; do NOT ship.

Only with **both boxes checked** do you continue to step 7. The static preflight alone is NOT
ship-readiness (it cannot run the game); `validate_live` PASS is mandatory and is a HUMAN step.

**7 — Ship.** Commit the new `calib_seed.json` + the `GAME_VERSION` bump (a reader-only change). This touches `reader/`, so it IS a meter change and stages a
release normally. The seed is baked into the `.exe`, so the fix reaches players only via a shipped
release — merge → **step 1** auto-creates the version tag → **step 2** builds a test version → **step 3**
releases it (Latest + Discord) via the numbered meter workflows (`.github/CONTRIBUTING.md` -> How releases work; `.claude/CLAUDE.md` for the pipeline).

## Don't

- Don't edit `config/offsets.py` "to be safe" — only when step 3 shows a real `✗`. On 1.00.10 nothing shifted.
- Don't bump `CACHE_FMT` here — that's a *reader* change (calib shape), unrelated to a game patch; if you do, the reseed is mandatory in the same PR (see the `cache-management` invariant in `docs/`).
- Don't commit a seed captured outside combat (degraded catalogs → `--selftest` may pass but the fast path serves "?" stages forever for that build).
- Don't ship on a PARTIAL check (selftest + diff + "the gold works"). The obfuscated classes (party/xp via `HeroRuntime`, gold via `AggregateManager`) only validate LIVE — `validate_live.py` must PASS on ALL metrics. Validating only the field you touched is exactly how the party bug shipped (1.00.11).
- Don't skip the static preflight or run it without `--dump`/`--seed` — `preflight_calib.py` exit 0 (ruff + pytest + the seeded code↔game diff) is the non-negotiable STATIC half of the ship gate above; a missing dump makes it FAIL on purpose (not diffing the new build = not knowing, the 1.00.12 trap). It is still NOT ship-readiness on its own — it cannot run the game, so `validate_live` PASS is always also required.
