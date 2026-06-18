"""Testes para il2cpp/resolver.instances_of — backref direcionado do fast path (mac, sem processo).

`instances_of` é a pass3 do resolve() isolada: dado {nome: K} (classes já resolvidas por índice),
acha as INSTÂNCIAS por UM scan de ponteiros 8-alinhados às regiões READABLE. Usado pelo fast path
(deliverable 05/02) pra PlayerSaveData/CommonSaveData/StageManager sem o scan completo.

Cobre:
  happy path  — acha os endereços que apontam pra cada K (1 scan, vários needles)
  self-refs   — ponteiros em [K, K+0x400) (a própria Il2CppClass) são EXCLUÍDOS
  cap         — teto de instâncias por classe respeitado
  null K      — K=0/None ignorado (não vira needle)

BlobReader é byte-backed: `instances_of` chama shared.memory.scan (que lê blocos via reader.read),
então montamos UMA região de bytes com ponteiros 8-alinhados de verdade e usamos o scan real.
"""

import struct

from il2cpp import resolver


class BlobReader:
    """Reader mínimo p/ shared.memory.scan: só precisa de .read(addr, size) sobre uma região."""

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
    """Monta um blob onde a posição i*8 contém o qword ptrs[i] (8-alinhado)."""
    return b"".join(struct.pack("<Q", p) for p in ptrs)


def test_happy_path_finds_instances():
    """Dois K's; cada qword 8-alinhado que == K vira um endereço de instância."""
    K_PSD = 0x900000
    K_CSD = 0xA00000
    # slots: [K_PSD, junk, K_CSD, K_PSD]  → PSD em offsets 0 e 24, CSD em offset 16
    ptrs = [K_PSD, 0xDEAD, K_CSD, K_PSD]
    r = BlobReader(BASE, _blob_with_ptrs(ptrs))
    out = resolver.instances_of(r, [(BASE, len(ptrs) * 8)],
                                {"PlayerSaveData": K_PSD, "CommonSaveData": K_CSD})
    assert sorted(out["PlayerSaveData"]) == [BASE + 0, BASE + 24]
    assert out["CommonSaveData"] == [BASE + 16]


def test_excludes_self_refs():
    """Ponteiros pra K que estão DENTRO de [K, K+0x400) (a própria classe) são excluídos."""
    K = BASE + 0x100        # K cai dentro da própria região
    # slot 0 == K mas o ENDEREÇO do slot (BASE+0) está fora de [K,K+0x400) → mantém
    # slot em K+0x40 (dentro de [K,K+0x400)) também == K → self-ref, exclui
    n = (0x100 + 0x40) // 8 + 1
    ptrs = [0] * n
    ptrs[0] = K                          # endereço BASE+0 → fora da janela self-ref → mantém
    ptrs[(0x100 + 0x40) // 8] = K        # endereço BASE+0x140 → dentro de [K,K+0x400) → exclui
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
    """K None/0 não vira needle; sai com lista vazia, sem scan p/ esse nome."""
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
