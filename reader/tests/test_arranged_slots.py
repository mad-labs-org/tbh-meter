"""game/build.py — read_arranged_slots (per-hero party SLOT).

The run record carries no slot position, so the leaderboard rendered the party in an
unstable order. read_arranged_slots reads CommonSaveData.arrangedHeroKey (an int[] of
party slot -> heroKey) and returns {heroKey: slotIndex} for the non-empty slots — the
0-based `slot` attached to each run-hero. See [[invariants/party-live-resolution]] and the
run-data-map reference.

⚠ The array SHAPE (fixed-with-sentinel vs compacted) is unconfirmed at runtime — the
function logs the raw array (greppable `arranged_slots raw=`) for live validation. These
tests pin the contract regardless of which shape the live game uses: slot == array index,
empty entries (value <= 0) skipped.
"""

from config.offsets import CommonSaveData, Array
from game.build import read_arranged_slots
from tests.conftest import MockReader

CSD = 0x1000   # CommonSaveData address
ARR = 0x2000   # arrangedHeroKey int[] address


def _reader(values):
    """MockReader whose CSD.arrangedHeroKey is an int[] of `values` (slot -> heroKey).
    Each element lives at ARR + Array.DATA + i*4 (int[] = 4 bytes/element)."""
    mem = {
        CSD + CommonSaveData.ARRANGED_HERO_KEY: ARR,
        ARR + Array.MAX_LENGTH: len(values),
    }
    for i, v in enumerate(values):
        mem[ARR + Array.DATA + i * 4] = v
    return MockReader(mem=mem)


def test_normal_arrangement():
    # Three filled slots in order -> each hero maps to its array index.
    res = read_arranged_slots(_reader([101, 202, 303]), CSD)
    assert res == {101: 0, 202: 1, 303: 2}


def test_gap_arrangement_uses_array_index():
    # EMPTY | hero | EMPTY (fixed-with-sentinel shape): the hero is at index 1 -> slot 1.
    # The empty (0) entries are skipped, NOT emitted, and do NOT shift the surviving index.
    res = read_arranged_slots(_reader([0, 12345, 0]), CSD)
    assert res == {12345: 1}


def test_empty_array_is_empty_map():
    # All slots vacant (0) -> nobody gets a slot (empty map, never a 0-keyed entry).
    assert read_arranged_slots(_reader([0, 0, 0]), CSD) == {}


def test_negative_values_skipped():
    # Negative sentinel also counts as vacant (value <= 0 is skipped).
    res = read_arranged_slots(_reader([-1, 555, 0]), CSD)
    assert res == {555: 1}


def test_unreadable_returns_empty_map():
    # No CSD / arrangedHeroKey pointer unreadable -> {} (additive: slot simply absent).
    assert read_arranged_slots(MockReader(mem={}), CSD) == {}
    assert read_arranged_slots(_reader([101]), None) == {}


def test_garbage_length_rejected():
    # Bogus length (>12) -> not a real array -> {} (mirrors read_live_party's bound guard).
    reader = MockReader(mem={
        CSD + CommonSaveData.ARRANGED_HERO_KEY: ARR,
        ARR + Array.MAX_LENGTH: 9999,
    })
    assert read_arranged_slots(reader, CSD) == {}


def test_never_raises_on_failure():
    # A reader that raises on every access must NOT take down close_run -> {}.
    class BoomReader:
        def rptr(self, addr):
            raise RuntimeError("boom")

        def ri32(self, addr):
            raise RuntimeError("boom")

    assert read_arranged_slots(BoomReader(), CSD) == {}


def test_duplicate_keys_first_index_wins():
    # Defensive against a duplicate heroKey (shouldn't happen): the FIRST (lowest) index wins.
    res = read_arranged_slots(_reader([777, 777]), CSD)
    assert res == {777: 0}
