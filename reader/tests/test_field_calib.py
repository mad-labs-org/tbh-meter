"""Guard tests for game/field_calib.py — the auto-calibration of the four fragile field offsets.

Each discovery is tested against a byte-level fake memory where the target field sits at a NON-default
offset, proving the signature finds it wherever it moved. test_calibrate_keeps_static_on_no_signal
proves the critical safety property: no signal -> static offsets are left untouched (never makes a
working build worse). See docs/invariants/field-offset-autocalibration.
"""
import struct

import pytest

import config.offsets as off
from config.offsets import (Array, Unit, Monster, UnitHealthController, StageManager,
                            MonsterSpawnManager, HeroRuntime, HeroInfoData)
from game import field_calib


class ByteReader:
    """Byte-addressable fake memory. Backs ri32/rptr/read/read_struct/read_array_ptrs/list_ptrs —
    the exact subset field_calib uses. Writers place a value at an absolute address."""

    def __init__(self):
        self.mem = bytearray(0x400000)  # 4 MB flat space; addresses are offsets into it

    def _w(self, addr, data):
        self.mem[addr:addr + len(data)] = data

    def wi32(self, addr, v):
        self._w(addr, struct.pack("<i", v))

    def wptr(self, addr, v):
        self._w(addr, struct.pack("<Q", v))

    def wf32(self, addr, v):
        self._w(addr, struct.pack("<f", v))

    # --- Reader interface used by field_calib ---
    def read(self, addr, size):
        if addr < 0 or addr + size > len(self.mem):
            return None
        return bytes(self.mem[addr:addr + size])

    def ri32(self, addr):
        b = self.read(addr, 4)
        return struct.unpack("<i", b)[0] if b else None

    def rptr(self, addr):
        b = self.read(addr, 8)
        return struct.unpack("<Q", b)[0] if b else None

    def read_struct(self, addr, fmt):
        b = self.read(addr, struct.calcsize(fmt))
        return struct.unpack(fmt, b) if b else None

    def read_array_ptrs(self, arr, count):
        b = self.read(arr + Array.DATA, count * 8)
        if not b:
            return []
        return list(struct.unpack("<%dQ" % count, b))

    def list_ptrs(self, list_obj, cap=600):
        if not list_obj:
            return []
        from config.offsets import List
        size = self.ri32(list_obj + List.SIZE)
        items = self.rptr(list_obj + List.ITEMS)
        if not size or not items or size < 0 or size > cap:
            return []
        return [p for p in self.read_array_ptrs(items, size) if p]


@pytest.fixture(autouse=True)
def restore_offsets():
    """Snapshot/restore the mutable offset class attributes so one test's calibration can't leak."""
    saved = (Monster.STAGE_KEY, Unit.CACHE, UnitHealthController.HP_MAX, StageManager.HERO_LIST)
    yield
    (Monster.STAGE_KEY, Unit.CACHE, UnitHealthController.HP_MAX, StageManager.HERO_LIST) = saved


STAGE_INFO = {3301: (3, 1, 459, 2), 1107: (1, 7, 72, 0)}
HERO_CAT = {101: 1, 201: 2, 301: 3, 401: 4}


def _msm_with_monsters(r, monster_addrs, msm=0x1000, mlist=0x2000, items=0x3000):
    """Wire an MSM whose MONSTER_LIST holds the given monster addresses."""
    from config.offsets import List
    r.wptr(msm + MonsterSpawnManager.MONSTER_LIST, mlist)
    r.wi32(mlist + List.SIZE, len(monster_addrs))
    r.wptr(mlist + List.ITEMS, items)
    for i, a in enumerate(monster_addrs):
        r.wptr(items + Array.DATA + i * 8, a)
    return msm


def test_discover_stage_key_by_catalog():
    """STAGE_KEY found at a non-default offset because its value is a catalog key."""
    r = ByteReader()
    moved = 0x444  # deliberately not the current Monster.STAGE_KEY
    m0, m1 = 0x10000, 0x20000
    for m in (m0, m1):
        r.wi32(m + moved, 3301)  # a real stage_info key
    msm = _msm_with_monsters(r, [m0, m1])
    assert field_calib.discover_stage_key(r, msm, STAGE_INFO) == moved


def test_discover_hp_max_ge_current():
    """HP_MAX found: the float >= HP_CURRENT(0x40) and > 0, at a moved offset."""
    r = ByteReader()
    moved = 0x58
    m0 = 0x10000
    hc = 0x50000
    r.wptr(m0 + Unit.HEALTH_CONTROLLER, hc)
    r.wf32(hc + UnitHealthController.HP_CURRENT, 500.0)
    r.wf32(hc + moved, 900.0)  # the real max
    msm = _msm_with_monsters(r, [m0])
    assert field_calib.discover_hp_max(r, msm) == moved


def test_discover_hero_list_and_cache():
    """HERO_LIST + CACHE found together: array of hero ptrs whose INFO->HERO_KEY is in hero_cat."""
    r = ByteReader()
    sm = 0x1000
    hl_off, cache_off = 0x58, 0x3a0  # both moved from defaults
    hl = 0x60000
    heroes = [0x70000, 0x71000, 0x72000]
    keys = [401, 301, 201]  # >= 2 distinct, all in HERO_CAT
    r.wptr(sm + hl_off, hl)
    r.wi32(hl + Array.MAX_LENGTH, len(heroes))
    for i, (ha, hk) in enumerate(zip(heroes, keys)):
        r.wptr(hl + Array.DATA + i * 8, ha)
        uf = ha + 0x8000
        info = uf + 0x4000
        r.wptr(ha + cache_off, uf)
        r.wptr(uf + HeroRuntime.INFO, info)
        r.wi32(info + HeroInfoData.HERO_KEY, hk)
    found_hl, found_cache = field_calib.discover_hero_list_and_cache(r, [sm], HERO_CAT)
    assert (found_hl, found_cache) == (hl_off, cache_off)


def test_calibrate_rejects_same_key_repeated():
    """The [2,2,2] false positive: an array where every element maps to the SAME key is rejected."""
    r = ByteReader()
    sm = 0x1000
    hl = 0x60000
    heroes = [0x70000, 0x71000, 0x72000]
    r.wptr(sm + 0x58, hl)
    r.wi32(hl + Array.MAX_LENGTH, len(heroes))
    for i, ha in enumerate(heroes):
        r.wptr(hl + Array.DATA + i * 8, ha)
        uf = ha + 0x8000
        info = uf + 0x4000
        r.wptr(ha + 0x3a0, uf)
        r.wptr(uf + HeroRuntime.INFO, info)
        r.wi32(info + HeroInfoData.HERO_KEY, 2)  # same key repeated -> not a real party
    found_hl, found_cache = field_calib.discover_hero_list_and_cache(r, [sm], HERO_CAT)
    assert (found_hl, found_cache) == (None, None)


def test_calibrate_keeps_static_on_no_signal():
    """SAFETY: with no live signal (empty MSM / no sm list), calibrate leaves every static offset."""
    r = ByteReader()
    before = (Monster.STAGE_KEY, Unit.CACHE, UnitHealthController.HP_MAX, StageManager.HERO_LIST)
    report = field_calib.calibrate(r, msm=0, sm_list=[], stage_info=STAGE_INFO, hero_cat=HERO_CAT)
    after = (Monster.STAGE_KEY, Unit.CACHE, UnitHealthController.HP_MAX, StageManager.HERO_LIST)
    assert before == after
    assert all(v[2] == "fallback" for v in report.values())
