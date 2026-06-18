"""resolver.py — acha classes IL2CPP e suas instâncias por VARREDURA (sem calibração).

Método PROVADO (3 passadas), idêntico ao validado no monólito:
  1) varre a STRING do nome ("StageManager\\0") nas regiões;
  2) varre ponteiros 8-alinhados pra cada string -> K = ploc - Class.NAME; valida que
     K é uma Il2CppClass (name volta == nome E element_class/cast_class == K);
  3) varre ponteiros pra cada K -> instâncias (exclui self-refs [K, K+0x400)).
Re-resolver a cada launch (ASLR). NÃO serve p/ nomes < 3 letras (use finder.py).

resolve_via_rva() é o PRIMÁRIO no fast path (índice + bbwf, ~ms); resolve() (scan) é o
FALLBACK permanente. Qualquer sanity-fail no rva → None → o caller cai no scan."""

import struct
import time

from config.offsets import Class, List, LogManager, MonsterSpawnManager
from il2cpp import typeinfo
from il2cpp.finder import bbwf_from_klass
from shared.memory import scan

# Singletons resolvidos por bbwf no fast path. Gold (AggregateManager, nome ofuscado `uu`) é
# tratado em gold.py por ESTRUTURA (deliverable 04), NÃO aqui — §3 name-free.
SINGLETONS = {"MonsterSpawnManager", "LogManager", "StageManager"}


def _manager_inst_ok(reader, name, inst):
    """Valida a INSTÂNCIA singleton por SIZE da lista (espelha meter_windows.py:211-216 /
    _managers_ok). O round-trip de class_name valida a CLASSE; isto valida que a INSTÂNCIA é
    a viva e não lixo de menu (listas não alocadas → bbwf não-nulo, mas size absurdo).
      MonsterSpawnManager → MONSTER_LIST size em [0, 2000)
      LogManager          → LOG_LIST size em [0, 100000)   (LOG_LIST cresce a sessão inteira)
      StageManager        → bbwf aceito como está; a verificação party-bearing (live/combate)
                            é deferida pra deliverable 06 — NÃO falhar aqui por party ausente.
    Retorna True/False (False = sanity-fail → caller devolve None)."""
    if not inst:
        return False
    if name == "MonsterSpawnManager":
        s = reader.ri32((reader.rptr(inst + MonsterSpawnManager.MONSTER_LIST) or 0) + List.SIZE)
        return s is not None and 0 <= s < 2000
    if name == "LogManager":
        s = reader.ri32((reader.rptr(inst + LogManager.LOG_LIST) or 0) + List.SIZE)
        return s is not None and 0 <= s < 100000
    # StageManager (e qualquer outro singleton): aceita a instância bbwf não-nula.
    return True


def resolve_via_rva(reader, tbase, indices, targets, singletons=SINGLETONS):
    """Resolução por ÍNDICE (sem scan), no MESMO shape de resolve() — (classes, instances):
    classes = {nome: {K}}, instances = {nome: [endereços]}. Retorna None em QUALQUER
    sanity-fail (nome ou size de instância) → o caller cai no scan; NUNCA dados parciais.

      tbase     — base viva da TypeInfoTable (typeinfo.table_base).
      indices   — {nome: TypeDefIndex} aprendidos na calibração (deliverable 02).
      targets   — nomes de classe a resolver (>= 3 letras, estáveis; o gold ofuscado NÃO entra).
      singletons— nomes cuja instância vem por bbwf + validação de size.

    Gate anti-envenenamento (§6 fallback / cache-correctness):
      • CLASSE: class_by_index(idx[nome]) e exige class_name == nome (round-trip). Mismatch → None.
      • INSTÂNCIA singleton: bbwf_from_klass(K) + _manager_inst_ok. Falha → None.
    §10: K e inst null-guarded; bbwf pode devolver None."""
    classes = {}
    instances = {}
    for name in targets:
        idx = indices.get(name)
        if idx is None:
            return None
        K = typeinfo.class_by_index(reader, tbase, idx)
        if not K or typeinfo.class_name(reader, K) != name:   # SANITY FAIL → scan
            return None
        classes[name] = {K}
        if name in singletons:
            inst = bbwf_from_klass(reader, K)
            if not _manager_inst_ok(reader, name, inst):       # SANITY FAIL → scan
                return None
            instances[name] = [inst]
        else:
            # Só-classe (logs, CurrencySaveData, HeroSaveData) e PSD/CSD/catálogos: o caller
            # (deliverable 05) trata as instâncias desses separadamente.
            instances[name] = []
    return classes, instances


def instances_of(reader, regions, k_by_name, cap=4000):
    """Acha as INSTÂNCIAS de classes JÁ resolvidas (K conhecido) por UM scan direcionado de
    ponteiros 8-alinhados — a pass3 do resolve(), isolada. Usado pelo fast path (deliverable
    05/02) p/ resolver não-singletons (PlayerSaveData/CommonSaveData) e a LISTA do StageManager
    SEM o scan completo: o K já veio por índice, falta só achar quem aponta pra ele.

      k_by_name — {nome: K}  (K = endereço da Il2CppClass, já resolvido por índice).
      regions   — regiões READABLE (mesmas que o scan usa).
      cap       — teto de instâncias por classe (§10: evita iteração descontrolada).

    Retorna {nome: [endereços de instância]}, EXCLUINDO self-refs [K, K+0x400) — idêntico à
    pass3 (a própria Il2CppClass contém ponteiros pra si mesma). Custo INDEPENDENTE do nº de
    needles (single-sweep, #110): 3 K's ≈ 1 K. §10: K null-guardado; o scan é read-only."""
    targets = {name: K for name, K in (k_by_name or {}).items() if K}
    needles = {struct.pack("<Q", K): K for K in set(targets.values())}
    res = scan(reader, regions, list(needles.keys()), aligned=True) if needles else {}
    out = {name: [] for name in targets}
    for name, K in targets.items():
        for a in res.get(struct.pack("<Q", K), []):
            if not (K <= a < K + 0x400):              # exclui self-refs dentro da própria classe
                out[name].append(a)
                if len(out[name]) >= cap:
                    break
    return out


def resolve(reader, regions, targets):
    """targets = lista de nomes de classe (>= 3 letras). Retorna (classes, instances):
    classes = {nome: set(K)}, instances = {nome: [endereços de instância]}."""
    _t0 = time.time()
    _mb = sum(s for _, s in regions) / (1024 * 1024)
    print(f"[resolve] scanning {len(regions)} readable regions (~{_mb:.0f} MB) for {len(targets)} classes")
    str_needles = {t: (t.encode() + b"\x00") for t in targets}
    res1 = scan(reader, regions, list(str_needles.values()))
    name_addrs = {t: res1.get(str_needles[t], []) for t in targets}
    _t1 = time.time()
    print(f"[resolve] pass1 name-strings: {len(targets)} needles -> "
          f"{sum(len(v) for v in name_addrs.values())} hits in {_t1 - _t0:.1f}s")

    all_str = {a for addrs in name_addrs.values() for a in addrs}
    needles2 = {struct.pack("<Q", a): a for a in all_str}
    res2 = scan(reader, regions, list(needles2.keys()), aligned=True) if needles2 else {}
    classes = {t: set() for t in targets}
    for nd, sval in needles2.items():
        owner = next((t for t in targets if sval in name_addrs[t]), None)
        if not owner:
            continue
        for ploc in res2.get(nd, []):
            K = ploc - Class.NAME
            if reader.read_cstr(reader.rptr(K + Class.NAME)) == owner and (
                    reader.rptr(K + Class.ELEMENT_CLASS) == K or reader.rptr(K + Class.CAST_CLASS) == K):
                classes[owner].add(K)
    _t2 = time.time()
    print(f"[resolve] pass2 ptr->name: {len(needles2)} needles -> "
          f"{sum(len(res2.get(nd, [])) for nd in needles2)} ptr-hits, "
          f"{sum(len(v) for v in classes.values())} classes in {_t2 - _t1:.1f}s")

    all_K = {k for ks in classes.values() for k in ks}
    needles3 = {struct.pack("<Q", k): k for k in all_K}
    res3 = scan(reader, regions, list(needles3.keys()), aligned=True) if needles3 else {}
    instances = {t: [] for t in targets}
    for nd, kval in needles3.items():
        owner = next((t for t in targets if kval in classes[t]), None)
        if owner:
            for a in res3.get(nd, []):
                if not (kval <= a < kval + 0x400):   # exclui self-refs dentro da própria classe
                    instances[owner].append(a)
    _t3 = time.time()
    print(f"[resolve] pass3 ptr->class: {len(needles3)} needles -> "
          f"{sum(len(v) for v in instances.values())} instances in {_t3 - _t2:.1f}s "
          f"(total resolve {_t3 - _t0:.1f}s)")
    return classes, instances
