"""game/build.py::read_build — equipped-item resolution, incl. the UNKNOWN_ITEM_KEY marker.

Guards the rule that an equipped handle the reader CAN'T name is surfaced (not silently
dropped): NOT-READ != READ-ZERO. A revert to `continue` (the old silent drop) makes
test_unresolved_equipped_item_becomes_unknown go red.
"""

from config.offsets import HeroSaveData, ItemSaveData, PlayerSaveData
from game import build
from game.build import UNKNOWN_ITEM_KEY
from tests.conftest import MockReader

PSD = 0x1000
ITEMS_LIST, HEROES_LIST = 0x2000, 0x3000
ITEM, HERO, EQUIP_ARR = 0x2100, 0x3100, 0x4000


def _reader(equipped):
    """One save item (uid 100 -> itemKey 1) and one lvl-101 hero whose equippedItemIds is
    `equipped` (a positional list of uniqueIds; 0 = empty slot)."""
    mem = {
        PSD + PlayerSaveData.ITEMS: ITEMS_LIST,
        PSD + PlayerSaveData.HEROES: HEROES_LIST,
        ITEM + ItemSaveData.UNIQUE_ID: 100,
        ITEM + ItemSaveData.ITEM_KEY: 1,
        HERO + HeroSaveData.HERO_KEY: 201,
        HERO + HeroSaveData.LEVEL: 101,
        HERO + HeroSaveData.EXP: 0,
        HERO + HeroSaveData.EQUIPPED_ITEMS: EQUIP_ARR,
        # EQUIPPED_SKILLS / ATTRIBUTES unset -> arr_i32(None)=[] / list_iter(None)=[] (no skills)
    }
    return MockReader(
        mem=mem,
        lists={ITEMS_LIST: [ITEM], HEROES_LIST: [HERO]},
        arrs={EQUIP_ARR: equipped},
    )


# item_cat: itemKey 1 -> grade 4 (IMMORTAL), parts 1 (MAIN_WEAPON), level 0. hero_cat: 201 -> Ranger.
ITEM_CAT = {1: (4, 1, 0)}
HERO_CAT = {201: 2}


def test_unresolved_equipped_item_becomes_unknown():
    # pos 0 -> uid 100 (resolves); pos 7 -> uid 999 (NOT in itemSaveDatas -> unknown).
    out = build.read_build(_reader([100, 0, 0, 0, 0, 0, 0, 999]), PSD, ITEM_CAT, HERO_CAT)
    items = out[0]["items"]

    resolved = [i for i in items if i["itemKey"] == 1]
    assert len(resolved) == 1
    assert resolved[0]["slot"] == "MAIN_WEAPON"  # slot from the catalog, not the array position

    unknown = [i for i in items if i["itemKey"] == UNKNOWN_ITEM_KEY]
    assert len(unknown) == 1
    # pos 7 -> EItemParts 8 (EARING): the slot is known from the position even when the item is not.
    assert unknown[0]["slot"] == "EARING"
    assert unknown[0]["slotId"] == 8
    assert unknown[0]["uniqueId"] == "999"
    assert unknown[0]["mods"] == []


def test_empty_equipped_slot_is_not_emitted():
    # uniqueId 0 is an honestly-empty slot — neither a real item nor an unknown.
    out = build.read_build(_reader([0, 0, 0, 0]), PSD, ITEM_CAT, HERO_CAT)
    assert out[0]["items"] == []


def test_unresolved_beyond_known_slots_degrades_to_question_mark():
    # Defensive: an unresolved handle past the 10 known slots (pos 10 -> EItemParts 11, unknown)
    # gets slot "?" / slotId None rather than a bogus label.
    equipped = [0] * 10 + [999]  # pos 10 holds the unresolved uid
    out = build.read_build(_reader(equipped), PSD, ITEM_CAT, HERO_CAT)
    unknown = [i for i in out[0]["items"] if i["itemKey"] == UNKNOWN_ITEM_KEY]
    assert len(unknown) == 1
    assert unknown[0]["slot"] == "?"
    assert unknown[0]["slotId"] is None
