#!/usr/bin/env python3
"""validate_live.py — LIVE post-update validation GATE (READ-ONLY, zero-arg).

WHY: the static diff (scripts/diff_offsets_vs_dump.py) only checks NAMED classes. The
OBFUSCATED ones — AggregateManager (gold), HeroRuntime (party + xp), StatsHolder — it marks as
"unverifiable, validate live" and moves on. That is EXACTLY where TWO bugs slipped into a
build on 1.00.11: gold (idx_ut via a value-scan that didn't converge) and party (pick_live_sm
cap blown out by 1162 instances). Validating only the field that got fixed (gold) let party
slip through unnoticed. This gate closes the hole: it resolves via the embedded SEED (same as the
RC/stable 1st launch) and validates EVERY key metric LIVE, with PASS/FAIL and an exit code. It is the
MANDATORY validation step of the /meter-game-update skill — no build ships without PASS on everything.

VALIDATES (with the game OPEN and IN COMBAT on a stage):
  [calib/seed]  the embedded SEED covers the live build's fp -> fast path, no cold scan
  [gold]        AggregateManager resolves (idx from the seed) + live GoldEarn[SubKey1] > 0
  [party-live]  StageManager (pick_live_sm) resolves + 1..12 DEPLOYED heroes (not the save roster)
  [hero-class]  each deployed hero resolves a plausible EEquipClassType (classId) via hero_cat
  [save-build]  pick_live_psd + read_gold>0 + read_heroes>=1 (the SAVE path that broke on 1.00.12)
  [build-record] read_build (the heroes[] the run UPLOADS) >=1 hero AND >=1 with items[] OR skills[]
                 (proves ATTRIBUTES/ITEMS/EQUIPPED_* — not just HEROES) + read_account_snapshot
                 (runes/inventory/stash) not-all-None (proves RUNES/INVENTORY/STASH/ITEMS)
  [xp-live]     the deployed heroes have plausible live level/exp (HeroRuntime fakeValue)
  [dps]         MonsterSpawnManager + UnitHealthController: >=1 live monster with hp_max>0
  [stats]       StatsHolder.FINAL_STATS (DictFloat): >=1 hero with a dict of ~64 live stats
  [stage]       the LIVE stage key (Monster.STAGE_KEY) resolves an entry in the StageInfoData catalog
  [run-cycle]   LogManager resolves + LOG_LIST structurally readable (size>=0) — the run boundary
  [catalogs]    stage_info (incl. ACTBOSS x-10) + item_cat + hero_cat non-empty

USAGE (Windows, ADMIN, game open and IN COMBAT):  python reader\\scripts\\validate_live.py
Exit 0 = all PASS (safe to ship). Exit != 0 = some metric FAILed (do NOT ship). Tees to
validate_live_out.txt next to the file. Does NOT write to the game or the real resolve_cache.
"""
import os
import sys
import time

# bootstrap identical to seed_calib_capture.py: finds reader/ from the share root or from reader/scripts/.
_here = os.path.dirname(os.path.abspath(__file__))
_reader_root = next(
    (c for c in (os.path.join(_here, "reader"), _here, os.path.dirname(_here),
                 os.path.dirname(os.path.dirname(_here)))
     if os.path.isfile(os.path.join(c, "meter_windows.py"))),
    None,
)
if _reader_root is None:
    sys.exit("[x] meter_windows.py not found. Run from the tbh-meter-dev share root or from reader/scripts/.")
sys.path.insert(0, _reader_root)

import meter_windows as mw                                       # noqa: E402
from shared.memory import Reader, find_pid, open_process         # noqa: E402
from il2cpp import typeinfo                                      # noqa: E402
from metrics import gold                                         # noqa: E402
from game import save, build, models                             # noqa: E402
from config.offsets import CommonSaveData, List, LogManager, EEquipClassType  # noqa: E402

# Valid classId range = the REAL members of EEquipClassType (single-source: derived from the enum,
# not a literal). CLASS_TYPE is EEquipClassType, NEVER EHeroType (orphan) — see the obscured invariant.
_CLASS_IDS = {int(c) for c in EEquipClassType}


def main():
    _f = open(os.path.join(_here, "validate_live_out.txt"), "w", encoding="utf-8")

    def log(s=""):
        print(s)
        _f.write(s + "\n")
        _f.flush()

    pid = find_pid()
    if not pid:
        log("[x] game not open. Open the game, ENTER A STAGE (combat) and run again.")
        return 2
    handle = open_process(pid)
    if not handle:
        log("[x] OpenProcess failed — open the terminal as ADMINISTRATOR.")
        return 2
    reader = Reader(handle)
    gv = mw._detect_game_version(handle)
    ga_base0, _ = typeinfo.ga_module(pid)
    fp = typeinfo.build_fingerprint(reader, ga_base0, gv) if ga_base0 else None
    log(f"[ok] attached (pid {pid}) | build {gv} | fp {fp}")
    if not fp:
        log("[x] couldn't read the build fingerprint — can't validate.")
        return 2

    # Resolve via the embedded SEED: empty tmp cache -> load_calib falls back to the seed -> fast path,
    # exactly like the RC/stable 1st launch. Does NOT touch the real resolve_cache. If the seed doesn't
    # cover the fp, seed_calib=None (and resolve would fall into a cold scan) -> the [calib/seed] check
    # FAILS, a sign of a bad build.
    tmp_cache = os.path.join(_here, ".validate_live_cache.tmp.json")
    try:
        os.remove(tmp_cache)
    except OSError:
        pass
    seed_calib = mw.load_calib(tmp_cache, fp)   # empty tmp -> only hits if the embedded SEED covers the fp
    log("[..] resolving via the seed (fast path, ~s)...")
    t0 = time.time()
    (sc, sf, msm, lm, csd_list, psd_list, stage_info, item_cat, hero_cat,
     sm_list, gold_klass, gb, die, res) = mw.resolve_all(reader, pid, fp, tmp_cache)
    try:
        os.remove(tmp_cache)
    except OSError:
        pass
    log(f"[ok] resolved in {time.time() - t0:.0f}s\n")

    checks = []  # (name, ok, detail)

    # [calib/seed] the seed covers the fp -> fast path. None = the build would ship without a valid seed -> cold scan.
    checks.append(("calib/seed", seed_calib is not None,
                   (f"seed covers fp (idx_ut={seed_calib['idx_ut']})" if seed_calib
                    else f"seed does NOT cover fp {fp} → would fall into a cold scan")))

    # [gold] gold_klass resolved (via idx from the seed) + live GoldEarn[SubKey1] > 0 (not 0, not garbage).
    glive = gold.combat_gold_live(reader, gold_klass) if gold_klass else None
    checks.append(("gold", bool(gold_klass) and glive is not None and glive > 0,
                   f"klass={hex(gold_klass) if gold_klass else None} live={glive}"))

    # [party-live] StageManager resolves + 1..12 DEPLOYED heroes (the REAL party, not the save roster).
    sm = save.pick_live_sm(reader, sm_list)
    party = build.read_live_party(reader, sm) if sm else {}
    checks.append(("party-live", bool(sm) and 1 <= len(party) <= 12,
                   f"sm={'ok' if sm else 'NOT found'} deployed={len(party)} keys={sorted(party)}"))

    # [hero-class] each deployed hero resolves an EEquipClassType (HeroInfoData.CLASS_TYPE via hero_cat),
    # not EHeroType (orphan). Without this, CLASS_TYPE@0x48 could slip and the static diff never checks the
    # VALUE (matrix: HeroInfoData.CLASS_TYPE is S=✓/L=✗). classId must be a REAL member of EEquipClassType.
    cls_ids = [hero_cat.get(hk) for hk in party]
    cls_ok = bool(party) and all(c in _CLASS_IDS for c in cls_ids)
    checks.append(("hero-class", cls_ok,
                   (f"classIds={cls_ids}" if party else "no live party (in combat?)")))

    # [save-build] the run BUILD (heroes/items/runes) comes from the SAVE (pick_live_psd + read_heroes),
    # NOT from the live party above. This is WHERE 1.00.12 broke and shipped green: the bucket-box shifted
    # the PlayerSaveData lists (+0x10) → read_gold=0 → pick_live_psd=None → read_heroes={} →
    # the run goes out with heroes=[] → the app doesn't upload (eligible requires heroes>0) → empty session.
    # [party-live] (the LIVE path) passed and MASKED this. This check exercises the SAVE path.
    psd = save.pick_live_psd(reader, psd_list)
    save_gold = save.read_gold(reader, psd) if psd else 0
    save_heroes = save.read_heroes(reader, psd) if psd else {}
    checks.append(("save-build", bool(psd) and save_gold > 0 and len(save_heroes) >= 1,
                   f"psd={'ok' if psd else 'None'} saveGold={save_gold} saveHeroes={len(save_heroes)}"))

    # [build-record] the heroes[] the run ACTUALLY uploads doesn't come from read_heroes (above, just roster
    # sanity) nor from the live party — it comes from build.read_build, a THIRD read of the save that
    # re-derefs ATTRIBUTES/ITEMS/EQUIPPED_ITEMS/EQUIPPED_SKILLS to assemble each hero's gear+skills+level. A
    # shift in any of those lists leaves heroes.length>0 (upload PASSES) yet EVERY hero goes up with empty
    # items[]/skills[] — silent fleet-wide gear loss, invisible to [save-build] and [party-live].
    # Requires >=1 hero AND >=1 with non-empty items[] OR skills[] (proves the lists beyond HEROES resolve).
    # And read_account_snapshot (runes/inventory/stash): if ALL THREE come back None, the snapshot path is
    # dead (RUNES/INVENTORY/STASH/ITEMS shifted) — silent empty inventory/stash on every run.
    build_recs = build.read_build(reader, psd, item_cat, hero_cat) if psd else []
    geared = sum(1 for h in build_recs if h.get("items") or h.get("skills"))
    snap = build.read_account_snapshot(reader, psd, item_cat) if psd else (None, None, None)
    snap_alive = any(x is not None for x in snap)
    checks.append(("build-record", len(build_recs) >= 1 and geared >= 1 and snap_alive,
                   f"heroes={len(build_recs)} withGearOrSkills={geared} "
                   f"snapshot(runes/inv/stash)={[None if x is None else len(x) for x in snap]}"))

    # [xp-live] the deployed heroes have plausible live level/exp (HeroRuntime fakeValue; read_live_party gates).
    xp_ok = bool(party) and all(0 < lvl <= 999 and exp >= 0 for lvl, exp in party.values())
    checks.append(("xp-live", xp_ok,
                   (f"{len(party)} heroes w/ valid level/exp" if party else "no live party (in combat?)")))

    # [dps] MonsterSpawnManager + UnitHealthController: DPS = Σ of monster HP drops. models.live_monsters
    # iterates (unit, hp_cur, hp_max) reading MONSTER_LIST/SUMMONED_LIST + Unit.HEALTH_CONTROLLER + HP@0x40/0x4C.
    # NEVER exercised live before (matrix: DPS is L=✗) → a MONSTER_LIST/HP shift left dps=0 silently
    # across the fleet. Requires >=1 live monster with hp_max>0 (proves the whole chain: list + HealthController + HP).
    mons = list(models.live_monsters(reader, msm)) if msm else []
    dps_ok = any(hp_max and hp_max > 0 for _u, _cur, hp_max in mons)
    checks.append(("dps", dps_ok,
                   f"msm={'ok' if msm else 'None'} monsters={len(mons)} withHpMax={sum(1 for _u, _c, m in mons if m and m > 0)}"))

    # [stats] StatsHolder.FINAL_STATS (Dict<StatType,float>, DictFloat 0x10/@0xC): the 64 live FINAL stats per
    # hero. NEVER validated live (matrix: FINAL_STATS is L=✗) → a shifted StatsHolder/FINAL_STATS, or the
    # DictFloat geometry confused with Dict8B, gave silent empty/garbage stats. Requires >=1 hero with a
    # reasonably full dict (>=32 of the 64 entries) — catches both the dead dict ([]) and a truncated/misaligned read.
    stats_by_hero = build.read_live_stats_by_hero(reader, sm) if sm else {}
    stats_sizes = {hk: len(d) for hk, d in stats_by_hero.items()}
    stats_ok = any(n >= 32 for n in stats_sizes.values())
    checks.append(("stats", stats_ok, f"heroesWithStats={len(stats_by_hero)} sizes={sorted(stats_sizes.values())}"))

    # [stage] the LIVE stage key (Monster.STAGE_KEY — the source the overlay AND the run record
    # actually use) resolves a catalog entry. The save SNAPSHOT (CommonSaveData.currentStageKey via
    # pick_live_csd) is only a fallback seed: it freezes on a stage switch AND the CommonSaveData type
    # scan can match false positives (1.00.17: a garbage instance read key=6775040, pt=3.77e19), so it
    # is surfaced for diagnostics but the LIVE key is what gates — never validate the stale snapshot in
    # isolation (that is what made this check spuriously red on a correctly-calibrated 1.00.17 seed).
    live_sk = models.live_stage_key(reader, msm) if msm else None
    csd = save.pick_live_csd(reader, csd_list, stage_info)
    snap = reader.ri32(csd + CommonSaveData.CURRENT_STAGE_KEY) if csd else None
    live_ok = live_sk is not None and live_sk in (stage_info or {})
    checks.append(("stage", bool(stage_info) and live_ok,
                   f"live={live_sk} ({'in' if live_ok else 'OUTSIDE'} catalog) snapshot={snap}"))

    # [run-cycle] LogManager resolves + LOG_LIST structurally readable. The end of EVERY run is detected by
    # the LOG_LIST growing (LogManager.LOG_LIST@0x20, size@List.SIZE); a badly-resolved LogManager or a
    # shifted LOG_LIST = the list never grows = NO run closes (the "runs don't close" class, caused once
    # by a garbage size=0 shadowing the real one). validate_live resolved the lm but never read the LOG_LIST
    # (matrix: LogManager.LOG_LIST is L=✗). Mirrors meter_windows: rptr(LOG_LIST) -> ri32(SIZE), requires size>=0 readable.
    ll = reader.rptr(lm + LogManager.LOG_LIST) if lm else None
    ll_size = reader.ri32(ll + List.SIZE) if ll else None
    checks.append(("run-cycle", bool(lm) and ll is not None and ll_size is not None and ll_size >= 0,
                   f"lm={'ok' if lm else 'None'} logList={'ok' if ll else 'None'} size={ll_size}"))

    # [catalogs] non-empty, incl. ACTBOSS x-10 (mobs==0) — otherwise x-10 would show '?'.
    actboss = sum(1 for v in (stage_info or {}).values() if v[2] == 0)
    checks.append(("catalogs",
                   len(stage_info) > 0 and len(item_cat) > 0 and len(hero_cat) > 0 and actboss > 0,
                   f"stages={len(stage_info)} (ACTBOSS={actboss}) items={len(item_cat)} heroes={len(hero_cat)}"))

    log("===== LIVE VALIDATION (build {}) =====".format(gv))
    for name, ok, detail in checks:
        log(f"  [{'PASS' if ok else 'FAIL'}] {name:13s} — {detail}")
    all_pass = all(ok for _, ok, _ in checks)
    log("")
    if all_pass:
        log("[OK] ✅ ALL PASS — the build resolves every metric live via the seed. Safe to ship.")
        return 0
    fails = [n for n, ok, _ in checks if not ok]
    log(f"[x] ❌ FAIL on: {', '.join(fails)} — do NOT ship. Almost EVERY check needs the game IN COMBAT "
        f"on a stage with the party deployed (party/hero-class/build-record/xp/dps/stats/stage). If you ran "
        f"out of combat, enter a stage and run again; if it persists in combat, it's a real regression.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
