"""game/build.py::read_build — equipped-item resolution, incl. the UNKNOWN_ITEM_KEY marker.

Guards the rule that an equipped handle the reader CAN'T name is surfaced (not silently
dropped): NOT-READ != READ-ZERO. A revert to `continue` (the old silent drop) makes
test_unresolved_equipped_item_becomes_unknown go red.
"""

from config.offsets import (Array, HeroInfoData, HeroRuntime, HeroSaveData, ItemSaveData,
                            PlayerSaveData, StageManager, Unit)
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


# --------------------------------------------------------------------------- #
# read_party_slots / order_party_by_slot — the run's IN-GAME formation position #
# (StageManager.HeroList slot 0/1/2). [[invariants/party-live-resolution]]      #
# --------------------------------------------------------------------------- #

SM = 0x10000
PARTY_HERO_CAT = {101: 1, 201: 2, 301: 3, 401: 4, 501: 5, 601: 6}


def _party_reader(slots, n=3):
    """A reader whose StageManager SM exposes a HeroList of length `n` with deployed heroes at the
    given formation slots: `slots` = {slot_index: heroKey}. Slots not listed are null (empty), the
    fixed-3 layout the game uses (verified live). Each slot wires the full Hero->cache->info->heroKey
    chain at distinct, non-overlapping addresses."""
    hl = 0x20000
    mem = {SM + StageManager.HERO_LIST: hl, hl + Array.MAX_LENGTH: n}
    for slot, hk in slots.items():
        h, uf, hi = 0x30000 + slot * 0x1000, 0x40000 + slot * 0x1000, 0x50000 + slot * 0x1000
        mem[hl + Array.DATA + slot * 8] = h
        mem[h + Unit.CACHE] = uf
        mem[uf + HeroRuntime.INFO] = hi
        mem[hi + HeroInfoData.HERO_KEY] = hk
    return MockReader(mem=mem)


def test_read_party_slots_maps_each_hero_to_its_formation_index():
    reader = _party_reader({0: 101, 1: 201, 2: 301})
    assert build.read_party_slots(reader, SM, PARTY_HERO_CAT) == {101: 0, 201: 1, 301: 2}


def test_read_party_slots_preserves_gaps():
    # THE bug: 2 heroes in slots 0 and 2 (slot 1 empty). The slot index is the EXACT in-game
    # position — NOT re-packed to 0,1. Re-packing/collapsing the gap is what was lost before.
    reader = _party_reader({0: 101, 2: 301})
    assert build.read_party_slots(reader, SM, PARTY_HERO_CAT) == {101: 0, 301: 2}


def test_read_party_slots_solo_hero_keeps_its_slot():
    reader = _party_reader({2: 201})   # solo hero parked in slot 2, slots 0/1 null
    assert build.read_party_slots(reader, SM, PARTY_HERO_CAT) == {201: 2}


def test_read_party_slots_rejects_ghost_via_hero_cat():
    # A slot carrying a non-catalog heroKey is a ghost -> excluded (SAME discriminator as
    # read_live_party, since both share _iter_party_slots).
    reader = _party_reader({0: 101, 1: 999_999})
    assert build.read_party_slots(reader, SM, PARTY_HERO_CAT) == {101: 0}


def test_read_party_slots_empty_without_sm():
    assert build.read_party_slots(MockReader(mem={}), None, PARTY_HERO_CAT) == {}


def test_read_party_slots_agrees_with_read_live_party():
    # pick<->read<->slot share _iter_party_slots: the slot map's keys == the live party's keys.
    reader = _party_reader({0: 101, 2: 301})
    assert set(build.read_party_slots(reader, SM, PARTY_HERO_CAT)) == set(
        build.read_live_party(reader, SM, PARTY_HERO_CAT))


def test_order_party_by_slot_sorts_by_formation_slot():
    heroes = [{"heroKey": 301, "slot": 2}, {"heroKey": 101, "slot": 0}, {"heroKey": 201, "slot": 1}]
    assert [h["heroKey"] for h in build.order_party_by_slot(heroes)] == [101, 201, 301]


def test_order_party_by_slot_slot_zero_sorts_first():
    # Guards the `or 0` falsy trap: slot 0 is a real first position, never confused with "no slot".
    heroes = [{"heroKey": 201, "slot": 1}, {"heroKey": 101, "slot": 0}]
    assert [h["heroKey"] for h in build.order_party_by_slot(heroes)] == [101, 201]


def test_order_party_by_slot_missing_slot_trails_in_order():
    # A hero with no resolved slot (None or absent — a degraded read) trails, keeping relative order.
    heroes = [{"heroKey": 301, "slot": None}, {"heroKey": 101, "slot": 0}, {"heroKey": 401}]
    assert [h["heroKey"] for h in build.order_party_by_slot(heroes)] == [101, 301, 401]


def test_slot_sort_key_zero_is_real_and_none_trails():
    # The single party-ordering rule (shared by order_party_by_slot + the live overlay sort): slot 0
    # is a REAL first position (NOT coalesced to "missing"), and a None slot trails everything.
    assert build.slot_sort_key(0) == (False, 0)
    assert build.slot_sort_key(2) == (False, 2)
    assert build.slot_sort_key(None) == (True, 0)
    assert sorted([2, None, 0, 1], key=build.slot_sort_key) == [0, 1, 2, None]
