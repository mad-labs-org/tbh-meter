"""Regression for the static code-vs-game TRIPWIRE (scripts/diff_offsets_vs_dump.py).

WHY it exists: the tripwire is the gate that should have caught 1.00.12 BEFORE ship — the bucket-box
inserted fields into `PlayerSaveData` and shifted the save lists (+0x10), and the OLD check (offset
PRESENCE only + a curated list of ~20 names) went green because another field landed on the old
offset. These tests prove the hardened tripwire:
  1. stays GREEN (exit 0) on a correct layout;
  2. goes RED (exit != 0) when an INSERTION shifts a save list (the 1.00.12 class of bug), with a
     `CAMPO ERRADO` line AND the insertion report pointing at the intruding field;
  3. derives the expected name by fuzzy match (no list that rots) and SKIPS obfuscated names (which
     drift per build — the `*Log`), with no false positives.

Does NOT depend on the real dump.cs (which lives outside the repo, on the maintainer's machine): it
builds a SYNTHETIC dump.cs inline. Completeness vs. the real build is the job of the script itself
run in the meter-game-update skill; here we guard the gate's LOGIC via unit regression.
"""

import importlib.util
import io
import os
from contextlib import redirect_stdout

import pytest

_HERE = os.path.dirname(os.path.abspath(__file__))
_SCRIPT = os.path.normpath(os.path.join(_HERE, "..", "scripts", "diff_offsets_vs_dump.py"))


def _load_script():
    """Import the script as a module (it puts the reader root on the path at import)."""
    spec = importlib.util.spec_from_file_location("diff_offsets_vs_dump", _SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


D = _load_script()


# --------------------------------------------------------------------------- #
# Pure helpers (no I/O) — the heart of the anti-rot name derivation
# --------------------------------------------------------------------------- #
class TestObfuscationDetector:
    """`_is_obf_field` separates a REAL name (verifiable) from an OBFUSCATED name (drifts per build)."""

    @pytest.mark.parametrize("obf", ["bfge", "bffo", "ph", "bcqv", "uu", "ut", "bfgm"])
    def test_obfuscated_names_detected(self, obf):
        assert D._is_obf_field(obf) is True

    @pytest.mark.parametrize("real", [
        "StageKey", "heroSaveDatas", "MonsterList", "b_isHero", "playTime",
        "currentStageKey", "HeroLevel", "equippedItemIds", "BoxBucketUseBoxList",
    ])
    def test_real_names_not_obfuscated(self, real):
        assert D._is_obf_field(real) is False

    def test_empty_is_not_obfuscated(self):
        assert D._is_obf_field("") is False
        assert D._is_obf_field(None) is False


class TestFuzzyNameMatch:
    """`_name_matches` ties the offsets.py ATTR to the dump name via normalized substring."""

    @pytest.mark.parametrize("attr,dump", [
        ("HERO_KEY", "heroKey"), ("STAGE_KEY", "StageKey"), ("KEY", "Key"),
        ("QUANTITY", "Quantity"), ("RUNES", "RuneSaveData"), ("CLASS_TYPE", "ClassType"),
        ("LEVEL", "HeroLevel"), ("STAGE_NO", "StageNo"), ("VALUE", "Value"),
    ])
    def test_matches(self, attr, dump):
        assert D._name_matches(attr, dump) is True

    @pytest.mark.parametrize("attr,dump", [
        ("CURRENCIES", "heroSaveDatas"), ("HEROES", "BoxBucketUseBoxList"),
        ("ITEMS", "aggregateSaveDatas"), ("KEY", "Quantity"),
    ])
    def test_mismatches(self, attr, dump):
        assert D._name_matches(attr, dump) is False


class TestExpectedFieldName:
    """`_expected_field_name`: override > fuzzy > None (obfuscated). The anti-rot derivation."""

    def test_override_wins(self):
        # HEROES↔heroSaveDatas only ties via the override (does fuzzy tie "heroes" to "herosavedatas"?
        # it does, but the override is the canonical source) — the override must return the exact dump name.
        assert D._expected_field_name("PlayerSaveData", "CURRENCIES", "currenySaveDatas") == "currenySaveDatas"

    def test_fuzzy_ok_returns_empty_sentinel(self):
        # "" = matched by fuzzy, no override or by-name assert needed.
        assert D._expected_field_name("HeroInfoData", "HERO_KEY", "HeroKey") == ""

    def test_fuzzy_mismatch_demands_attr(self):
        # a REAL dump name that does not match the ATTR → demand it (return the ATTR so the comparison fails).
        got = D._expected_field_name("PlayerSaveData", "ATTRIBUTES", "heroSaveDatas")
        assert got == "ATTRIBUTES"

    def test_obfuscated_returns_none(self):
        # obfuscated name in the dump (the *Log) → None = not verifiable by name (the live-gate covers it).
        assert D._expected_field_name("StageClearLog", "ACT", "bfge") is None


class TestInsertionReport:
    """`_insertion_report` lists dump fields in the tracked window that offsets.py does NOT know —
    the direct signal of an INSERTION (the bucket-box class of bug)."""

    def test_flags_unexpected_field_in_window(self):
        own = {0x10: ("commonSaveData", "X"), 0x28: ("BoxBucketUseBoxList", "Y"),
               0x38: ("currenySaveDatas", "List")}
        # offsets.py tracks 0x10 and 0x38; 0x28 (the intruder) is in the window and is not tracked.
        ins = D._insertion_report(own, [0x10, 0x38])
        offs = [o for o, _ in ins]
        assert 0x28 in offs
        assert any("BoxBucketUseBoxList" in f for _, f in ins)

    def test_empty_when_contiguous(self):
        own = {0x10: ("a", "X"), 0x18: ("b", "Y")}
        assert D._insertion_report(own, [0x10, 0x18]) == []

    def test_empty_when_no_tracked(self):
        assert D._insertion_report({0x10: ("a", "X")}, []) == []


# --------------------------------------------------------------------------- #
# End-to-end: SYNTHETIC dump.cs → main() (clean exit 0, exit 1 with an insertion)
# --------------------------------------------------------------------------- #
def _field(jsonp, cstype, name, off):
    return f'\t[JsonProperty("{jsonp}")]\n\tpublic {cstype} {name}; // 0x{off:X}\n'


def _synth_dump(player_save_lines):
    """Build a minimal dump.cs: only the classes the tripwire checks by field name + the gold
    proof (idx_ut). `player_save_lines` = the PlayerSaveData body (varies per scenario)."""
    parts = []
    parts.append("// Namespace: TaskbarHero.EasySaveData\npublic class PlayerSaveData // TypeDefIndex: 2675\n{\n\t// Fields\n")
    parts.append(player_save_lines)
    parts.append("\n}\n")

    # CurrencySaveData / HeroSaveData / AggregateSaveData — NAMED fields the gate checks.
    parts.append("public class CurrencySaveData // TypeDefIndex: 3056\n{\n\t// Fields\n")
    parts.append(_field("Key", "int", "Key", 0x10))
    parts.append(_field("Quantity", "long", "Quantity", 0x18))
    parts.append("}\n")

    parts.append("public class HeroSaveData // TypeDefIndex: 3058\n{\n\t// Fields\n")
    parts.append(_field("heroKey", "int", "heroKey", 0x10))
    parts.append(_field("HeroLevel", "int", "HeroLevel", 0x14))
    parts.append(_field("HeroExp", "float", "HeroExp", 0x1C))
    parts.append(_field("equippedItemIds", "ulong[]", "equippedItemIds", 0x28))
    parts.append(_field("equippedSKillKey", "int[]", "equippedSKillKey", 0x30))
    parts.append("}\n")

    parts.append("public class AggregateSaveData // TypeDefIndex: 3054\n{\n\t// Fields\n")
    parts.append(_field("Type", "int", "Type", 0x10))
    parts.append(_field("SubKey", "int", "SubKey", 0x14))
    parts.append(_field("Value", "long", "Value", 0x18))
    parts.append("}\n")
    return "".join(parts)


# CORRECT PlayerSaveData body (1.00.19 offsets = the ones offsets.py has today).
_PSD_OK = "".join([
    _field("commonSaveData", "CommonSaveData", "commonSaveData", 0x10),
    _field("currenySaveDatas", "List<CurrencySaveData>", "currenySaveDatas", 0x48),
    _field("heroSaveDatas", "List<HeroSaveData>", "heroSaveDatas", 0x50),
    _field("attributeSaveDatas", "List<AttributeSaveData>", "attributeSaveDatas", 0x60),
    _field("RuneSaveData", "List<RuneSaveData>", "RuneSaveData", 0x70),
    _field("inventorySaveDatas", "List<InventorySaveData>", "inventorySaveDatas", 0x78),
    _field("stashSaveDatas", "List<StashSaveData>", "stashSaveDatas", 0x80),
    _field("itemSaveDatas", "List<ItemSaveData>", "itemSaveDatas", 0xA0),
    _field("aggregateSaveDatas", "List<AggregateSaveData>", "aggregateSaveDatas", 0xA8),
])

# Body of a build with an INSERTION NOT accommodated by offsets.py: at the offset offsets.py tracks as
# CURRENCIES (0x48 since 1.00.19) the dump has the INTRUDING field `BoxBucketUseBoxList`, and the real
# currency list shifted to 0x58 (untracked). It is the EXACT 1.00.12/1.00.19 class of bug — a field
# present at the tracked offset let the presence-only check go green. The other tracked offsets still
# hold the right field (only CURRENCIES trips → proves the name-check, not a wholesale shift).
_PSD_SHIFTED = "".join([
    _field("commonSaveData", "CommonSaveData", "commonSaveData", 0x10),
    _field("BoxBucketUseBoxList", "List<int>", "BoxBucketUseBoxList", 0x48),  # intruder where CURRENCIES goes
    _field("heroSaveDatas", "List<HeroSaveData>", "heroSaveDatas", 0x50),
    _field("currenySaveDatas", "List<CurrencySaveData>", "currenySaveDatas", 0x58),  # real currency, shifted
    _field("attributeSaveDatas", "List<AttributeSaveData>", "attributeSaveDatas", 0x60),
    _field("RuneSaveData", "List<RuneSaveData>", "RuneSaveData", 0x70),
    _field("inventorySaveDatas", "List<InventorySaveData>", "inventorySaveDatas", 0x78),
    _field("stashSaveDatas", "List<StashSaveData>", "stashSaveDatas", 0x80),
    _field("itemSaveDatas", "List<ItemSaveData>", "itemSaveDatas", 0xA0),
    _field("aggregateSaveDatas", "List<AggregateSaveData>", "aggregateSaveDatas", 0xA8),
])


def _run_main(tmp_path, psd_body, with_seed=False):
    dump = tmp_path / "dump.cs"
    dump.write_text(_synth_dump(psd_body), encoding="utf-8")
    argv = ["--dump", str(dump)]
    seed_path = None
    if with_seed:
        import json
        seed_path = tmp_path / "seed.json"
        json.dump({"fmt": 9, "calib": {"fp": {
            "anchor_rva": 123456, "idx_ut": 7, "indices": {"PlayerSaveData": 2675}}}},
            open(seed_path, "w"))
        argv += ["--seed", str(seed_path)]
    import sys
    old = sys.argv
    sys.argv = ["diff_offsets_vs_dump.py"] + argv
    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            rc = D.main()
    finally:
        sys.argv = old
    return rc, buf.getvalue()


class TestEndToEndSyntheticDump:
    def test_clean_layout_exits_zero(self, tmp_path):
        rc, out = _run_main(tmp_path, _PSD_OK)
        assert rc == 0, out
        # All three named classes match (no ✗).
        assert "✗" not in out
        assert "PlayerSaveData" in out and "CurrencySaveData" in out

    def test_bucketbox_insertion_exits_nonzero(self, tmp_path):
        # The 1.00.12 regression: must FAIL (rc=1) with WRONG FIELD AND the insertion report.
        rc, out = _run_main(tmp_path, _PSD_SHIFTED)
        assert rc == 1, out
        assert "WRONG FIELD" in out
        assert "CURRENCIES" in out
        # The insertion report must name the bucket-box intruding field.
        assert "INSERTION" in out
        assert "BoxBucketUseBoxList" in out

    def test_seed_idx_ut_must_hold_gold_dict(self, tmp_path):
        # In the synthetic dump NO class has Dictionary<EAggregateType,…> → idx_ut does not prove gold
        # → the seed gate FAILS (the "gold reindexed / value-scan grabbed frozen=0" class of bug).
        rc, out = _run_main(tmp_path, _PSD_OK, with_seed=True)
        assert rc == 1, out
        assert "idx_ut" in out
