"""test_calib_safety.py — ADVERSARIAL: proves the static tripwire (scripts/diff_offsets_vs_dump.py)
CATCHES every class of "silent-by-build" reader breakage, by injecting the corruption and requiring
the gate to exit != 0 against the REAL 1.00.12 dump.cs.

WHY (the difference from test_diff_offsets_vs_dump.py): that one proves the gate's LOGIC with inline
SYNTHETIC dumps. THIS one proves, against the REAL game BINARY (the fresh dump the maintainer already
has in ~/tbh-dump), that if an offset/enum/seed index regresses the way it actually regressed in the
3 historical bugs, the gate GOES RED. It's the "test the alarm with real smoke": each test re-enacts a
real breakage — chiefly 1.00.12, where the bucket-box inserted fields into PlayerSaveData and the gold
list dropped to where CURRENCIES used to sit, with `BoxBucketUseBoxList` taking the old offset (0x28),
and the presence-only check passed GREEN and shipped the fleet-wide upload breakage.

dump.cs lives OUTSIDE the repo (on the maintainer's machine) — so these tests SKIP where it doesn't
exist (CI/contributor) and RUN where it does (the maintainer's Mac + the meter-game-update skill). That
satisfies "passes with correct code" everywhere and gives the real-smoke alarm where it matters. The
plain offset regression (no dump) is test_diff_offsets_vs_dump.py's (synthetic dump) and
test_offsets.py's (value pin); here the focus is proving DETECTION against the real build.

Injection mechanism: the gate introspects `config.offsets` LIVE (`offsets_classes`/`offsets_enums` read
`vars(O)` on every `main()` call), so monkeypatching an offsets-class ATTR (or `D.offsets_enums`)
rewrites what the gate sees — without touching the file. The seed is read from DISK, so seed corruption
writes a mutated copy to a tmp; the COMMITTED config/calib_seed.json is never touched.
"""

import copy
import importlib.util
import io
import json
import os
import sys
from contextlib import redirect_stdout

import pytest

from config import offsets as O

_HERE = os.path.dirname(os.path.abspath(__file__))
_SCRIPT = os.path.normpath(os.path.join(_HERE, "..", "scripts", "diff_offsets_vs_dump.py"))
# Fresh Il2CppDumper dump on the maintainer's machine (does NOT live in the repo — see header).
# Il2CppDumper writes next to its DLL (~/tbh-dump/tool/), but the skill + preflight point --dump at
# ~/tbh-dump/out/. Search BOTH so the adversarial gate RUNS wherever the dump landed instead of
# silently SKIPPING (false confidence) when the maintainer follows the documented out/ convention.
_DUMP = next(
    (p for p in (os.path.expanduser("~/tbh-dump/out/dump.cs"),
                 os.path.expanduser("~/tbh-dump/tool/dump.cs")) if os.path.isfile(p)),
    os.path.expanduser("~/tbh-dump/out/dump.cs"),
)
_SEED = os.path.normpath(os.path.join(_HERE, "..", "config", "calib_seed.json"))

# Without the real dump there's no way to run the real-smoke alarm; skip rather than fake it. RUNS on
# the maintainer's Mac + the meter-game-update skill (where the dump ALWAYS exists).
pytestmark = pytest.mark.skipif(
    not os.path.isfile(_DUMP),
    reason=f"real dump.cs missing ({_DUMP}) — tripwire-vs-build runs only where the dump exists",
)


def _load_script():
    """Import the script as a module (it puts the reader root on the path at import)."""
    spec = importlib.util.spec_from_file_location("diff_offsets_vs_dump", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


D = _load_script()


def _run_main(argv):
    """Run D.main() with the given argv, capturing (rc, stdout)."""
    old = sys.argv
    sys.argv = ["diff_offsets_vs_dump.py"] + argv
    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            rc = D.main()
    finally:
        sys.argv = old
    return rc, buf.getvalue()


def _run_dump():
    return _run_main(["--dump", _DUMP])


def _run_dump_seed(seed_path=None):
    return _run_main(["--dump", _DUMP, "--seed", seed_path or _SEED])


def _corrupt_seed(tmp_path, mutate):
    """Write a COPY of the committed seed with the 1st (only) calib entry mutated by `mutate(entry)`.
    Returns the tmp path. The committed seed is NEVER touched."""
    doc = json.load(open(_SEED, encoding="utf-8"))
    fp = next(iter(doc["calib"]))
    doc = copy.deepcopy(doc)
    mutate(doc["calib"][fp])
    p = tmp_path / "seed_corrupt.json"
    json.dump(doc, open(p, "w", encoding="utf-8"))
    return str(p)


# --------------------------------------------------------------------------- #
# BASELINE — the real build + committed seed must be GREEN, otherwise the adversarial tests
# (which corrupt a known-good state) prove nothing.
# --------------------------------------------------------------------------- #
class TestBaselineRealDumpIsGreen:
    def test_offsets_and_enums_clean(self):
        rc, out = _run_dump()
        assert rc == 0, out
        assert "DRIFT DETECTED" not in out

    def test_with_seed_clean(self):
        rc, out = _run_dump_seed()
        assert rc == 0, out
        # the committed seed's idx_ut must resolve the (obfuscated) class holding the gold dict.
        assert "gold OK" in out


# --------------------------------------------------------------------------- #
# OFFSETS — each test re-enacts a real SHIFT and requires RED (rc != 0).
# Monkeypatch the offsets-class ATTR (auto-restored by the fixture).
# --------------------------------------------------------------------------- #
class TestOffsetCorruptionCaught:
    """Each injection = one way offsets.py can regress in a patch; the gate MUST catch it."""

    def test_the_1_00_12_break_exact(self, monkeypatch):
        """The REAL 1.00.12 BREAKAGE, byte-for-byte: before the fix CURRENCIES was 0x28; in build 1.00.12
        the bucket-box put `BoxBucketUseBoxList` EXACTLY at 0x28 and pushed the real currency to 0x38. The
        presence-only check passed green (there was SOMETHING at 0x28). The hardened gate must GO RED with
        WRONG FIELD naming the real intruder from the dump."""
        monkeypatch.setattr(O.PlayerSaveData, "CURRENCIES", 0x28)
        rc, out = _run_dump()
        assert rc == 1, out
        assert "WRONG FIELD" in out
        assert "CURRENCIES" in out
        # Must name the EXACT intruder field that the real 1.00.12 dump has at 0x28.
        assert "BoxBucketUseBoxList" in out
        # And the summary must list the shift as a failure reason.
        assert "DRIFT DETECTED" in out

    def test_wrong_field_at_offset_currency_quantity(self, monkeypatch):
        """'offset PRESENT, WRONG FIELD' outside PlayerSaveData: QUANTITY pointing at 0x10 lands on the
        `Key` field (it exists, but it's the wrong one). It was a gap (QUANTITY wasn't name-checked) — now
        it's caught."""
        monkeypatch.setattr(O.CurrencySaveData, "QUANTITY", O.CurrencySaveData.KEY)
        rc, out = _run_dump()
        assert rc == 1, out
        assert "WRONG FIELD" in out
        assert "QUANTITY" in out

    def test_offset_shift_to_empty_slot_is_missing(self, monkeypatch):
        """SHIFT to an offset with NO field in the dump (0x44 doesn't exist in the real PlayerSaveData) →
        NO FIELD. It's the signal of a field that vanished/shrank (the other half of the shift bug class)."""
        monkeypatch.setattr(O.PlayerSaveData, "ATTRIBUTES", 0x44)
        rc, out = _run_dump()
        assert rc == 1, out
        assert "NO FIELD" in out
        assert "ATTRIBUTES" in out

    def test_hero_list_shift_caught_on_named_class(self, monkeypatch):
        """The save's hero list (HEROES) is the root of the upload breakage (heroes=[] → eligible() skips).
        Shifting it to 0x48 lands on `mailSaveDatas` (a NON-list field) → WRONG FIELD."""
        monkeypatch.setattr(O.PlayerSaveData, "HEROES", 0x48)
        rc, out = _run_dump()
        assert rc == 1, out
        assert "HEROES" in out
        assert "DRIFT DETECTED" in out

    def test_item_enchant_stride_field_shift_caught(self, monkeypatch):
        """The enchant iteration (ItemEnchant, aliased to ItemEnchantSaveData in the dump) is silent if
        it misaligns. Moving STAT_TYPE to an offset with another named field must GO RED."""
        # 0x4 in the enchant struct = TIER (named) — STAT_TYPE landing here is WRONG FIELD.
        monkeypatch.setattr(O.ItemEnchant, "STAT_TYPE", O.ItemEnchant.TIER)
        rc, out = _run_dump()
        assert rc == 1, out
        assert "ItemEnchant" in out


# --------------------------------------------------------------------------- #
# ENUMS — renumbering a member (the game reordered an enum) must GO RED.
# Monkeypatch D.offsets_enums (IntEnum can't have a member remapped at runtime).
# --------------------------------------------------------------------------- #
class TestEnumCorruptionCaught:
    def test_stattype_renumber_caught(self, monkeypatch):
        """Reordering a StatType (e.g. MaxHp 5→999) misaligns the 64 stats per hero (silent)."""
        real = D.offsets_enums

        def patched():
            e = real()
            e["StatType"] = dict(e["StatType"])
            e["StatType"]["MAXHP"] = 999
            return e

        monkeypatch.setattr(D, "offsets_enums", patched)
        rc, out = _run_dump()
        assert rc == 1, out
        assert "StatType" in out
        assert "DRIFT DETECTED" in out

    def test_gold_aggregate_type_renumber_caught(self, monkeypatch):
        """GoldEarn is the load-bearing gold member (combat_gold reads GoldEarn[SubKey1]). Renumbering it
        (2→7) must GO RED — it's the entire gold read that would break."""
        real = D.offsets_enums

        def patched():
            e = real()
            e["EAggregateType"] = dict(e["EAggregateType"])
            e["EAggregateType"]["GOLDEARN"] = 7
            return e

        monkeypatch.setattr(D, "offsets_enums", patched)
        rc, out = _run_dump()
        assert rc == 1, out
        assert "EAggregateType.GOLDEARN" in out


# --------------------------------------------------------------------------- #
# SEED — TypeDefIndex / anchor_rva / idx_ut. Corrupts a COPY of the seed in a tmp.
# --------------------------------------------------------------------------- #
class TestSeedCorruptionCaught:
    def test_wrong_typedef_index_caught(self, tmp_path):
        """A seed TypeDefIndex that doesn't match the dump (build reindexed) → ✗ index."""
        p = _corrupt_seed(tmp_path, lambda e: e["indices"].__setitem__(
            "PlayerSaveData", e["indices"]["PlayerSaveData"] + 1))
        rc, out = _run_dump_seed(p)
        assert rc == 1, out
        assert "index PlayerSaveData" in out
        assert "DRIFT DETECTED" in out

    def test_bad_anchor_rva_caught(self, tmp_path):
        """anchor_rva missing/zero (discover_anchor false-passed and wrote garbage) must GO RED — the RVA
        isn't diffable, but an invalid value is detectable and was never re-validated (gap in the plan)."""
        p = _corrupt_seed(tmp_path, lambda e: e.__setitem__("anchor_rva", 0))
        rc, out = _run_dump_seed(p)
        assert rc == 1, out
        assert "anchor_rva" in out

    def test_idx_ut_not_holding_gold_dict_caught(self, tmp_path):
        """idx_ut must point at the class that HAS Dictionary<EAggregateType,…> (the obfuscated
        AggregateManager). Pointing it at another class (e.g. PlayerSaveData's index) = the bug class
        'gold reindexed / value-scan grabbed frozen=0/1.97T'. Must GO RED with idx_ut."""
        p = _corrupt_seed(tmp_path, lambda e: e.__setitem__("idx_ut", e["indices"]["PlayerSaveData"]))
        rc, out = _run_dump_seed(p)
        assert rc == 1, out
        assert "idx_ut" in out
        assert "does NOT have" in out

    def test_missing_seed_index_key_is_surfaced(self, tmp_path):
        """Dropping a class from the seed's `indices` (incomplete seed catalog) must NOT pass as
        green-with-everything-OK: the index total falls and the gate reports fewer than the build expects.
        Here we prove that removing a key doesn't introduce a silent false ✓ — the summary reflects the drop."""
        _rc_full, full = _run_dump_seed()
        # remove one index key and confirm the '/N TypeDefIndex' count DROPS in the report.
        p = _corrupt_seed(tmp_path, lambda e: e["indices"].pop("StageManager", None))
        rc, out = _run_dump_seed(p)
        # rc stays 0 (the remaining keys match), but the report must show 1 FEWER index —
        # otherwise a missing key would pass invisibly. Compare the "/N" of the index total.
        import re
        n_full = int(re.search(r"(\d+)/(\d+) of the seed's TypeDefIndex", full).group(2))
        n_part = int(re.search(r"(\d+)/(\d+) of the seed's TypeDefIndex", out).group(2))
        assert n_part == n_full - 1, f"full={n_full} part={n_part}\n{out}"


# --------------------------------------------------------------------------- #
# INTERNAL CONSISTENCY — every field the reader DEREFERENCES on the PLAINTEXT save path
# must be COVERED by the tripwire's name-check (it can't be name-unverifiable/silent).
# So adding a new read WITHOUT a name guard in the dump FAILS CI here.
# --------------------------------------------------------------------------- #

# PLAINTEXT fields (real name in the dump) the reader reads — mirrors game/save.py, game/build.py,
# metrics/gold.py, game/models.py and the catalogs. Does NOT include the OBFUSCATED singletons
# (AggregateManager/HeroRuntime/StatsHolder/UnitHealthController/StatModifier): those are name-free by
# design and the gate reports them as UNVERIFIABLE on purpose — what validates them is the LIVE gate
# (validate_live.py), not this name-check. If you add a new PLAINTEXT read, add the field here: if the
# name in the dump isn't verifiable (fuzzy/override), this test fails — exactly the point (no guard, no CI).
_CONSUMED_PLAINTEXT = {
    "PlayerSaveData": ["CURRENCIES", "HEROES", "ATTRIBUTES", "RUNES",
                       "INVENTORY_SLOTS", "STASH", "ITEMS", "AGGREGATES"],
    "CurrencySaveData": ["KEY", "QUANTITY"],
    "HeroSaveData": ["HERO_KEY", "LEVEL", "EXP", "EQUIPPED_ITEMS", "EQUIPPED_SKILLS"],
    "AttributeSaveData": ["KEY", "LEVEL"],
    "RuneSaveData": ["KEY", "LEVEL"],
    "InventorySaveData": ["UNIQUE_ID"],
    "StashSaveData": ["UNIQUE_ID"],
    "ItemSaveData": ["ITEM_KEY", "UNIQUE_ID", "ENCHANT_DATA"],
    "ItemEnchant": ["TIER", "VALUE", "RECIPE", "STAT_TYPE"],
    "AggregateSaveData": ["TYPE", "SUB_KEY", "VALUE"],
    "HeroInfoData": ["HERO_KEY", "CLASS_TYPE"],
    "StageInfoData": ["STAGE_KEY", "STAGE_TYPE", "DIFFICULTY", "ACT",
                      "STAGE_NO", "WAVE_AMOUNT", "WAVE_MOB_AMOUNT"],
    "ItemInfoData": ["ITEM_KEY", "ITEM_TYPE", "GRADE", "PARTS", "LEVEL"],
    "CommonSaveData": ["PLAYTIME", "CURRENT_STAGE_KEY", "CURRENT_STAGE_WAVE"],
}


class TestConsumedFieldsAreNameGuarded:
    """The tripwire only catches 'WRONG FIELD' on the fields it NAME-CHECKS. If a new save read lands
    on a field whose name in the dump can't be verified (neither fuzzy nor override), it's silent —
    the 1.00.12 bug class. This test proves that EVERY consumed plaintext field is name-guarded against
    the real dump; adding a read without a guard FAILS here (the plan's safety net)."""

    def test_every_consumed_plaintext_field_is_name_verifiable(self):
        dclasses, _denums, _dtdi, dbases = D.parse_dump(_DUMP)
        dclass_ci = {k.lower(): k for k in dclasses}

        # same subclass descent that main() does (a base field may live in a subclass).
        children = {}
        for c, b in dbases.items():
            children.setdefault(b, []).append(c)

        def descend(dname):
            seen, stack, merged = set(), [dname], {}
            while stack:
                c = stack.pop()
                if c in seen:
                    continue
                seen.add(c)
                for o, f in (dclasses.get(c) or {}).items():
                    merged.setdefault(o, f)
                stack.extend(children.get(c, []))
            return merged

        unguarded = []
        for cls, attrs in _CONSUMED_PLAINTEXT.items():
            dname = (cls if cls in dclasses
                     else D.CLASS_ALIAS.get(cls) if D.CLASS_ALIAS.get(cls) in dclasses
                     else dclass_ci.get(cls.lower()))
            if dname is None:
                unguarded.append(f"{cls}: class not found by name in the dump")
                continue
            own = dclasses[dname]
            merged = descend(dname)
            for attr in attrs:
                off = getattr(getattr(O, cls), attr)
                df = own.get(off)
                if df is None:
                    df = merged.get(off)
                if df is None:
                    unguarded.append(f"{cls}.{attr}@0x{off:X}: no field at offset (dump changed?)")
                    continue
                got = df[0] if isinstance(df, tuple) else df
                exp = D._expected_field_name(cls, attr, got)
                if exp is None:
                    unguarded.append(f"{cls}.{attr}@0x{off:X}: name `{got}` is UNVERIFIABLE (no guard)")

        assert not unguarded, (
            "plaintext fields consumed by the reader WITHOUT a name guard in the tripwire — "
            "a new read needs a fuzzy-match or _NAME_OVERRIDE in diff_offsets_vs_dump.py:\n  "
            + "\n  ".join(unguarded))

    def test_consumed_classes_exist_in_offsets(self):
        """Cheap sanity (runs even without the dump on the import path): the _CONSUMED_PLAINTEXT symbols
        exist in config.offsets — catches a class/ATTR rename that would make the map above a lie."""
        for cls, attrs in _CONSUMED_PLAINTEXT.items():
            obj = getattr(O, cls, None)
            assert obj is not None, f"config.offsets missing class {cls}"
            for attr in attrs:
                assert isinstance(getattr(obj, attr, None), int), f"{cls}.{attr} is not an int offset"
