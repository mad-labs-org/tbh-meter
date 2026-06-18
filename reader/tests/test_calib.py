"""Tests for the build-stable calibration cache (load_calib/save_calib).

Pure file-I/O functions (they don't touch game memory) → run on the mac. They cover:
  - round-trip save→load (anchor_rva, indices, idx_ut, catalogs preserved with the right types);
  - completeness persist-gate (empty catalog → NOT persisted);
  - atomic write (tmp+os.replace, no residual .tmp; merge preserves other fps);
  - tolerance for old JSON (fmt != CACHE_FMT → None → caller recalibrates);
  - stage_info sanity at both gates (_stage_info_ok: save doesn't persist a catalog with an
    invalid diff; load rejects a poisoned cache → self-heals via seed/scan);
  - completeness-vs-seed at both gates (amendment R3, _covers_seed_keys: a catalog with a HOLE
    — a key the seed for the same fp has and the candidate doesn't — neither persists nor shadows
    the seed; key presence ONLY, the local value always wins when present).
"""

import json
import os

import pytest

import meter_windows
from meter_windows import CACHE_FMT, _read_calib, load_calib, save_calib

FP = "1.00.07-0x6a203f51-0x62ea000"
ANCHOR_RVA = 0x5B070E0
INDICES = {"StageManager": 2592, "LogManager": 2831, "MonsterSpawnManager": 2931}
IDX_UT = 2744
# rows = (act, stage_no, horda, diff); diff must be a real EStageDifficulty (0..3).
# POISONED = the shape of the "?" mode bug (diff -1 written when the read failed): it must be
# REJECTED by both gates (_stage_info_ok in save AND in load).
STAGE_INFO = {1001: (1, 1, 50, 0), 1002: (1, 2, 60, 3)}
POISONED_STAGE_INFO = {1001: (1, 1, 50, 0), 1002: (1, 2, 60, -1)}
ITEM_CAT = {30001: (3, 2, 5), 30002: (1, 0, 0)}
HERO_CAT = {601: 1, 602: None}
# Catalogs with a HOLE: a STRICT subset of the seed's — every row is VALID (passes the VALUE
# gates, _stage_info_ok/len>0); only the COMPLETENESS-vs-seed gate catches them.
HOLEY_STAGE_INFO = {1001: (1, 1, 50, 0)}                  # missing the 1002 the seed has
HOLEY_ITEM_CAT = {30001: (3, 2, 5)}                       # missing the 30002 the seed has
HOLEY_HERO_CAT = {601: 1}                                 # missing the 602 the seed has
SUPERSET_STAGE_INFO = {**STAGE_INFO, 1003: (1, 3, 70, 2)}  # an EXTRA key beyond the seed
SEED_ANCHOR = 0x5EED   # anchor DISTINCT from the cache's → the asserts prove provenance


def _path(tmp_path):
    return os.path.join(str(tmp_path), "resolve_cache.json")


@pytest.fixture(autouse=True)
def _seed_isolated(tmp_path, monkeypatch):
    """Isolates ALL tests from the embedded SEED (config/calib_seed.json): by default points
    _seed_path at a nonexistent file, so these tests exercise the PURE cache
    DETERMINISTICALLY (without depending on which fp the committed seed covers). TestSeedFallback
    overrides this explicitly to prove the fallback."""
    monkeypatch.setattr(meter_windows, "_seed_path",
                        lambda: os.path.join(str(tmp_path), "_absent_seed.json"))


class TestRoundTrip:
    def test_save_then_load_preserves_everything(self, tmp_path):
        path = _path(tmp_path)
        save_calib(path, FP, ANCHOR_RVA, INDICES, IDX_UT, STAGE_INFO, ITEM_CAT, HERO_CAT)
        out = load_calib(path, FP)
        assert out is not None
        assert out["anchor_rva"] == ANCHOR_RVA
        assert out["idx_ut"] == IDX_UT
        assert out["indices"] == INDICES
        assert out["stage_info"] == STAGE_INFO
        assert out["item_cat"] == ITEM_CAT
        assert out["hero_cat"] == HERO_CAT

    def test_load_reconstructs_int_keys_and_tuple_values(self, tmp_path):
        path = _path(tmp_path)
        save_calib(path, FP, ANCHOR_RVA, INDICES, IDX_UT, STAGE_INFO, ITEM_CAT, HERO_CAT)
        out = load_calib(path, FP)
        # catalogs: int keys, tuple values (not str/list) — ready for direct consumption
        assert all(isinstance(k, int) for k in out["stage_info"])
        assert all(isinstance(v, tuple) for v in out["stage_info"].values())
        assert all(isinstance(k, int) for k in out["item_cat"])
        assert all(isinstance(v, tuple) for v in out["item_cat"].values())
        assert all(isinstance(k, int) for k in out["hero_cat"])
        # indices: int values
        assert all(isinstance(v, int) for v in out["indices"].values())

    def test_hero_cat_none_value_survives(self, tmp_path):
        path = _path(tmp_path)
        save_calib(path, FP, ANCHOR_RVA, INDICES, IDX_UT, STAGE_INFO, ITEM_CAT, HERO_CAT)
        out = load_calib(path, FP)
        assert out["hero_cat"][602] is None


class TestPersistGate:
    def test_empty_stage_info_not_persisted(self, tmp_path):
        path = _path(tmp_path)
        save_calib(path, FP, ANCHOR_RVA, INDICES, IDX_UT, {}, ITEM_CAT, HERO_CAT)
        assert not os.path.exists(path)
        assert load_calib(path, FP) is None

    def test_empty_item_cat_not_persisted(self, tmp_path):
        path = _path(tmp_path)
        save_calib(path, FP, ANCHOR_RVA, INDICES, IDX_UT, STAGE_INFO, {}, HERO_CAT)
        assert load_calib(path, FP) is None

    def test_empty_hero_cat_not_persisted(self, tmp_path):
        path = _path(tmp_path)
        save_calib(path, FP, ANCHOR_RVA, INDICES, IDX_UT, STAGE_INFO, ITEM_CAT, {})
        assert load_calib(path, FP) is None

    def test_incomplete_does_not_clobber_existing(self, tmp_path):
        path = _path(tmp_path)
        save_calib(path, FP, ANCHOR_RVA, INDICES, IDX_UT, STAGE_INFO, ITEM_CAT, HERO_CAT)
        # a later incomplete calibration must NOT wipe out the good one
        save_calib(path, FP, ANCHOR_RVA, INDICES, IDX_UT, {}, {}, {})
        out = load_calib(path, FP)
        assert out is not None
        assert out["anchor_rva"] == ANCHOR_RVA

    def test_invalid_diff_stage_info_not_persisted(self, tmp_path):
        # amendment R2: stage_info with an invalid-diff row (-1) does NOT persist — a scan
        # misread never becomes a calibration served forever (permanent "?" mode)
        path = _path(tmp_path)
        save_calib(path, FP, ANCHOR_RVA, INDICES, IDX_UT,
                   POISONED_STAGE_INFO, ITEM_CAT, HERO_CAT)
        assert not os.path.exists(path)
        assert load_calib(path, FP) is None


class TestAtomicityAndMerge:
    def test_no_tmp_left_behind(self, tmp_path):
        path = _path(tmp_path)
        save_calib(path, FP, ANCHOR_RVA, INDICES, IDX_UT, STAGE_INFO, ITEM_CAT, HERO_CAT)
        assert not os.path.exists(path + ".tmp")

    def test_merge_preserves_other_fingerprints(self, tmp_path):
        path = _path(tmp_path)
        fp2 = "1.00.08-0xdeadbeef-0x63ea000"
        save_calib(path, FP, ANCHOR_RVA, INDICES, IDX_UT, STAGE_INFO, ITEM_CAT, HERO_CAT)
        save_calib(path, fp2, 0x999, {"StageManager": 100}, 200, STAGE_INFO, ITEM_CAT, HERO_CAT)
        a = load_calib(path, FP)
        b = load_calib(path, fp2)
        assert a["anchor_rva"] == ANCHOR_RVA
        assert b["anchor_rva"] == 0x999
        assert b["indices"]["StageManager"] == 100

    def test_resave_same_fp_overwrites(self, tmp_path):
        path = _path(tmp_path)
        save_calib(path, FP, ANCHOR_RVA, INDICES, IDX_UT, STAGE_INFO, ITEM_CAT, HERO_CAT)
        save_calib(path, FP, 0x111, INDICES, IDX_UT, STAGE_INFO, ITEM_CAT, HERO_CAT)
        out = load_calib(path, FP)
        assert out["anchor_rva"] == 0x111

    def test_written_file_has_current_fmt(self, tmp_path):
        path = _path(tmp_path)
        save_calib(path, FP, ANCHOR_RVA, INDICES, IDX_UT, STAGE_INFO, ITEM_CAT, HERO_CAT)
        doc = json.load(open(path, encoding="utf-8"))
        assert doc["fmt"] == CACHE_FMT
        assert FP in doc["calib"]


class TestTolerateOldJson:
    def test_old_fmt_returns_none(self, tmp_path):
        path = _path(tmp_path)
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"fmt": 7, "sc_class": 123}, f)
        assert load_calib(path, FP) is None

    def test_missing_fp_returns_none(self, tmp_path):
        path = _path(tmp_path)
        save_calib(path, FP, ANCHOR_RVA, INDICES, IDX_UT, STAGE_INFO, ITEM_CAT, HERO_CAT)
        assert load_calib(path, "unknown-fp") is None

    def test_missing_file_returns_none(self, tmp_path):
        assert load_calib(_path(tmp_path), FP) is None

    def test_corrupt_json_returns_none(self, tmp_path):
        path = _path(tmp_path)
        with open(path, "w", encoding="utf-8") as f:
            f.write("{not valid json")
        assert load_calib(path, FP) is None

    def test_non_dict_json_returns_none(self, tmp_path):
        # VALID JSON but of the wrong shape (non-dict top-level, or non-dict calib): the
        # c.get/.get(fp) used to raise AttributeError OUTSIDE the try. _read_calib must be
        # TOTAL (never raise) — save_calib's completeness-vs-seed gate calls it BEFORE
        # save_calib's try, and _calibrate promises it "NEVER breaks the flow".
        path = _path(tmp_path)
        for doc in ([], {"fmt": CACHE_FMT, "calib": []}):
            with open(path, "w", encoding="utf-8") as f:
                json.dump(doc, f)
            assert _read_calib(path, FP) is None, f"doc={doc!r}"
            assert load_calib(path, FP) is None, f"doc={doc!r}"

    def test_save_over_old_fmt_resets_to_current(self, tmp_path):
        path = _path(tmp_path)
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"fmt": 7, "sc_class": 123}, f)
        save_calib(path, FP, ANCHOR_RVA, INDICES, IDX_UT, STAGE_INFO, ITEM_CAT, HERO_CAT)
        doc = json.load(open(path, encoding="utf-8"))
        assert doc["fmt"] == CACHE_FMT
        assert "sc_class" not in doc   # stale legacy field dropped on the fmt change
        assert load_calib(path, FP) is not None


class TestSeedFallback:
    """Embedded SEED (seed-calib): load_calib falls back to config/calib_seed.json when the
    user's cache doesn't cover the fp. Invariants: zero new trust (the user's cache has
    PRIORITY), fp-gated (a seed from another build = MISS → None → scan), absent = None."""

    def test_seed_used_when_user_cache_misses(self, tmp_path, monkeypatch):
        # user cache absent; seed covers the fp -> use the seed (skips the scan on 1st launch)
        _write_seed(tmp_path, monkeypatch, FP)
        out = load_calib(_path(tmp_path), FP)
        assert out is not None
        assert out["anchor_rva"] == ANCHOR_RVA and out["idx_ut"] == IDX_UT
        assert out["stage_info"] == STAGE_INFO   # catalogs come from the seed, types reconstructed

    def test_user_cache_wins_over_seed(self, tmp_path, monkeypatch):
        # seed and cache cover the SAME fp with different anchors -> the user's cache has priority
        # (cache covers every seed key → the completeness-vs-seed gate does NOT interfere)
        _write_seed(tmp_path, monkeypatch, FP, anchor_rva=0xBADBAD)
        save_calib(_path(tmp_path), FP, 0x111, INDICES, IDX_UT, STAGE_INFO, ITEM_CAT, HERO_CAT)
        out = load_calib(_path(tmp_path), FP)
        assert out["anchor_rva"] == 0x111   # from the learned cache, NOT the seed

    def test_seed_fp_miss_returns_none(self, tmp_path, monkeypatch):
        # seed only covers ANOTHER fp -> miss on the requested fp -> None (degrades to scan, never poisons)
        _write_seed(tmp_path, monkeypatch, "1.00.99-0x0-0x0")
        assert load_calib(_path(tmp_path), FP) is None

    def test_missing_seed_file_returns_none(self, tmp_path, monkeypatch):
        monkeypatch.setattr(meter_windows, "_seed_path",
                            lambda: os.path.join(str(tmp_path), "nope.json"))
        assert load_calib(_path(tmp_path), FP) is None


def _write_calib_raw(path, fp, stage_info, anchor_rva=ANCHOR_RVA,
                     item_cat=None, hero_cat=None):
    """Writes a calib[fp] DIRECTLY into the JSON (bypassing save_calib's persist-gate) — simulates
    the cache an old reader version wrote (e.g. stage_info with diff -1, the \"?\" mode bug;
    or a catalog with a HOLE, persisted before the completeness-vs-seed gate existed)."""
    item_cat = ITEM_CAT if item_cat is None else item_cat
    hero_cat = HERO_CAT if hero_cat is None else hero_cat
    entry = {"anchor_rva": anchor_rva, "indices": INDICES, "idx_ut": IDX_UT,
             "stage_info": {str(k): list(v) for k, v in stage_info.items()},
             "item_cat": {str(k): list(v) for k, v in item_cat.items()},
             "hero_cat": {str(k): v for k, v in hero_cat.items()}}
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"fmt": CACHE_FMT, "calib": {fp: entry}}, f)


def _write_seed(tmp_path, monkeypatch, fp, **over):
    """Writes a fake calib_seed.json covering `fp` and points _seed_path at it (overriding
    _seed_isolated). `over` overrides entry keys (e.g. anchor_rva=SEED_ANCHOR to prove
    provenance, stage_info/item_cat already serialized when passed raw)."""
    seed = os.path.join(str(tmp_path), "calib_seed.json")
    entry = {"anchor_rva": ANCHOR_RVA, "indices": INDICES, "idx_ut": IDX_UT,
             "stage_info": {str(k): list(v) for k, v in STAGE_INFO.items()},
             "item_cat": {str(k): list(v) for k, v in ITEM_CAT.items()},
             "hero_cat": {str(k): v for k, v in HERO_CAT.items()}}
    entry.update(over)
    with open(seed, "w", encoding="utf-8") as f:
        json.dump({"fmt": CACHE_FMT, "calib": {fp: entry}}, f)
    monkeypatch.setattr(meter_windows, "_seed_path", lambda: seed)
    return seed


class TestPoisonedCatalogSelfHeal:
    """Self-heal of a poisoned cache (the real bug: an old reader wrote stage_info with diff -1
    into resolve_cache.json → \"?\" mode on every run, surviving restarts). The load-gate
    (_stage_info_ok in _read_calib) REJECTS the block → load_calib falls back to the embedded
    seed; with no seed, None → scan, which re-calibrates and OVERWRITES calib[fp]. No deleting
    the cache by hand and no CACHE_FMT bump (the shape didn't change; it's VALUE validation). The
    HOLE variant (a valid but incomplete-vs-seed catalog) heals via the completeness-vs-seed gate."""

    def test_poisoned_user_cache_rejected(self, tmp_path):
        path = _path(tmp_path)
        _write_calib_raw(path, FP, POISONED_STAGE_INFO)
        # no seed (fixture _seed_isolated): rejects → None → caller degrades to scan
        assert load_calib(path, FP) is None

    def test_poisoned_user_cache_falls_through_to_seed(self, tmp_path, monkeypatch):
        # the reported player's case: poisoned cache + GOOD seed from the same build →
        # the seed serves the healthy catalog on the SAME launch (mode comes back with no cold scan)
        path = _path(tmp_path)
        _write_calib_raw(path, FP, POISONED_STAGE_INFO, anchor_rva=0xBADBAD)
        _write_seed(tmp_path, monkeypatch, FP)
        out = load_calib(path, FP)
        assert out is not None
        assert out["anchor_rva"] == ANCHOR_RVA          # came from the SEED, not the rotten cache
        assert out["stage_info"] == STAGE_INFO

    def test_holey_user_cache_healed_by_seed_same_load(self, tmp_path, monkeypatch):
        # the RECURRENCE on the user's machine: a future scan misread now DROPS the row
        # (the per-row gate in _read_catalogs) → a catalog with a HOLE that passes ALL the
        # value gates; if served, it would shadow the good seed forever (nothing re-triggers
        # a scan → "?" mode on that stage until the cache is deleted by hand). The
        # completeness-vs-seed gate (amendment R3) heals it ON THE SAME load: serves the healthy seed.
        path = _path(tmp_path)
        _write_calib_raw(path, FP, HOLEY_STAGE_INFO, anchor_rva=0xBADBAD)
        _write_seed(tmp_path, monkeypatch, FP, anchor_rva=SEED_ANCHOR)
        out = load_calib(path, FP)
        assert out is not None
        assert out["anchor_rva"] == SEED_ANCHOR         # came from the SEED, not the holey cache
        assert out["stage_info"] == STAGE_INFO          # complete catalog, no hole

    def test_rescan_overwrites_poisoned_entry(self, tmp_path):
        # the scan re-calibrates (save_calib) over the poisoned fp → the next launch returns
        # to the fast path with a healthy catalog
        path = _path(tmp_path)
        _write_calib_raw(path, FP, POISONED_STAGE_INFO)
        save_calib(path, FP, ANCHOR_RVA, INDICES, IDX_UT, STAGE_INFO, ITEM_CAT, HERO_CAT)
        out = load_calib(path, FP)
        assert out is not None
        assert out["stage_info"] == STAGE_INFO

    def test_empty_stage_info_in_cache_rejected(self, tmp_path):
        # an empty catalog coming from a file (written outside the persist-gate) isn't served either
        path = _path(tmp_path)
        _write_calib_raw(path, FP, {})
        assert load_calib(path, FP) is None


class TestSeedCoverageGateLoad:
    """COMPLETENESS-vs-seed gate on LOAD (amendment R3): for the SAME fp, the shipped seed is
    ground truth for WHICH keys exist (catalogs are build constants). A cache whose catalogs
    have lost a key the seed has = HOLE → load_calib serves the SEED (with a log line).
    Key presence ONLY: a local extra key passes; the local value is never compared (a good cache
    with different values wins — guards against a hypothetically stale seed)."""

    def test_cache_missing_seed_stage_key_serves_seed(self, tmp_path, monkeypatch, capsys):
        _write_seed(tmp_path, monkeypatch, FP, anchor_rva=SEED_ANCHOR)
        _write_calib_raw(_path(tmp_path), FP, HOLEY_STAGE_INFO)
        out = load_calib(_path(tmp_path), FP)
        assert out is not None
        assert out["anchor_rva"] == SEED_ANCHOR     # served the SEED, not the holey cache
        assert out["stage_info"] == STAGE_INFO
        # the log names WHICH catalog has the hole (remote triage via meter.log)
        assert "missing seed keys: stage_info=1" in capsys.readouterr().out

    def test_cache_missing_seed_item_key_serves_seed(self, tmp_path, monkeypatch):
        # the gate covers all THREE catalogs — a hole in item_cat is rejected too
        _write_seed(tmp_path, monkeypatch, FP, anchor_rva=SEED_ANCHOR)
        _write_calib_raw(_path(tmp_path), FP, STAGE_INFO, item_cat=HOLEY_ITEM_CAT)
        out = load_calib(_path(tmp_path), FP)
        assert out["anchor_rva"] == SEED_ANCHOR
        assert out["item_cat"] == ITEM_CAT

    def test_cache_missing_seed_hero_key_serves_seed(self, tmp_path, monkeypatch):
        # ...and a hole in hero_cat too (closes the trio)
        _write_seed(tmp_path, monkeypatch, FP, anchor_rva=SEED_ANCHOR)
        _write_calib_raw(_path(tmp_path), FP, STAGE_INFO, hero_cat=HOLEY_HERO_CAT)
        out = load_calib(_path(tmp_path), FP)
        assert out["anchor_rva"] == SEED_ANCHOR
        assert out["hero_cat"] == HERO_CAT

    def test_cache_with_extra_keys_beyond_seed_served(self, tmp_path, monkeypatch):
        # a local EXTRA key always passes (presence-only): it covers the seed and has more → cache wins
        _write_seed(tmp_path, monkeypatch, FP, anchor_rva=SEED_ANCHOR)
        _write_calib_raw(_path(tmp_path), FP, SUPERSET_STAGE_INFO)
        out = load_calib(_path(tmp_path), FP)
        assert out["anchor_rva"] == ANCHOR_RVA      # the user's cache, NOT the seed
        assert out["stage_info"] == SUPERSET_STAGE_INFO

    def test_no_seed_serves_cache_as_is(self, tmp_path):
        # with no seed (fixture _seed_isolated) there's no reference → no restriction: a holey
        # cache is served as it is today (can't prove it's worse without ground truth)
        _write_calib_raw(_path(tmp_path), FP, HOLEY_STAGE_INFO)
        out = load_calib(_path(tmp_path), FP)
        assert out is not None
        assert out["anchor_rva"] == ANCHOR_RVA

    def test_seed_not_covering_fp_serves_cache_as_is(self, tmp_path, monkeypatch):
        # seed covers ANOTHER fp → reference miss for the requested fp → cache served as is
        _write_seed(tmp_path, monkeypatch, "1.00.99-0x0-0x0")
        out_missing = load_calib(_path(tmp_path), FP)
        assert out_missing is None                  # no cache either: both None → None
        _write_calib_raw(_path(tmp_path), FP, HOLEY_STAGE_INFO)
        out = load_calib(_path(tmp_path), FP)
        assert out is not None
        assert out["anchor_rva"] == ANCHOR_RVA


class TestSeedCoverageGatePersist:
    """COMPLETENESS-vs-seed gate on PERSIST (amendment R3): with a seed covering the fp, a scan
    whose catalogs don't have every seed key does NOT persist (a misread with a dropped row never
    becomes a calibration; the seed keeps serving on the next launches). With no seed for the fp,
    it persists exactly as before."""

    def test_holey_stage_info_not_persisted_when_seed_covers_fp(self, tmp_path, monkeypatch):
        _write_seed(tmp_path, monkeypatch, FP)
        save_calib(_path(tmp_path), FP, ANCHOR_RVA, INDICES, IDX_UT,
                   HOLEY_STAGE_INFO, ITEM_CAT, HERO_CAT)
        assert not os.path.exists(_path(tmp_path))

    def test_holey_item_cat_not_persisted_when_seed_covers_fp(self, tmp_path, monkeypatch):
        _write_seed(tmp_path, monkeypatch, FP)
        save_calib(_path(tmp_path), FP, ANCHOR_RVA, INDICES, IDX_UT,
                   STAGE_INFO, HOLEY_ITEM_CAT, HERO_CAT)
        assert not os.path.exists(_path(tmp_path))

    def test_holey_hero_cat_not_persisted_when_seed_covers_fp(self, tmp_path, monkeypatch):
        # the gate covers all THREE catalogs on persist too (closes the trio)
        _write_seed(tmp_path, monkeypatch, FP)
        save_calib(_path(tmp_path), FP, ANCHOR_RVA, INDICES, IDX_UT,
                   STAGE_INFO, ITEM_CAT, HOLEY_HERO_CAT)
        assert not os.path.exists(_path(tmp_path))

    def test_save_calib_with_malformed_seed_never_raises(self, tmp_path, monkeypatch):
        # the new reachability of _read_calib: the completeness gate calls it OUTSIDE
        # save_calib's try — a malformed seed (non-dict top-level) must not break
        # _calibrate ("NEVER breaks the flow"); becomes None → no reference → persists
        seed = os.path.join(str(tmp_path), "calib_seed.json")
        with open(seed, "w", encoding="utf-8") as f:
            json.dump([], f)
        monkeypatch.setattr(meter_windows, "_seed_path", lambda: seed)
        save_calib(_path(tmp_path), FP, ANCHOR_RVA, INDICES, IDX_UT,
                   STAGE_INFO, ITEM_CAT, HERO_CAT)
        out = load_calib(_path(tmp_path), FP)
        assert out is not None
        assert out["anchor_rva"] == ANCHOR_RVA

    def test_holey_persist_does_not_clobber_good_seed_serving(self, tmp_path, monkeypatch):
        # the full refusal cycle: persist refused → load serves the healthy seed
        _write_seed(tmp_path, monkeypatch, FP, anchor_rva=SEED_ANCHOR)
        save_calib(_path(tmp_path), FP, ANCHOR_RVA, INDICES, IDX_UT,
                   HOLEY_STAGE_INFO, ITEM_CAT, HERO_CAT)
        out = load_calib(_path(tmp_path), FP)
        assert out["anchor_rva"] == SEED_ANCHOR
        assert out["stage_info"] == STAGE_INFO

    def test_no_seed_for_fp_persists_as_today(self, tmp_path, monkeypatch):
        # seed covers ANOTHER fp → no reference → persists as always (new pre-seed build)
        _write_seed(tmp_path, monkeypatch, "1.00.99-0x0-0x0")
        save_calib(_path(tmp_path), FP, ANCHOR_RVA, INDICES, IDX_UT,
                   HOLEY_STAGE_INFO, ITEM_CAT, HERO_CAT)
        out = load_calib(_path(tmp_path), FP)
        assert out is not None
        assert out["stage_info"] == HOLEY_STAGE_INFO

    def test_superset_of_seed_persists(self, tmp_path, monkeypatch):
        # an extra key beyond the seed passes (presence-only) → the local calibration persists and wins
        _write_seed(tmp_path, monkeypatch, FP, anchor_rva=SEED_ANCHOR)
        save_calib(_path(tmp_path), FP, 0x111, INDICES, IDX_UT,
                   SUPERSET_STAGE_INFO, ITEM_CAT, HERO_CAT)
        out = load_calib(_path(tmp_path), FP)
        assert out["anchor_rva"] == 0x111
        assert out["stage_info"] == SUPERSET_STAGE_INFO
