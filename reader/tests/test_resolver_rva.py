"""Tests for il2cpp/resolver.resolve_via_rva — fast path by INDEX (mac, no live process).

Covers the anti-poisoning gate (fallback / cache-correctness):
  happy path  — all classes round-trip + singletons with valid size → (classes, instances)
  name mismatch — class_name != expected name → None (caller falls through to scan)
  size out of range — manager instance with an absurd size → None

FakeReader is dict-backed (mirrors the one in test_typeinfo) + the bbwf chain (PARENT→STATIC_FIELDS→
INSTANCE) and the list-size reads (List.SIZE) that _manager_inst_ok uses. resolve_via_rva reads
classes via rptr(tbase + idx*8), so the table lives in the ptr dict (not in a blob).
"""

from config.offsets import Class, List, LogManager, MonsterSpawnManager, Singleton
from il2cpp import resolver


class FakeReader:
    """ri32/rptr/read_cstr from dedicated dicts (resolve_via_rva does no block reads)."""

    def __init__(self, i32=None, ptr=None, cstr=None):
        self._i32 = dict(i32 or {})
        self._ptr = dict(ptr or {})
        self._cstr = dict(cstr or {})

    def ri32(self, addr):
        return self._i32.get(addr)

    def rptr(self, addr):
        return self._ptr.get(addr)

    def read_cstr(self, addr, maxlen=64):
        return self._cstr.get(addr)


# --------------------------------------------------------------------------- #
# Fake-layout builder: TypeInfoTable + valid classes + singleton chain.
# --------------------------------------------------------------------------- #
TBASE = 0x500000

# arbitrary indices (sparse, as in the real build)
IDX = {
    "StageClearLog": 10,
    "MonsterSpawnManager": 20,
    "LogManager": 30,
    "StageManager": 40,
    "CurrencySaveData": 50,
}

# K of each class (8-aligned, within class_name bounds)
KOF = {name: 0x100000 + i * 0x1000 for i, name in enumerate(IDX)}


def _build(names, *, msm_size=3, lm_size=7, msm_list=True, lm_list=True):
    """Build a FakeReader where each `name` in `names` is a valid Il2CppClass at its index.
    Singletons get a bbwf chain (PARENT→STATIC_FIELDS→INSTANCE) for a live instance
    with lists of size `msm_size`/`lm_size`. `msm_list/lm_list` False = null list pointer."""
    ptr = {}
    cstr = {}
    i32 = {}
    for name in names:
        K = KOF[name]
        ptr[TBASE + IDX[name] * 8] = K     # class_by_index reads via rptr(tbase + idx*8)
        name_ptr = K + 0x800
        ptr[K + Class.NAME] = name_ptr
        ptr[K + Class.ELEMENT_CLASS] = K            # class_name round-trip
        cstr[name_ptr] = name
        if name in resolver.SINGLETONS:
            par = K + 0x10000
            sf = par + 0x20000
            inst = sf + 0x30000
            ptr[K + Class.PARENT] = par
            ptr[par + Class.STATIC_FIELDS] = sf
            ptr[sf + Singleton.INSTANCE] = inst
            if name == "MonsterSpawnManager":
                ml = inst + 0x40000
                ptr[inst + MonsterSpawnManager.MONSTER_LIST] = ml if msm_list else 0
                i32[ml + List.SIZE] = msm_size
            elif name == "LogManager":
                ll = inst + 0x50000
                ptr[inst + LogManager.LOG_LIST] = ll if lm_list else 0
                i32[ll + List.SIZE] = lm_size
            # StageManager needs no size (accepted as-is)
    return FakeReader(ptr=ptr, cstr=cstr, i32=i32)


ALL = list(IDX.keys())


# --------------------------------------------------------------------------- #
# Happy path
# --------------------------------------------------------------------------- #
def test_happy_path_shape():
    r = _build(ALL)
    classes, instances = resolver.resolve_via_rva(r, TBASE, IDX, ALL)
    # classes: {name: {K}} for all
    assert classes == {name: {KOF[name]} for name in ALL}
    # singletons: [inst]; rest: []
    assert instances["StageClearLog"] == []
    assert instances["CurrencySaveData"] == []
    for name in resolver.SINGLETONS:
        assert len(instances[name]) == 1 and instances[name][0]


def test_singletons_constant():
    assert resolver.SINGLETONS == {"MonsterSpawnManager", "LogManager", "StageManager"}


def test_stagemanager_accepted_without_size_check():
    """StageManager: bbwf accepted without party validation (deferred to deliverable 06)."""
    r = _build(["StageManager"])
    out = resolver.resolve_via_rva(r, TBASE, IDX, ["StageManager"])
    assert out is not None
    _, instances = out
    assert len(instances["StageManager"]) == 1


# --------------------------------------------------------------------------- #
# Name mismatch → None
# --------------------------------------------------------------------------- #
def test_name_mismatch_returns_none():
    """class_name at the index != expected name (poisoned anchor/index) → None → scan."""
    r = _build(["StageClearLog"])
    # poison: the name read at the slot becomes something else
    r._cstr[KOF["StageClearLog"] + 0x800] = "WrongClass"
    assert resolver.resolve_via_rva(r, TBASE, IDX, ["StageClearLog"]) is None


def test_missing_index_returns_none():
    r = _build(["StageClearLog"])
    assert resolver.resolve_via_rva(r, TBASE, {}, ["StageClearLog"]) is None


def test_null_class_returns_none():
    """Index points to an empty slot (K=0) → None."""
    r = _build(["StageClearLog"])
    assert resolver.resolve_via_rva(r, TBASE, {"StageClearLog": 999}, ["StageClearLog"]) is None


# --------------------------------------------------------------------------- #
# Manager instance size out of range → None
# --------------------------------------------------------------------------- #
def test_msm_size_out_of_range_returns_none():
    """MonsterSpawnManager with MONSTER_LIST size >= 2000 (menu garbage) → None."""
    r = _build(["MonsterSpawnManager"], msm_size=2001)
    assert resolver.resolve_via_rva(r, TBASE, IDX, ["MonsterSpawnManager"]) is None


def test_lm_size_out_of_range_returns_none():
    """LogManager with LOG_LIST size >= 100000 → None (LOG_LIST grows the entire session)."""
    r = _build(["LogManager"], lm_size=100001)
    assert resolver.resolve_via_rva(r, TBASE, IDX, ["LogManager"]) is None


def test_msm_negative_size_returns_none():
    r = _build(["MonsterSpawnManager"], msm_size=-1)
    assert resolver.resolve_via_rva(r, TBASE, IDX, ["MonsterSpawnManager"]) is None


def test_msm_null_list_returns_none():
    """MONSTER_LIST null → size read at (0 + List.SIZE) → None (not None but read fails)."""
    r = _build(["MonsterSpawnManager"], msm_list=False)
    assert resolver.resolve_via_rva(r, TBASE, IDX, ["MonsterSpawnManager"]) is None


def test_size_at_boundary_accepted():
    """size 0 and 499 (MSM) / 0 and 4999 (LM) stay WITHIN range → accepted."""
    r = _build(["MonsterSpawnManager", "LogManager"], msm_size=499, lm_size=4999)
    out = resolver.resolve_via_rva(r, TBASE, IDX, ["MonsterSpawnManager", "LogManager"])
    assert out is not None
    r0 = _build(["MonsterSpawnManager", "LogManager"], msm_size=0, lm_size=0)
    assert resolver.resolve_via_rva(r0, TBASE, IDX, ["MonsterSpawnManager", "LogManager"]) is not None
