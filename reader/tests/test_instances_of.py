"""Tests for il2cpp/resolver.instances_of — targeted backref from the fast path (mac, no process).

`instances_of` is resolve()'s pass3 in isolation: given {name: K} (classes already resolved by index),
it finds the INSTANCES via ONE scan of 8-aligned pointers over the READABLE regions. Used by the fast
path (deliverable 05/02) for PlayerSaveData/CommonSaveData/StageManager without the full scan.

Covers:
  happy path  — finds the addresses pointing at each K (1 scan, several needles)
  self-refs   — pointers within [K, K+0x400) (the Il2CppClass itself) are EXCLUDED
  cap         — per-class instance ceiling honored
  null K      — K=0/None ignored (doesn't become a needle)

BlobReader is byte-backed: `instances_of` calls shared.memory.scan (which reads blocks via reader.read),
so we build ONE byte region with genuinely 8-aligned pointers and use the real scan.
"""

import struct

from il2cpp import resolver


class BlobReader:
    """Minimal reader for shared.memory.scan: only needs .read(addr, size) over a region."""

    def __init__(self, base, blob):
        self._base = base
        self._blob = blob

    def read(self, addr, size):
        off = addr - self._base
        if off < 0 or off >= len(self._blob):
            return None
        return self._blob[off:off + size]


BASE = 0x10000000


def _blob_with_ptrs(ptrs):
    """Build a blob where position i*8 holds the qword ptrs[i] (8-aligned)."""
    return b"".join(struct.pack("<Q", p) for p in ptrs)


def test_happy_path_finds_instances():
    """Two K's; every 8-aligned qword that == K becomes an instance address."""
    K_PSD = 0x900000
    K_CSD = 0xA00000
    # slots: [K_PSD, junk, K_CSD, K_PSD]  → PSD at offsets 0 and 24, CSD at offset 16
    ptrs = [K_PSD, 0xDEAD, K_CSD, K_PSD]
    r = BlobReader(BASE, _blob_with_ptrs(ptrs))
    out = resolver.instances_of(r, [(BASE, len(ptrs) * 8)],
                                {"PlayerSaveData": K_PSD, "CommonSaveData": K_CSD})
    assert sorted(out["PlayerSaveData"]) == [BASE + 0, BASE + 24]
    assert out["CommonSaveData"] == [BASE + 16]


def test_excludes_self_refs():
    """Pointers to K that sit WITHIN [K, K+0x400) (the class itself) are excluded."""
    K = BASE + 0x100        # K falls within its own region
    # slot 0 == K but the slot's ADDRESS (BASE+0) is outside [K,K+0x400) → keep
    # slot at K+0x40 (within [K,K+0x400)) also == K → self-ref, exclude
    n = (0x100 + 0x40) // 8 + 1
    ptrs = [0] * n
    ptrs[0] = K                          # address BASE+0 → outside the self-ref window → keep
    ptrs[(0x100 + 0x40) // 8] = K        # address BASE+0x140 → within [K,K+0x400) → exclude
    r = BlobReader(BASE, _blob_with_ptrs(ptrs))
    out = resolver.instances_of(r, [(BASE, len(ptrs) * 8)], {"StageManager": K})
    assert out["StageManager"] == [BASE + 0]


def test_cap_limits_instances():
    K = 0x900000
    ptrs = [K] * 10
    r = BlobReader(BASE, _blob_with_ptrs(ptrs))
    out = resolver.instances_of(r, [(BASE, len(ptrs) * 8)], {"PlayerSaveData": K}, cap=3)
    assert len(out["PlayerSaveData"]) == 3


def test_null_k_ignored():
    """K None/0 doesn't become a needle; exits with empty list, no scan for that name."""
    K = 0x900000
    ptrs = [K, K]
    r = BlobReader(BASE, _blob_with_ptrs(ptrs))
    out = resolver.instances_of(r, [(BASE, len(ptrs) * 8)],
                                {"PlayerSaveData": K, "CommonSaveData": 0, "StageManager": None})
    assert sorted(out["PlayerSaveData"]) == [BASE + 0, BASE + 8]
    assert "CommonSaveData" not in out
    assert "StageManager" not in out


def test_empty_targets():
    r = BlobReader(BASE, b"")
    assert resolver.instances_of(r, [(BASE, 0)], {}) == {}
    assert resolver.instances_of(r, [(BASE, 0)], None) == {}
