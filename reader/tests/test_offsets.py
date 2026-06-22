"""Structural invariants of config/offsets.py.

Ensures the most critical constants — especially the ones with a history of causing
bugs when wrong — never change silently.
"""

from config.offsets import (
    AggregateManager,
    AggregateSaveData,
    Dict8B,
    DictFloat,
    EAggregateType,
    EEquipClassType,
    ELogType,
    EMonsterLogType,
    GetBoxLog,
    HeroDieLog,
    PlayerSaveData,
    ResurrectionLog,
    StageClearLog,
)


class TestDictStrides:
    """The two strides can NEVER be equal — confusing them corrupts gold and stats."""

    def test_dict_float_stride_is_0x10(self):
        assert DictFloat.STRIDE == 0x10

    def test_dict_8b_stride_is_0x18(self):
        assert Dict8B.STRIDE == 0x18

    def test_strides_are_distinct(self):
        assert DictFloat.STRIDE != Dict8B.STRIDE

    def test_dict_float_value_at_0xC(self):
        assert DictFloat.VALUE == 0xC

    def test_dict_8b_value_at_0x10(self):
        assert Dict8B.VALUE == 0x10


class TestEAggregateType:
    """GoldEarn=2 and BoxObtain=3 are the two aggregates the reader actively reads."""

    def test_gold_earn_is_2(self):
        assert EAggregateType.GoldEarn == 2

    def test_box_obtain_is_3(self):
        assert EAggregateType.BoxObtain == 3

    def test_monster_kill_is_0(self):
        assert EAggregateType.MonsterKill == 0

    def test_box_open_is_16(self):
        """BoxOpen (when the box is OPENED) differs from BoxObtain (when it DROPS)."""
        assert EAggregateType.BoxOpen == 16


class TestELogType:
    """GetBox=3 is the event we capture for box drops."""

    def test_stage_clear_is_1(self):
        assert ELogType.StageClear == 1

    def test_get_box_is_3(self):
        assert ELogType.GetBox == 3

    def test_hero_die_is_4(self):
        assert ELogType.HeroDie == 4

    def test_hero_resurrection_is_5(self):
        assert ELogType.HeroResurrection == 5

    def test_stage_failed_is_7(self):
        assert ELogType.StageFailed == 7


class TestGetBoxLogOffsets:
    """GetBoxLog offsets pinned from the IL2CPP dump — never change without updating the doc."""

    def test_box_key_at_0x40(self):
        assert GetBoxLog.BOX_KEY == 0x40

    def test_monster_key_at_0x48(self):
        assert GetBoxLog.MONSTER_KEY == 0x48

    def test_monster_type_at_0x50(self):
        assert GetBoxLog.MONSTER_TYPE == 0x50

    def test_layout_no_overlap(self):
        """The three fields have stride 8 (64-bit IL2CPP pointers)."""
        assert GetBoxLog.MONSTER_KEY - GetBoxLog.BOX_KEY == 8
        assert GetBoxLog.MONSTER_TYPE - GetBoxLog.MONSTER_KEY == 8


class TestHeroDieLogOffsets:
    """LIVE-CRACKED 2026-06-06 (32 events). The doc (run-data-map.md:145-146) had the fields
    SWAPPED: what it called hero@0x40 is actually the MONSTER that did the killing, and killer@0x48
    is the HERO that died. Confirmed: heroKey=201 <-> string @0x48 = 'HeroName_201'."""

    def test_killer_monster_at_0x40(self):
        assert HeroDieLog.KILLER_MONSTER == 0x40

    def test_victim_hero_at_0x48(self):
        assert HeroDieLog.VICTIM_HERO == 0x48

    def test_victim_after_killer_stride_8(self):
        # Order pinned live: killer (0x40) comes BEFORE victim (0x48), stride 8.
        assert HeroDieLog.VICTIM_HERO - HeroDieLog.KILLER_MONSTER == 8


class TestResurrectionLogOffsets:
    """LIVE-CRACKED (5 events): @0x40 = revived hero ('HeroName_<heroKey>'); @0x48/@0x50 empty."""

    def test_hero_at_0x40(self):
        assert ResurrectionLog.HERO == 0x40


class TestEMonsterLogType:
    def test_monster_is_0(self):
        assert EMonsterLogType.Monster == 0

    def test_boss_is_1(self):
        assert EMonsterLogType.Boss == 1

    def test_act_boss_is_2(self):
        assert EMonsterLogType.ActBoss == 2


class TestStageClearLogOffsets:
    def test_act_at_0x40(self):
        assert StageClearLog.ACT == 0x40

    def test_stage_at_0x44(self):
        assert StageClearLog.STAGE == 0x44

    def test_clear_time_at_0x48(self):
        assert StageClearLog.CLEAR_TIME == 0x48


class TestAggregateSaveDataOffsets:
    def test_type_at_0x10(self):
        assert AggregateSaveData.TYPE == 0x10

    def test_sub_key_at_0x14(self):
        assert AggregateSaveData.SUB_KEY == 0x14

    def test_value_at_0x18(self):
        assert AggregateSaveData.VALUE == 0x18

    def test_layout_alignment(self):
        """TYPE and SUB_KEY are contiguous int32; VALUE is a long (8B) right after."""
        assert AggregateSaveData.SUB_KEY - AggregateSaveData.TYPE == 4
        assert AggregateSaveData.VALUE - AggregateSaveData.SUB_KEY == 4


class TestEEquipClassType:
    """Ensures the correct enum (not the orphan EHeroType with a different mapping)."""

    def test_all_is_0(self):
        assert EEquipClassType.All == 0

    def test_knight_is_1(self):
        assert EEquipClassType.Knight == 1

    def test_ranger_is_2(self):
        assert EEquipClassType.Ranger == 2

    def test_sorcerer_is_3(self):
        assert EEquipClassType.Sorcerer == 3

    def test_slayer_is_6(self):
        assert EEquipClassType.Slayer == 6

    def test_has_exactly_7_values(self):
        assert len(EEquipClassType) == 7


class TestAggregateManagerOffset:
    def test_aggregates_at_0x20(self):
        """The offset of the live aggregates dict. Stable across builds (pinned)."""
        assert AggregateManager.AGGREGATES == 0x20


class TestPlayerSaveDataOffset:
    def test_aggregates_at_0xa8(self):
        # PlayerSaveData save lists have shifted +0x10 TWICE from inserted fields:
        # 1.00.12 (BoxBucketUse/GetBoxList) and 1.00.19 (AlchemyPendingIdList/AlchemyReceiptList).
        # AGGREGATES: 0x88 → 0x98 (1.00.12) → 0xA8 (1.00.19). See class PlayerSaveData in offsets.py.
        assert PlayerSaveData.AGGREGATES == 0xA8
