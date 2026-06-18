"""memory.py — acesso READ-ONLY à memória do jogo (a base de tudo).

Junta o que era memory/{structs,process,scanner,reader}.py num arquivo só:
  - structs/constantes Win32 (ctypes) do ReadProcessMemory/Toolhelp;
  - process: anexar (achar pid, abrir handle só-leitura, base do módulo);
  - scanner: enumerar regiões + varrer bytes (pro resolver IL2CPP);
  - Reader: leituras tipadas (ptr/int/float/list/dict/Dict8B) ligadas a UM handle.

INVIOLÁVEL: só PROCESS_QUERY_INFORMATION|PROCESS_VM_READ (sem WRITE, sem inject).
O kernel32 é lazy (_kernel32()), então importa em qualquer plataforma; só as funções
exigem Windows em runtime. Usado por il2cpp/ (acha classes) e pelas métricas (via Reader).
"""

import ctypes
import struct
import time
from ctypes import wintypes

from config.offsets import (PROCESS_NAME, MODULE_NAME,
                            Array, List, String, Dict, Dict8B)


# ============================ structs / constantes Win32 ===================== #
TH32CS_SNAPPROCESS = 0x2
TH32CS_SNAPMODULE = 0x8
TH32CS_SNAPMODULE32 = 0x10
PROCESS_QUERY_INFORMATION = 0x0400
PROCESS_VM_READ = 0x0010
INVALID_HANDLE = 0xFFFFFFFFFFFFFFFF
MAX_PATH = 260

MEM_COMMIT = 0x1000
PAGE_GUARD = 0x100
# PAGE_READONLY|READWRITE|WRITECOPY|EXECUTE_READ|EXECUTE_READWRITE|EXECUTE_WRITECOPY
READABLE = 0x02 | 0x04 | 0x08 | 0x20 | 0x40 | 0x80
# Subconjunto GRAVÁVEL (READWRITE|WRITECOPY|EXEC_READWRITE|EXEC_WRITECOPY) — onde vivem os
# objetos do heap gerenciado. Bem menor que READABLE (sem code/read-only) -> value-scan focado.
WRITABLE = 0x04 | 0x08 | 0x40 | 0x80


class PROCESSENTRY32(ctypes.Structure):
    _fields_ = [("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD),
                ("th32ProcessID", wintypes.DWORD),
                ("th32DefaultHeapID", ctypes.POINTER(ctypes.c_ulong)),
                ("th32ModuleID", wintypes.DWORD), ("cntThreads", wintypes.DWORD),
                ("th32ParentProcessID", wintypes.DWORD),
                ("pcPriClassBase", ctypes.c_long), ("dwFlags", wintypes.DWORD),
                ("szExeFile", ctypes.c_char * MAX_PATH)]


class MODULEENTRY32(ctypes.Structure):
    _fields_ = [("dwSize", wintypes.DWORD), ("th32ModuleID", wintypes.DWORD),
                ("th32ProcessID", wintypes.DWORD), ("GlblcntUsage", wintypes.DWORD),
                ("ProccntUsage", wintypes.DWORD), ("modBaseAddr", ctypes.c_void_p),
                ("modBaseSize", wintypes.DWORD), ("hModule", wintypes.HMODULE),
                ("szModule", ctypes.c_char * 256), ("szExePath", ctypes.c_char * MAX_PATH)]


class MBI(ctypes.Structure):
    _fields_ = [("BaseAddress", ctypes.c_void_p), ("AllocationBase", ctypes.c_void_p),
                ("AllocationProtect", wintypes.DWORD), ("PartitionId", wintypes.WORD),
                ("__pad", wintypes.WORD), ("RegionSize", ctypes.c_size_t),
                ("State", wintypes.DWORD), ("Protect", wintypes.DWORD),
                ("Type", wintypes.DWORD)]


# ============================ process: anexar (read-only) ==================== #
_K = None


def _kernel32():
    """WinDLL(kernel32) com argtypes, cacheado. Só funciona no Windows (lazy de propósito)."""
    global _K
    if _K is not None:
        return _K
    k = ctypes.WinDLL("kernel32", use_last_error=True)
    k.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    k.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    k.Process32First.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32)]
    k.Process32Next.argtypes = [wintypes.HANDLE, ctypes.POINTER(PROCESSENTRY32)]
    k.Module32First.argtypes = [wintypes.HANDLE, ctypes.POINTER(MODULEENTRY32)]
    k.Module32Next.argtypes = [wintypes.HANDLE, ctypes.POINTER(MODULEENTRY32)]
    k.OpenProcess.restype = wintypes.HANDLE
    k.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    k.ReadProcessMemory.argtypes = [wintypes.HANDLE, ctypes.c_void_p, ctypes.c_void_p,
                                    ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t)]
    k.VirtualQueryEx.restype = ctypes.c_size_t
    k.VirtualQueryEx.argtypes = [wintypes.HANDLE, ctypes.c_void_p,
                                 ctypes.POINTER(MBI), ctypes.c_size_t]
    k.CloseHandle.argtypes = [wintypes.HANDLE]
    k.QueryFullProcessImageNameW.restype = wintypes.BOOL
    k.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD,
                                             wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
    _K = k
    return k


def find_pid(name=None):
    nm = name or PROCESS_NAME
    nm = nm.encode() if isinstance(nm, str) else nm
    k = _kernel32()
    snap = k.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if not snap or snap == INVALID_HANDLE:
        return None
    try:
        e = PROCESSENTRY32()
        e.dwSize = ctypes.sizeof(PROCESSENTRY32)
        ok = k.Process32First(snap, ctypes.byref(e))
        while ok:
            if e.szExeFile.lower() == nm.lower():
                return e.th32ProcessID
            ok = k.Process32Next(snap, ctypes.byref(e))
    finally:
        k.CloseHandle(snap)
    return None


def open_process(pid):
    """Handle READ-ONLY (QUERY_INFORMATION|VM_READ). ÚNICO ponto de anexação auditado."""
    return _kernel32().OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, pid)


def close(handle):
    if handle:
        try:
            _kernel32().CloseHandle(handle)
        except Exception:
            pass


def process_image_path(handle):
    """Caminho completo do exe do processo anexado (QueryFullProcessImageNameW). Funciona
    com o handle read-only (PROCESS_QUERY_INFORMATION). None se falhar."""
    size = wintypes.DWORD(MAX_PATH * 4)
    buf = ctypes.create_unicode_buffer(size.value)
    if not _kernel32().QueryFullProcessImageNameW(handle, 0, buf, ctypes.byref(size)):
        return None
    return buf.value or None


def module_base(pid, name=None):
    """Base de carga de um módulo (enumera módulos, NÃO varre memória -> sem o hang do
    resolve<3). RVA + base = VA em runtime. Default = GameAssembly.dll."""
    nm = name or MODULE_NAME
    nm = nm.encode() if isinstance(nm, str) else nm
    k = _kernel32()
    for _ in range(4):   # SNAPMODULE às vezes pede retry (ERROR_BAD_LENGTH)
        snap = k.CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pid)
        if snap and snap != INVALID_HANDLE:
            try:
                me = MODULEENTRY32()
                me.dwSize = ctypes.sizeof(MODULEENTRY32)
                ok = k.Module32First(snap, ctypes.byref(me))
                while ok:
                    if me.szModule.lower() == nm.lower():
                        return me.modBaseAddr
                    ok = k.Module32Next(snap, ctypes.byref(me))
            finally:
                k.CloseHandle(snap)
            return None
        time.sleep(0.05)
    return None


# ============================ scanner: regiões + varredura =================== #
def regions(reader, protect_mask=READABLE):
    """[(base, size)] das regiões committed do processo. protect_mask filtra por proteção:
    READABLE (default, p/ resolver classes) ou WRITABLE (só heap gravável, p/ value-scan)."""
    res = []
    mbi = MBI()
    k = _kernel32()
    addr = 0
    MAX = 0x7FFFFFFFFFFF
    while addr < MAX:
        if not k.VirtualQueryEx(reader.handle, ctypes.c_void_p(addr),
                                ctypes.byref(mbi), ctypes.sizeof(mbi)):
            break
        size = mbi.RegionSize
        if mbi.State == MEM_COMMIT and (mbi.Protect & protect_mask) and not (mbi.Protect & PAGE_GUARD):
            res.append((mbi.BaseAddress or addr, size))
        if size == 0:
            break
        addr += size
    return res


def writable_regions(reader):
    """Só as regiões committed GRAVÁVEIS (heap gerenciado). Atalho de regions(WRITABLE)."""
    return regions(reader, WRITABLE)


def scan(reader, regs, needles, aligned=False):
    """Acha cada `needle` (bytes) nas regiões. Retorna {needle: [endereços]}.
    aligned=True só aceita endereços 8-alinhados (caça de ponteiros).

    CAÇA DE PONTEIROS (aligned + needles de 8 bytes) = SINGLE-SWEEP: desempacota os qwords
    8-alinhados de cada chunk UMA vez e cruza com um set dos valores procurados (em C, via
    set.intersection) — custo O(memória), INDEPENDENTE do nº de needles. Só os chunks que de
    fato contêm algum needle reconstroem a posição (find restrito aos presentes — barato mesmo
    com milhares de hits). O caminho antigo (find por needle, abaixo) é O(needles × memória):
    varria a memória inteira 1× POR needle — com 71 needles, eram 71 varreduras de 2,6 GB,
    o gargalo do cold scan (pass2 = 65% do tempo). base+off é 8-alinhado (regiões page-aligned,
    CHUNK múltiplo de 8) -> qword 8-alinhado nunca cruza borda de chunk, dispensa o OVER."""
    found = {n: [] for n in needles}
    if aligned and needles and all(len(n) == 8 for n in needles):
        val2needle = {struct.unpack("<Q", n)[0]: n for n in needles}
        wanted = set(val2needle)
        CHUNK = 16 * 1024 * 1024
        for base, size in regs:
            off = 0
            while off < size:
                n = min(CHUNK, size - off)
                n -= n % 8
                if n <= 0:
                    break
                data = reader.read(base + off, n)
                if data and len(data) >= 8:
                    m = len(data) // 8
                    present = wanted.intersection(struct.unpack("<%dQ" % m, data[:m * 8]))
                    for v in present:                 # só os needles realmente neste chunk
                        nd = val2needle[v]
                        start = 0
                        while True:
                            i = data.find(nd, start)
                            if i < 0:
                                break
                            if i % 8 == 0:            # posição 8-alinhada (base+off já é 8-alinhado)
                                found[nd].append(base + off + i)
                            start = i + 1
                off += CHUNK
        return found
    CHUNK = 32 * 1024 * 1024
    OVER = 256
    for base, size in regs:
        off = 0
        while off < size:
            data = reader.read(base + off, min(CHUNK + OVER, size - off))
            if data:
                for nd in needles:
                    start = 0
                    while True:
                        i = data.find(nd, start)
                        if i < 0:
                            break
                        a = base + off + i
                        if not aligned or a % 8 == 0:
                            found[nd].append(a)
                        start = i + 1
            off += CHUNK
    return found


def scan_i64_range(reader, regs, lo, hi, cap=20000):
    """Endereços 8-alinhados cujo int64 (little-endian) cai em [lo, hi]. Varre as regiões dadas
    desempacotando qwords (rápido em C via struct.unpack). Pra achar um VALOR (ex.: a célula do
    gold vivo, ~ o save) sem depender de nome de classe. `cap` limita o nº de hits."""
    hits = []
    CHUNK = 16 * 1024 * 1024
    for base, size in regs:
        off = 0
        while off < size:
            n = min(CHUNK, size - off)
            n -= n % 8
            if n <= 0:
                break
            data = reader.read(base + off, n)
            if data and len(data) >= 8:
                m = len(data) // 8
                for i, v in enumerate(struct.unpack("<%dQ" % m, data[:m * 8])):
                    if lo <= v <= hi:
                        hits.append(base + off + i * 8)
                        if len(hits) >= cap:
                            return hits
            off += CHUNK
    return hits


def in_region(regs, addr):
    return any(b <= addr < b + s for b, s in regs)


# ============================ Reader: leituras tipadas ======================= #
class Reader:
    def __init__(self, handle):
        self.handle = handle

    # ---- núcleo ---------------------------------------------------------- #
    def read(self, addr, size):
        """bytes lidos do processo, ou None. Defensivo (endereço pode liberar na luta)."""
        if not addr or size <= 0:
            return None
        buf = (ctypes.c_char * size)()
        n = ctypes.c_size_t(0)
        if not _kernel32().ReadProcessMemory(
                self.handle, ctypes.c_void_p(addr), buf, size, ctypes.byref(n)):
            return None
        return bytes(buf[:n.value])

    # ---- primitivos (mesmos formatos do monólito validado) --------------- #
    def rptr(self, a):
        b = self.read(a, 8)
        return struct.unpack("<Q", b)[0] if b and len(b) == 8 else None

    def ri32(self, a):
        b = self.read(a, 4)
        return struct.unpack("<i", b)[0] if b and len(b) == 4 else None

    def ru32(self, a):
        b = self.read(a, 4)
        return struct.unpack("<I", b)[0] if b and len(b) == 4 else None

    def ri64(self, a):
        b = self.read(a, 8)
        return struct.unpack("<q", b)[0] if b and len(b) == 8 else None

    def ru64(self, a):
        b = self.read(a, 8)
        return struct.unpack("<Q", b)[0] if b and len(b) == 8 else None

    def rf32(self, a):
        b = self.read(a, 4)
        return struct.unpack("<f", b)[0] if b and len(b) == 4 else None

    def read_cstr(self, a, maxlen=64):
        """C-string ascii (nome de classe Il2CppClass). '' se vazia, None se ilegível."""
        if not a:
            return None
        b = self.read(a, maxlen)
        if not b:
            return None
        nul = b.find(b"\x00")
        s = b[:nul] if nul >= 0 else b
        return s.decode("ascii", "replace") if s and all(32 <= c < 127 for c in s) else ("" if not s else None)

    def read_string(self, a):
        """System.String do IL2CPP (utf-16). '' se len 0, None se inválido."""
        if not a:
            return None
        ln = self.ri32(a + String.LENGTH)
        if ln is None or ln < 0 or ln > 4096:
            return None
        if ln == 0:
            return ""
        raw = self.read(a + String.CHARS, ln * 2)
        return raw.decode("utf-16-le", "replace") if raw else None

    # ---- leituras em lote (perf: 1 syscall em vez de N) ------------------ #
    def read_struct(self, addr, fmt):
        """Lê + desempacota vários campos contíguos numa só syscall. fmt = struct format."""
        size = struct.calcsize(fmt)
        b = self.read(addr, size)
        return struct.unpack(fmt, b) if b and len(b) == size else None

    def read_array_ptrs(self, arr, count):
        """Os `count` ponteiros do array (Il2CppArray.DATA) numa só leitura."""
        if not arr or count <= 0:
            return []
        b = self.read(arr + Array.DATA, count * 8)
        return list(struct.unpack(f"<{count}Q", b)) if b and len(b) == count * 8 else []

    # ---- containers IL2CPP ---------------------------------------------- #
    def list_ptrs(self, list_obj, cap=8000):
        """Ponteiros dos elementos de um List<T> de ref-types, em lote."""
        if not list_obj:
            return []
        size = self.ri32(list_obj + List.SIZE)
        items = self.rptr(list_obj + List.ITEMS)
        if not size or not items or size < 0 or size > cap:
            return []
        return [p for p in self.read_array_ptrs(items, size) if p]

    def list_iter(self, list_obj, cap=8000):
        yield from self.list_ptrs(list_obj, cap)

    def arr_u64(self, arr, cap=64):
        """ulong[] (ex.: equippedItemIds) em lote."""
        if not arr:
            return []
        ln = self.ri32(arr + Array.MAX_LENGTH)
        if ln is None or ln < 0 or ln > cap:
            return []
        b = self.read(arr + Array.DATA, ln * 8)
        return list(struct.unpack(f"<{ln}Q", b)) if b and len(b) == ln * 8 else []

    def arr_i32(self, arr, cap=64):
        """int[] (ex.: equippedSKillKey) em lote."""
        if not arr:
            return []
        ln = self.ri32(arr + Array.MAX_LENGTH)
        if ln is None or ln < 0 or ln > cap:
            return []
        b = self.read(arr + Array.DATA, ln * 4)
        return list(struct.unpack(f"<{ln}i", b)) if b and len(b) == ln * 4 else []

    def dict8b_items(self, dict_obj, cap=100000):
        """Pares (key:int32, value:int64) de um Dict<K,V8B> (Dict8B: stride 0x18,
        key@0x8, value@0x10), pulando tombstones (hash<0). Reusável — o GoldEarn usa
        DOIS desses: o Dict<EAggregateType,Dict> externo (value = ponteiro do interno)
        e o Dict<SubKey,long> interno. ⚠ NÃO serve pra DictFloat (stride 0x10 / val @0xC)."""
        if not dict_obj:
            return
        ent = self.rptr(dict_obj + Dict.ENTRIES)
        cnt = self.ri32(dict_obj + Dict.COUNT)
        if not ent or cnt is None or cnt < 0 or cnt > cap:
            return
        used = j = 0
        limit = cnt + 64
        while used < cnt and j < limit:
            e = ent + Dict.DATA + j * Dict8B.STRIDE
            j += 1
            h = self.ri32(e + Dict8B.HASH)
            if h is None:
                break
            if h < 0:
                continue
            used += 1
            yield self.ri32(e + Dict8B.KEY), self.ri64(e + Dict8B.VALUE)

    # ---- aliases de compatibilidade (API antiga do pacote) -------------- #
    pointer = rptr
    i32 = ri32
    i64 = ri64
    f32 = rf32
