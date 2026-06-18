"""typeinfo.py — resolução IL2CPP por RVA FIXO + TypeInfoTable (read-only, name-free).

Mata o cold-start scan: em vez de varrer ~2.6 GB procurando as strings de classe, lê a
TypeInfoTable do runtime IL2CPP por um ANCHOR de RVA FIXO dentro da GameAssembly.dll e indexa
classes por TypeDefIndex (constante do build). Os Il2CppClass moram no heap (ASLR), MAS o
ponteiro da tabela mora num RVA fixo do módulo, reescrito pelo runtime a cada launch — ler
`[ga_base + ANCHOR_RVA]` ao vivo dá a base atual. Índices são constantes do build.

CADEIA PROVADA (build v1.00.07; ver tasks/meter-rva-startup/README.md):
    ga_base + ANCHOR_RVA → s_TypeInfoTable (ponteiro no heap)
    table_base + TypeDefIndex*8 → Il2CppClass*

São SÓ os primitivos puros — NENHUMA fiação em resolve_all/meter_windows (vem nas deliverables
seguintes). Espelha a lógica provada nos probes tbh-meter-dev/rva_probe{3,6,7}.py.

INVARIANTES (tbh-meter-review):
  §3 NAME-FREE — classes vêm por ÍNDICE/ESTRUTURA. `class_name` SÓ valida, NUNCA escolhe classe.
  §10 MEMORY SAFETY — read-only; todo rptr/ri32 checa None antes de usar; walks têm cap.
  §2 OFFSETS — usa Class.* de config/offsets.py. Offsets de FORMATO PE e de struct
     IL2CPP-runtime NÃO são offsets de jogo (dump.cs) — são layout de SO/runtime, então moram
     aqui como constantes de módulo documentadas (não duplicar em offsets.py).
  Importável no mac — kernel32 é lazy (reusa shared.memory._kernel32), não dispara WinDLL no import.
"""

import ctypes
import struct
from ctypes import wintypes

from config.offsets import Class
from shared import memory
from shared.memory import MODULEENTRY32

# --------------------------------------------------------------------------- #
# Constantes de FORMATO PE (Windows DLL) — NÃO são offsets de jogo (dump.cs),
# são o layout do header PE/COFF, fixo pelo SO. Por isso moram aqui, não em offsets.py.
# Ref: PE/COFF spec (DOS header e_lfanew @0x3C; "PE\0\0" sig; COFF + Optional Header).
# --------------------------------------------------------------------------- #
PE_LFANEW = 0x3C            # DOS header: offset (DWORD) p/ o PE signature
PE_SIG = b"PE\x00\x00"      # assinatura logo em [base + e_lfanew]
PE_TIMEDATESTAMP = 0x8      # COFF FileHeader: TimeDateStamp (DWORD), relativo ao PE sig
PE_SIZEOFIMAGE = 0x18 + 0x38  # Optional Header (após 0x18 do COFF) + offset 0x38 = SizeOfImage

# Toolhelp module-snapshot flags (mesmas de shared.memory; replicadas p/ legibilidade local).
TH32CS_SNAPMODULE = memory.TH32CS_SNAPMODULE
TH32CS_SNAPMODULE32 = memory.TH32CS_SNAPMODULE32

# Caps de varredura (§10): nº máx. de entradas a andar na TypeInfoTable e tamanho do bloco
# lido por syscall. A tabela do build provado tem alguns milhares de slots; 40k é folga ampla.
_TABLE_BLOCK = 8192         # ptrs lidos por syscall no walk (1 read em vez de N)
_MAX_TABLE_ENTRIES = 40000  # cap duro do walk (§10 — não andar infinito em tabela corrompida)

# Bounds plausíveis de um Il2CppClass* no x64 (mesmo critério dos probes / is_class).
_K_MIN = 0x10000
_K_MAX = 0x7FFFFFFFFFFF


def ga_module(pid):
    """Base e tamanho de carga da GameAssembly.dll do processo `pid`, via Toolhelp module
    snapshot. (base:int|None, size:int|None) — (None, None) se não achar/falhar.

    Reusa o kernel32 lazy de shared.memory MAS seta os argtypes de Module32First/Next aqui:
    o _kernel32() do shared os seta também, mas os probes exigiram setá-los explicitamente p/
    não TRUNCAR o handle 64-bit (ctypes assume int 32-bit sem argtypes). Defensivo e barato."""
    k = memory._kernel32()
    k.Module32First.argtypes = [wintypes.HANDLE, ctypes.POINTER(MODULEENTRY32)]
    k.Module32Next.argtypes = [wintypes.HANDLE, ctypes.POINTER(MODULEENTRY32)]
    snap = k.CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pid)
    if not snap or snap == memory.INVALID_HANDLE:
        return None, None
    try:
        e = MODULEENTRY32()
        e.dwSize = ctypes.sizeof(MODULEENTRY32)
        ok = k.Module32First(snap, ctypes.byref(e))
        while ok:
            if e.szModule.lower() == b"gameassembly.dll":
                return int(e.modBaseAddr), int(e.modBaseSize)
            ok = k.Module32Next(snap, ctypes.byref(e))
    finally:
        k.CloseHandle(snap)
    return None, None


def build_fingerprint(reader, base, version=None):
    """Identidade do build da GameAssembly.dll = chave do cache de calibração. None se o
    header PE não puder ser lido (caller cai no scan).

    fp = f"{version}-{TimeDateStamp:#x}-{SizeOfImage:#x}".

    AMENDMENT R1: TimeDateStamp pode ser 0 (builds determinísticos/reprodutíveis) e SizeOfImage
    pode colidir entre rebuilds → reforça com a VERSÃO instalada (Version.txt, via
    _detect_game_version no caller). Se TimeDateStamp==0, NÃO o usa como componente de
    identidade (vira "0x0" mas a versão + SizeOfImage carregam a identidade; o caller loga e
    pode cair no scan se desconfiar). Build v1.00.07 = TimeDateStamp 0x6a203f51, SizeOfImage
    0x62ea000."""
    if not base:
        return None
    e_lfanew = reader.ri32(base + PE_LFANEW)
    if not e_lfanew:
        return None
    pe = base + e_lfanew
    if reader.read(pe, 4) != PE_SIG:
        return None
    tds = reader.ri32(pe + PE_TIMEDATESTAMP)
    soi = reader.ri32(pe + PE_SIZEOFIMAGE)
    if tds is None or soi is None:
        return None
    tds &= 0xFFFFFFFF
    soi &= 0xFFFFFFFF
    ver = version if version else "?"
    return f"{ver}-{tds:#x}-{soi:#x}"


def table_base(reader, ga_base, anchor_rva):
    """Base atual da s_TypeInfoTable = ponteiro vivo em [ga_base + anchor_rva]. None se nulo
    (anchor errado / módulo ainda não inicializado)."""
    if not ga_base or anchor_rva is None:
        return None
    return reader.rptr(ga_base + anchor_rva)


def class_by_index(reader, tbase, idx):
    """Il2CppClass* no TypeDefIndex `idx` = [tbase + idx*8]. None se nulo. NÃO valida que é
    classe (use class_name p/ validar) — é só a deref crua da tabela."""
    if not tbase or idx is None or idx < 0:
        return None
    return reader.rptr(tbase + idx * 8)


def class_name(reader, K):
    """VALIDA que K é um Il2CppClass e devolve seu nome, ou None. SÓ p/ VALIDAÇÃO (§3) —
    NUNCA p/ escolher classe (isso é por índice). Critério (idêntico aos probes):
      • bounds: _K_MIN <= K <= _K_MAX e 8-alinhado;
      • nm = read_cstr([K + Class.NAME]) não vazio;
      • round-trip de classe: [K + Class.ELEMENT_CLASS]==K OU [K + Class.CAST_CLASS]==K
        (Il2CppClass de tipo normal aponta element/cast pra si mesmo)."""
    if not K or K < _K_MIN or K > _K_MAX or (K & 0x7):
        return None
    nm = reader.read_cstr(reader.rptr(K + Class.NAME))
    if not nm:
        return None
    if reader.rptr(K + Class.ELEMENT_CLASS) == K or reader.rptr(K + Class.CAST_CLASS) == K:
        return nm
    return None


def walk_table_names(reader, tbase, wanted, maxn=_MAX_TABLE_ENTRIES):
    """Anda a TypeInfoTable lendo nomes e coleta {nome: K} dos que estão em `wanted`.
    Calibração SCAN-FREE (~0.1s na prova): lê em blocos de _TABLE_BLOCK ptrs por syscall,
    valida cada ptr não-nulo com class_name, early-exit quando achar TODOS. `maxn` é o cap
    duro (§10). `wanted` = set/iterable de nomes ESTÁVEIS (não-ofuscados); name-free permanece
    porque a SAÍDA é índice→classe, e os nomes só identificam quais slots interessam."""
    want = set(wanted)
    out = {}
    if not tbase or not want:
        return out
    i0 = 0
    while i0 < maxn and len(out) < len(want):
        n = min(_TABLE_BLOCK, maxn - i0)
        b = reader.read(tbase + i0 * 8, n * 8)
        if not b:
            break
        m = len(b) // 8
        if m == 0:
            break
        ptrs = struct.unpack("<%dQ" % m, b[:m * 8])
        for K in ptrs:
            if not K:
                continue
            nm = class_name(reader, K)
            if nm in want and nm not in out:
                out[nm] = K
                if len(out) == len(want):
                    break
        i0 += m
    return out


def _walk_dense_table_start(reader, seed_slot, regs, cap=0x800000):
    """Dado um SLOT (endereço que contém um Il2CppClass* conhecido), acha onde COMEÇA o array
    DENSO de Il2CppClass* que o contém, andando pra trás de página em página enquanto a página
    continua majoritariamente preenchida por ponteiros-classe plausíveis. Espelha walk_bounds
    do rva_probe3 (semente generosa; a verificação completa em discover_anchor é quem cravna).
    `regs` limita a região (não sair dela). None se o seed nem estiver numa região conhecida."""
    if not memory.in_region(regs, seed_slot):
        return None

    def filled_ratio(page):
        b = reader.read(page, 4096)
        if not b or len(b) < 64:
            return 0.0
        m = len(b) // 8
        vals = struct.unpack("<%dQ" % m, b[:m * 8])
        good = sum(1 for v in vals if _K_MIN <= v <= _K_MAX and not (v & 0x7))
        return good / m

    pg = seed_slot & ~0xFFF
    low = pg
    while low > pg - cap and memory.in_region(regs, low - 0x1000) and filled_ratio(low - 0x1000) >= 0.45:
        low -= 0x1000
    return low


def discover_anchor(reader, ga_base, ga_size, known_K, regs):
    """DESCOBRE o (anchor_rva, table_base, indices) em tempo de CALIBRAÇÃO, DETERMINÍSTICO
    (não busca fuzzy). `known_K` = {nome: K} de classes JÁ resolvidas (pelo scan legado);
    `regs` = regiões READABLE já enumeradas por resolve_all (NÃO re-enumerar — o sweep é caro).
    Retorna (anchor_rva, table_base, {nome: idx}) ou None se não convergir (caller mantém o scan).

    AMENDMENT R1 + NEW-4 (determinístico, deriva de UM slot e VERIFICA a tabela inteira):
      (1) backref de UM known_K (um sweep grande sobre READABLE) → slots candidatos que CONTÊM
          esse ponteiro (usa shared.memory.scan needle 8-alinhado, como gold._backrefs);
      (2) p/ cada slot, derivar onde COMEÇA o array denso de Il2CppClass* (_walk_dense_table_start,
          janela generosa — índices são ESPAROS, ex. StageManager 2592 ↔ HeroInfoData 3198,
          então janela apertada FALSE-FALHA);
      (3) VERIFICAÇÃO COMPLETA (à prova de false-pass): p/ um candidato table_base, computa
          idx[nome] = (slot_do_known_K - table_base)/8 e confirma class_by_index→nome p/ TODOS
          os known_K via round-trip de class_name. Só aceita se TODOS baterem;
      (4) achar o ptr IN-MODULE (em [ga_base, ga_base+ga_size)) cujo valor == table_base →
          anchor_rva = loc - ga_base. Retorna os índices verificados (sem walk separado)."""
    known = {nm: K for nm, K in (known_K or {}).items() if K}
    if not ga_base or not ga_size or len(known) < 3:
        return None

    # (1) backref de UM known_K — um único sweep grande. Pega um determinístico (menor nome).
    seed_name = sorted(known)[0]
    seed_K = known[seed_name]
    needle = struct.pack("<Q", seed_K)
    seed_slots = memory.scan(reader, regs, [needle], aligned=True).get(needle, [])
    if not seed_slots:
        return None

    # (2)+(3): p/ cada slot do seed, derivar a base do array denso e VERIFICAR a tabela inteira.
    # Só temos backref do seed (um sweep). Derivamos o candidato table_base do slot do seed,
    # confirmamos que o ÍNDICE do seed bate por nome, e então exigimos que TODOS os known_K
    # apareçam em algum índice (leitura direta da tabela, barata) — verificação à prova de
    # false-pass. Janela generosa no walk evita false-fail em índices esparsos.
    tested = set()
    for slot in seed_slots:
        cand = _walk_dense_table_start(reader, slot, regs)
        if not cand or cand in tested:
            continue
        tested.add(cand)
        # `cand` é APROXIMADO: o walk para algumas entradas ACIMA da base real (índices baixos —
        # tipos de engine — são esparsos/baixo-fill). Pré-filtro BARATO (sem varrer módulo): a
        # tabela a partir de `cand` tem que conter TODOS os known_K; senão `cand` é lixo, pula.
        if _verify_table(reader, cand, known) is None:
            continue
        # O anchor in-module guarda a base VERDADEIRA (== ou pouco ABAIXO de `cand`), NÃO `cand`.
        # Acha por RANGE e RE-VERIFICA a tabela a partir do valor real (autoritativo). O match
        # EXATO em `cand` falhava — o global guarda a base real, não a base aproximada do walk;
        # foi o bug que travava a calibração mesmo no build provado (rva_probe3 usa range).
        res = _find_table_anchor(reader, ga_base, ga_size, cand, known, regs)
        if res is not None:
            return res
    return None


def _verify_table(reader, tbase, known):
    """Confirma que TODOS os known_K aparecem em algum índice da tabela `tbase` (leitura direta,
    barata) com round-trip de nome. Retorna {nome: idx} se TODOS baterem, senão None (rejeita
    o candidato → à prova de false-pass)."""
    want_by_K = {K: nm for nm, K in known.items()}
    found = {}
    i0 = 0
    while i0 < _MAX_TABLE_ENTRIES and len(found) < len(known):
        n = min(_TABLE_BLOCK, _MAX_TABLE_ENTRIES - i0)
        b = reader.read(tbase + i0 * 8, n * 8)
        if not b:
            break
        m = len(b) // 8
        if m == 0:
            break
        ptrs = struct.unpack("<%dQ" % m, b[:m * 8])
        for j, K in enumerate(ptrs):
            if K in want_by_K:
                nm = want_by_K[K]
                if nm not in found and class_name(reader, K) == nm:
                    found[nm] = i0 + j
        i0 += m
    return found if len(found) == len(known) else None


def _find_table_anchor(reader, ga_base, ga_size, approx_base, known, regs):
    """Acha o ANCHOR in-module: um ptr 8-alinhado em [ga_base, ga_base+ga_size) cujo VALOR é a
    base VERDADEIRA da tabela. O `_walk_dense_table_start` para algumas entradas ACIMA da base
    real (índices baixos esparsos) → o anchor NÃO guarda `approx_base`, e sim a base real (== ou
    pouco abaixo). Varre o módulo por ptrs com valor PERTO de `approx_base` e, p/ cada valor-
    candidato, RE-VERIFICA a tabela inteira a partir dele (autoritativo). Retorna
    (anchor_rva, real_base, {nome: idx}) ou None. Espelha a busca por RANGE do rva_probe3."""
    lo, hi = ga_base, ga_base + ga_size
    modregs = [(b, s) for (b, s) in regs if lo <= b < hi]
    # a base real está EM ou pouco ABAIXO de approx_base (o walk para alto, nunca abaixo).
    locs = memory.scan_i64_range(reader, modregs, approx_base - 0x10000, approx_base + 0x1000)
    seen, cands = set(), []
    for loc in locs:
        v = reader.rptr(loc)
        if v and v not in seen:
            seen.add(v)
            cands.append((v, loc))
    for val, loc in sorted(cands):              # menor valor primeiro = mais perto do índice 0
        idxs = _verify_table(reader, val, known)
        if idxs is not None:
            return loc - ga_base, val, idxs
    return None
