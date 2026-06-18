"""Testes para il2cpp/typeinfo.py — só os bits PUROS (mac-importáveis, sem processo vivo).

Cobre:
  build_fingerprint — parse do header PE (TimeDateStamp + SizeOfImage + versão), guard de erros
  class_name        — validação de Il2CppClass (bounds, round-trip element/cast); SÓ valida
  class_by_index    — deref crua da tabela
  table_base        — deref do anchor
  walk_table_names  — coleta nome→K dos `wanted`, early-exit, cap

ga_module / discover_anchor exigem processo vivo + kernel32 (Windows) → não testados aqui.
"""

import struct

from config.offsets import Class
from il2cpp import typeinfo


class FakeReader:
    """Reader em memória que suporta o que typeinfo usa: read (bytes), ri32, rptr, read_cstr.

    mem: {addr: bytes} — blocos crus; read() fatia a partir do bloco que contém o addr.
    Para simplicidade os helpers tipados (ri32/rptr/read_cstr) leem de dicts dedicados.
    """

    def __init__(self, blobs=None, i32=None, ptr=None, cstr=None):
        self._blobs = dict(blobs or {})       # {base: bytes}
        self._i32 = dict(i32 or {})
        self._ptr = dict(ptr or {})
        self._cstr = dict(cstr or {})

    def read(self, addr, size):
        for base, data in self._blobs.items():
            if base <= addr < base + len(data):
                off = addr - base
                chunk = data[off:off + size]
                return chunk if chunk else None
        return None

    def ri32(self, addr):
        return self._i32.get(addr)

    def rptr(self, addr):
        return self._ptr.get(addr)

    def read_cstr(self, addr, maxlen=64):
        return self._cstr.get(addr)


# --------------------------------------------------------------------------- #
# build_fingerprint
# --------------------------------------------------------------------------- #
class TestBuildFingerprint:
    def _reader(self, base, e_lfanew, sig, tds, soi):
        pe = base + e_lfanew
        return FakeReader(
            blobs={pe: sig},
            i32={
                base + typeinfo.PE_LFANEW: e_lfanew,
                pe + typeinfo.PE_TIMEDATESTAMP: tds,
                pe + typeinfo.PE_SIZEOFIMAGE: soi,
            },
        )

    def test_v1_00_07_known_build(self):
        """fp do build provado: versão + TimeDateStamp 0x6a203f51 + SizeOfImage 0x62ea000."""
        base = 0x7FF800000000
        r = self._reader(base, 0x100, typeinfo.PE_SIG, 0x6A203F51, 0x62EA000)
        assert typeinfo.build_fingerprint(r, base, version="1.00.07") == "1.00.07-0x6a203f51-0x62ea000"

    def test_version_none_uses_placeholder(self):
        base = 0x10000000
        r = self._reader(base, 0x80, typeinfo.PE_SIG, 0x1234, 0x5000)
        assert typeinfo.build_fingerprint(r, base) == "?-0x1234-0x5000"

    def test_timedatestamp_zero_still_builds_fp(self):
        """TimeDateStamp==0 (build determinístico) NÃO derruba o fp — versão + size carregam."""
        base = 0x10000000
        r = self._reader(base, 0x80, typeinfo.PE_SIG, 0, 0x5000)
        assert typeinfo.build_fingerprint(r, base, version="1.00.07") == "1.00.07-0x0-0x5000"

    def test_masks_to_32_bit(self):
        """ri32 pode vir negativo (signed); o fp usa o valor unsigned de 32 bits."""
        base = 0x10000000
        r = self._reader(base, 0x80, typeinfo.PE_SIG, -1, -1)
        assert typeinfo.build_fingerprint(r, base, version="v") == "v-0xffffffff-0xffffffff"

    def test_none_base_returns_none(self):
        assert typeinfo.build_fingerprint(FakeReader(), 0) is None

    def test_no_e_lfanew_returns_none(self):
        base = 0x10000000
        r = FakeReader(i32={base + typeinfo.PE_LFANEW: 0})
        assert typeinfo.build_fingerprint(r, base) is None

    def test_bad_pe_signature_returns_none(self):
        base = 0x10000000
        r = self._reader(base, 0x80, b"MZ\x00\x00", 0x1, 0x1)
        assert typeinfo.build_fingerprint(r, base) is None


# --------------------------------------------------------------------------- #
# class_name — SÓ validação (§3 name-free)
# --------------------------------------------------------------------------- #
class TestClassName:
    def _valid(self, K, name, self_ref="elem"):
        """FakeReader onde K é um Il2CppClass válido com nome `name`."""
        name_ptr = K + 0x1000
        ptr = {K + Class.NAME: name_ptr}
        if self_ref == "elem":
            ptr[K + Class.ELEMENT_CLASS] = K
        elif self_ref == "cast":
            ptr[K + Class.CAST_CLASS] = K
        return FakeReader(ptr=ptr, cstr={name_ptr: name})

    def test_valid_class_via_element(self):
        K = 0x20000
        assert typeinfo.class_name(self._valid(K, "StageManager", "elem"), K) == "StageManager"

    def test_valid_class_via_cast(self):
        K = 0x20000
        assert typeinfo.class_name(self._valid(K, "LogManager", "cast"), K) == "LogManager"

    def test_obfuscated_name_still_validates(self):
        """class_name SÓ valida — devolve até nome ofuscado (a ESCOLHA é por índice, não nome)."""
        K = 0x20000
        assert typeinfo.class_name(self._valid(K, "uu", "elem"), K) == "uu"

    def test_null_K_returns_none(self):
        assert typeinfo.class_name(FakeReader(), 0) is None

    def test_below_bounds_returns_none(self):
        assert typeinfo.class_name(FakeReader(), 0xFFFF) is None

    def test_above_bounds_returns_none(self):
        assert typeinfo.class_name(FakeReader(), 0x800000000000) is None

    def test_misaligned_returns_none(self):
        """Il2CppClass é sempre 8-alinhado; ptr ímpar não é classe."""
        assert typeinfo.class_name(FakeReader(), 0x20001) is None

    def test_empty_name_returns_none(self):
        K = 0x20000
        r = FakeReader(ptr={K + Class.NAME: K + 0x1000, K + Class.ELEMENT_CLASS: K},
                       cstr={K + 0x1000: ""})
        assert typeinfo.class_name(r, K) is None

    def test_no_self_reference_returns_none(self):
        """Sem element/cast == K → não é Il2CppClass de tipo normal → rejeita (anti false-pass)."""
        K = 0x20000
        r = FakeReader(ptr={K + Class.NAME: K + 0x1000}, cstr={K + 0x1000: "NotAClass"})
        assert typeinfo.class_name(r, K) is None


# --------------------------------------------------------------------------- #
# class_by_index / table_base — deref cruas
# --------------------------------------------------------------------------- #
class TestDerefs:
    def test_class_by_index(self):
        tbase = 0x50000
        r = FakeReader(ptr={tbase + 2592 * 8: 0xABCDE0})
        assert typeinfo.class_by_index(r, tbase, 2592) == 0xABCDE0

    def test_class_by_index_null_tbase(self):
        assert typeinfo.class_by_index(FakeReader(), 0, 5) is None

    def test_class_by_index_negative_idx(self):
        assert typeinfo.class_by_index(FakeReader(), 0x50000, -1) is None

    def test_class_by_index_none_idx(self):
        assert typeinfo.class_by_index(FakeReader(), 0x50000, None) is None

    def test_table_base(self):
        ga_base = 0x140000000
        anchor = 0x5B070E0
        r = FakeReader(ptr={ga_base + anchor: 0x50000})
        assert typeinfo.table_base(r, ga_base, anchor) == 0x50000

    def test_table_base_null_ga_base(self):
        assert typeinfo.table_base(FakeReader(), 0, 0x5B070E0) is None

    def test_table_base_none_anchor(self):
        assert typeinfo.table_base(FakeReader(), 0x140000000, None) is None


# --------------------------------------------------------------------------- #
# walk_table_names — coleta nome→K, early-exit, cap
# --------------------------------------------------------------------------- #
def _table_reader(tbase, entries, names):
    """FakeReader com uma TypeInfoTable: `entries` = [K por índice] (0 = vazio);
    `names` = {K: nome} p/ os K válidos (round-trip element + read_cstr)."""
    blob = b"".join(struct.pack("<Q", k) for k in entries)
    ptr = {}
    cstr = {}
    for K, nm in names.items():
        name_ptr = K + 0x1000
        ptr[K + Class.NAME] = name_ptr
        ptr[K + Class.ELEMENT_CLASS] = K
        cstr[name_ptr] = nm
    return FakeReader(blobs={tbase: blob}, ptr=ptr, cstr=cstr)


class TestWalkTableNames:
    def test_collects_wanted_names(self):
        tbase = 0x50000
        # índices: 0 vazio, 1 = StageManager, 2 = lixo (não-classe), 3 = LogManager
        entries = [0, 0x20000, 0x99, 0x20100]
        names = {0x20000: "StageManager", 0x20100: "LogManager"}
        r = _table_reader(tbase, entries, names)
        got = typeinfo.walk_table_names(r, tbase, {"StageManager", "LogManager"})
        assert got == {"StageManager": 0x20000, "LogManager": 0x20100}

    def test_ignores_unwanted(self):
        tbase = 0x50000
        entries = [0x20000, 0x20100]
        names = {0x20000: "StageManager", 0x20100: "LogManager"}
        r = _table_reader(tbase, entries, names)
        got = typeinfo.walk_table_names(r, tbase, {"StageManager"})
        assert got == {"StageManager": 0x20000}

    def test_empty_wanted_returns_empty(self):
        assert typeinfo.walk_table_names(FakeReader(), 0x50000, set()) == {}

    def test_null_tbase_returns_empty(self):
        assert typeinfo.walk_table_names(FakeReader(), 0, {"X"}) == {}

    def test_missing_name_simply_absent(self):
        """Nome pedido que não está na tabela → ausente do dict, sem crash."""
        tbase = 0x50000
        entries = [0x20000]
        names = {0x20000: "StageManager"}
        r = _table_reader(tbase, entries, names)
        got = typeinfo.walk_table_names(r, tbase, {"StageManager", "Missing"})
        assert got == {"StageManager": 0x20000}

    def test_maxn_cap_stops_walk(self):
        """Com maxn=1 só lê o 1º slot — o 2º (LogManager) não é alcançado."""
        tbase = 0x50000
        entries = [0x20000, 0x20100]
        names = {0x20000: "StageManager", 0x20100: "LogManager"}
        r = _table_reader(tbase, entries, names)
        got = typeinfo.walk_table_names(r, tbase, {"StageManager", "LogManager"}, maxn=1)
        assert got == {"StageManager": 0x20000}
