"""agent_windows.py — AGENTE de inspecao de memoria (RODA NO WINDOWS, jogo aberto).
ZERO deps de runtime. SO LE memoria (ReadProcessMemory) — nada injetado.

Voce roda UMA vez e deixa aberto. Ele resolve as classes-chave 1x e fica escutando
output/agent_cmd.json. O Claude escreve comandos la; o agente executa e responde em
output/agent_resp.json. Assim o Claude itera (caca offset, decodifica XOR, acha a
carteira) SEM voce rodar mais nada.

ORQUESTRADOR: usa as MESMAS logicas isoladas do meter (shared.memory = Reader/scan/
processo; il2cpp = resolver/finder; config.offsets = offsets; game.save). O que e
EXCLUSIVO do agente — os comandos op_* (dump/obs/curve/goldsub…) e o loop de comando —
vive aqui e so aqui.

COMANDOS (campo "op"):
  info                                  -> status + contagens
  read   {addr,size}                    -> bytes em hex
  dump   {addr,size?}                   -> cada offset como i32/u32/f32/i64/ptr (inspector)
  obs    {addr,off,type:int|long|float} -> decodifica ObscuredX (read ATOMICO)
  obs_stable {addr,off,type,n?}         -> le N vezes e retorna a MODA (vence o racing do ACTk)
  scanptr{target}                       -> enderecos que APONTAM pra target (back-ref)
  resolve{name}                         -> instancias de uma classe (por nome, >=3 letras)
  heroes                                -> herois deployados (StageManager.HeroList) + cache(uf)
  gold                                  -> CurrencySaveData Key=100001 (saldos)
  psd                                   -> PlayerSaveData vivo (maior ouro) + herois
  curve                                 -> LevelInfoData -> curva de XP {nivel: ExpForLevelUp}
  goldlive                              -> GOLD VIVO cumulativo (GoldEarn) via singleton nn<ut>
  goldsub                               -> GoldEarn por SubKey (live+save) — quebra p/ oraculo per-run
addr/target aceitam int ou "0x...". Rodar: python agent_windows.py
"""

import json
import os
import struct
import time
import traceback
from collections import Counter

# Logicas isoladas (as MESMAS do meter). O exclusivo do agente (op_*) fica aqui embaixo.
from config.offsets import (Array, StageManager, Unit, HeroRuntime, HeroInfoData,
                            PlayerSaveData, CurrencySaveData, HeroSaveData,
                            AggregateManager, AggregateSaveData, EAggregateType, GOLD_KEY)
from shared.memory import (Reader, find_pid, open_process, close, regions, scan,
                           module_base, in_region)
from shared.utils import tee_stdio
from il2cpp.resolver import resolve
from il2cpp import finder
from game import save

CORE_TARGETS = ["StageManager", "PlayerSaveData", "CommonSaveData",
                "CurrencySaveData", "MonsterSpawnManager"]

# LevelInfoData NAO esta em config.offsets de proposito: so o op_curve (debug) le essa
# classe. Offset exclusivo do agente -> fica aqui (regra: o que so o agente usa, mora nele).
LID_LEVEL = 0x10            # LevelInfoData.Level
LID_EXP_FOR_LEVELUP = 0x14  # LevelInfoData.ExpForLevelUp

# Estado vivo (preenchido no main): Reader compartilhado + regioes + instancias resolvidas.
READER = None
REGIONS = []
INST = {}
CLASSES = {}
PID = None
GA_BASE = None   # base de GameAssembly.dll (p/ resolver RVA de TypeInfo/MethodInfo)


def as_addr(x):
    if isinstance(x, str):
        return int(x, 16) if x.lower().startswith("0x") else int(x)
    return int(x)


# ----------------------------- comandos (EXCLUSIVOS do agente) -----------------------------
def op_info(_):
    return {"pid": PID, "regions": len(REGIONS),
            "targets": {t: len(INST.get(t, [])) for t in CORE_TARGETS}}


def op_read(c):
    a = as_addr(c["addr"])
    b = READER.read(a, int(c.get("size", 64)))
    return {"addr": hex(a), "hex": (b.hex() if b else None)}


def op_dump(c):
    a = as_addr(c["addr"])
    size = int(c.get("size", 192))
    b = READER.read(a, size)
    if not b:
        return {"error": "read falhou"}
    rows = []
    for off in range(0, len(b) - 7, 8):
        q = struct.unpack_from("<Q", b, off)[0]
        i0, u0 = struct.unpack_from("<i", b, off)[0], struct.unpack_from("<I", b, off)[0]
        f0 = struct.unpack_from("<f", b, off)[0]
        i1 = struct.unpack_from("<i", b, off + 4)[0]
        f1 = struct.unpack_from("<f", b, off + 4)[0]
        rows.append({"off": hex(off), "i64": struct.unpack_from("<q", b, off)[0],
                     "ptr": (hex(q) if in_region(REGIONS, q) else None),
                     "i32": i0, "u32": u0, "f32": round(f0, 4),
                     "i32b": i1, "f32b": round(f1, 4)})
    return {"addr": hex(a), "rows": rows}


def op_obs(c):
    """Decodifica um ObscuredX (ACTk) com read ATOMICO: real = hidden ^ key."""
    a = as_addr(c["addr"]) + int(c.get("off", 0))
    typ = c.get("type", "int")
    if typ == "long":
        b = READER.read(a + 0x8, 16)
        if not b or len(b) != 16:
            return {"error": "read falhou"}
        h, k = struct.unpack("<QQ", b)
        v = h ^ k
        return {"type": "long", "value": v - (1 << 64) if v >= (1 << 63) else v}
    b = READER.read(a + 0x4, 8)   # hidden@+0x4, key@+0x8 (read ATOMICO)
    if not b or len(b) != 8:
        return {"error": "read falhou"}
    h, k = struct.unpack("<II", b)
    x = h ^ k
    if typ == "float":
        return {"type": "float", "value": struct.unpack("<f", struct.pack("<I", x))[0]}
    return {"type": "int", "value": x - (1 << 32) if x >= (1 << 31) else x}


def op_obs_stable(c):
    """Le um Obscured N vezes em loop apertado e retorna o valor MODA (mais comum) +
    distribuicao. Vence o racing do ACTk: leitura rasgada e esporadica (so durante a
    escrita do jogo); o valor REAL domina. type: int|long|float."""
    a = as_addr(c["addr"]) + int(c.get("off", 0))
    typ = c.get("type", "float")
    n = int(c.get("n", 120))
    vals = []
    for _ in range(n):
        if typ == "long":
            b = READER.read(a + 0x8, 16)
            if b and len(b) == 16:
                h, k = struct.unpack("<QQ", b)
                v = h ^ k
                vals.append(v - (1 << 64) if v >= (1 << 63) else v)
        else:
            b = READER.read(a + 0x4, 8)
            if b and len(b) == 8:
                h, k = struct.unpack("<II", b)
                x = h ^ k
                if typ == "float":
                    vals.append(round(struct.unpack("<f", struct.pack("<I", x))[0], 1))
                else:
                    vals.append(x - (1 << 32) if x >= (1 << 31) else x)
    top = Counter(vals).most_common(6)
    return {"n": len(vals), "type": typ, "mode": (top[0][0] if top else None),
            "mode_count": (top[0][1] if top else 0), "top": top}


def op_scanptr(c):
    target = as_addr(c["target"])
    needle = struct.pack("<Q", target)
    found = scan(READER, REGIONS, [needle], aligned=True)[needle]
    return {"target": hex(target), "count": len(found),
            "ptrs": [hex(a) for a in found[:200]]}


def op_resolve(c):
    name = c["name"]
    if len(name) < 3:
        # nome de 2 letras -> string-scan EXPLODE/trava. Use o finder (op_goldlive faz
        # isso pro `ut`: string isolada na regiao de nomes), offset-fixo, ou scanptr.
        return {"name": name, "error": "nome <3 letras nao resolve por string-scan "
                "(EXPLODE/trava). Use o finder (string isolada na regiao de nomes), "
                "offset-fixo a partir de classe legivel, ou scanptr."}
    cls, inst = resolve(READER, REGIONS, [name])
    CLASSES[name] = cls[name]
    INST[name] = inst[name]
    return {"name": name, "classes": [hex(k) for k in cls[name]],
            "instances": len(inst[name]), "sample": [hex(a) for a in inst[name][:300]]}


def op_curve(_):
    """Resolve LevelInfoData e monta a curva de XP {nivel: ExpForLevelUp} numa TACADA.
    Filtra falsos-positivos (klass != classe real) e valores insanos. 1 round-trip =
    robusto no canal SMB (em vez de 100+ reads avulsos que estressam o canal)."""
    cls, inst = resolve(READER, REGIONS, ["LevelInfoData"])
    K = next(iter(cls.get("LevelInfoData", set())), None)
    curve = {}
    for a in inst.get("LevelInfoData", []):
        if K is not None and READER.rptr(a) != K:
            continue
        lvl = READER.ri32(a + LID_LEVEL)
        exp = READER.ri32(a + LID_EXP_FOR_LEVELUP)
        if lvl is not None and exp is not None and 1 <= lvl <= 600 and exp > 0:
            curve[lvl] = exp
    return {"class": hex(K) if K else None,
            "n_inst": len(inst.get("LevelInfoData", [])),
            "n_curve": len(curve),
            "curve": {str(k): curve[k] for k in sorted(curve)}}


def op_heroes(_):
    sm = None
    heroes = []
    for a in INST.get("StageManager", []):
        hl = READER.rptr(a + StageManager.HERO_LIST)
        if hl:
            ln = READER.ri32(hl + Array.MAX_LENGTH)
            if ln and 0 < ln <= 12:
                hs = [READER.rptr(hl + Array.DATA + i * 8) for i in range(ln)]
                hs = [h for h in hs if h]
                if hs:
                    sm, heroes = a, hs
                    break
    out = []
    for h in heroes:
        cache = READER.rptr(h + Unit.CACHE)
        hid = READER.rptr(cache + HeroRuntime.INFO) if cache else None
        out.append({"hero": hex(h), "cache_uf": (hex(cache) if cache else None),
                    "heroKey": (READER.ri32(hid + HeroInfoData.HERO_KEY) if hid else None),
                    "classId": (READER.ri32(hid + HeroInfoData.CLASS_TYPE) if hid else None)})
    return {"stageManager": (hex(sm) if sm else None), "heroes": out}


def op_gold(_):
    res = []
    for a in INST.get("CurrencySaveData", []):
        if READER.ri32(a + CurrencySaveData.KEY) == GOLD_KEY:
            q = READER.ri64(a + CurrencySaveData.QUANTITY)
            if q is not None:
                res.append({"addr": hex(a), "qty": q})
    res.sort(key=lambda r: -r["qty"])
    return {"count": len(res), "items": res[:30]}


def op_psd(_):
    p = save.pick_live_psd(READER, INST.get("PlayerSaveData", []))
    if not p:
        return {"error": "PlayerSaveData vivo nao achado"}
    heroes = []
    for h in READER.list_iter(READER.rptr(p + PlayerSaveData.HEROES), cap=200):
        heroes.append({"key": READER.ri32(h + HeroSaveData.HERO_KEY),
                       "level": READER.ri32(h + HeroSaveData.LEVEL),
                       "exp": READER.rf32(h + HeroSaveData.EXP), "addr": hex(h)})
    return {"addr": hex(p), "gold": save.read_gold(READER, p), "heroes": heroes}


# ----------------------------- gold vivo (singleton nn<ut>) -----------------------------
# O CAMINHO (achar `ut` por nome curto sem hang -> singleton nn<T> -> beid[GoldEarn]) vive
# em il2cpp.finder + shared.Reader.dict8b_items. Aqui fica so a ORQUESTRACAO de debug:
# o self-test do finder e a quebra por-subkey (oraculo do per-run gold).
def _goldearn_inner(ut):
    """ut vivo -> beid -> Dict<SubKey,long> de GoldEarn (via Reader.dict8b_items). None se falhar."""
    if not ut:
        return None
    beid = READER.rptr(ut + AggregateManager.AGGREGATES)
    if not beid:
        return None
    for agg_type, inner in READER.dict8b_items(beid):
        if agg_type == EAggregateType.GoldEarn:
            return inner
    return None


def _ut_singleton(seed_class):
    """Classe `ut` (finder, sem hang) -> instancia viva nn<T>. (ut_class, ut) ou (None, None)."""
    ut_class = finder.find_class_by_name(READER, REGIONS, "ut", seed_class)
    if not ut_class:
        return None, None
    ut = finder.bbwf_from_klass(READER, ut_class)
    return (ut_class, ut) if ut and finder.klass_name(READER, ut) == "ut" else (ut_class, None)


def _save_goldearn_subkeys(psd):
    """[(subkey, value)] de GoldEarn no SAVE (PSD.aggregateSaveDatas, defasado). Read-only."""
    subs = []
    for e in READER.list_iter(READER.rptr(psd + PlayerSaveData.AGGREGATES), cap=5000):
        if READER.ri32(e + AggregateSaveData.TYPE) == EAggregateType.GoldEarn:
            v = READER.ri64(e + AggregateSaveData.VALUE)
            if v is not None:
                subs.append((READER.ri32(e + AggregateSaveData.SUB_KEY), v))
    return subs


def op_goldlive(_):
    """GOLD VIVO cumulativo (GoldEarn) read-only via singleton nn<ut>, 1 round-trip.
    Acha `ut` pelo finder (string isolada na regiao de nomes — sem hang), chega na
    instancia viva por nn<T>.static_fields.bbwf, le beid[GoldEarn=2] e soma os int64.
    Oraculos: finder self-test (acha StageManager e bate com o klass vivo), B (bbwf do
    StageManager == ele mesmo) e SAVE (aggregateSaveDatas Type==2, defasado)."""
    out = {}
    live_sm = save.pick_live_sm(READER, INST.get("StageManager", []))
    klass_sm = READER.rptr(live_sm + 0x0) if live_sm else None
    sm_found = finder.find_class_by_name(READER, REGIONS, "StageManager", klass_sm)
    out["finder_selftest"] = {"stagemanager_found": (hex(sm_found) if sm_found else None),
                              "klass_sm": (hex(klass_sm) if klass_sm else None),
                              "ok": (sm_found == klass_sm) if klass_sm else None}
    ut_class, ut = _ut_singleton(klass_sm)
    out["ut_class"] = hex(ut_class) if ut_class else None
    result = None
    inner = _goldearn_inner(ut)
    if inner is not None:
        subs = list(READER.dict8b_items(inner))
        result = {"ut_class": (hex(ut_class) if ut_class else None), "ut": hex(ut),
                  "subkeys": len(subs), "goldearn": sum(v for _, v in subs)}
    out["live"] = result
    # B oraculo: bbwf(klass_sm) deve voltar a propria instancia viva
    bbwf_sm = finder.bbwf_from_klass(READER, klass_sm) if klass_sm else None
    out["B_oracle_ok"] = (bbwf_sm == live_sm) if (live_sm and bbwf_sm) else None
    # SAVE oraculo (defasado)
    psd = save.pick_live_psd(READER, INST.get("PlayerSaveData", []))
    save_sum = None
    if psd:
        subs = _save_goldearn_subkeys(psd)
        save_sum = sum(v for _, v in subs) if subs else None
    out["save_goldearn"] = save_sum
    live = result["goldearn"] if result else None
    out["verdict"] = {"finder_selftest_ok": out["finder_selftest"]["ok"],
                      "live_goldearn": live, "save_goldearn": save_sum,
                      "live_geq_save": (live >= save_sum) if (live is not None and save_sum is not None) else None,
                      "lead": (live - save_sum) if (live is not None and save_sum is not None) else None}
    return out


def op_goldsub(_):
    """Quebra do GoldEarn por SubKey (read-only, 1 round-trip) — ORACULO do per-run gold.
    LIVE: ut.beid[GoldEarn=2] = Dict<SubKey,long> -> [(subkey,value)] + soma (cravado).
    SAVE: PSD.aggregateSaveDatas -> Type==GoldEarn(2) -> [(subkey,value)] + soma (defasado).
    Os dois devem casar (modulo defasagem do save). O delta por subkey entre dois snapshots
    (antes/depois de 1 run) revela qual subkey e combate vs ruido (idle/quest/venda)."""
    out = {}
    live_sm = save.pick_live_sm(READER, INST.get("StageManager", []))
    klass_sm = READER.rptr(live_sm + 0x0) if live_sm else None
    ut_class, ut = _ut_singleton(klass_sm)
    inner = _goldearn_inner(ut)
    if inner is not None:
        subs = list(READER.dict8b_items(inner))
        out["live"] = {"ut_class": (hex(ut_class) if ut_class else None), "inner": hex(inner),
                       "subkeys": [{"subkey": s, "value": v} for s, v in subs],
                       "n": len(subs), "sum": sum(v for _, v in subs)}
    else:
        out["live"] = None
    psd = save.pick_live_psd(READER, INST.get("PlayerSaveData", []))
    if psd:
        subs = _save_goldearn_subkeys(psd)
        out["save"] = {"psd": hex(psd),
                       "subkeys": [{"subkey": s, "value": v} for s, v in subs],
                       "n": len(subs), "sum": sum(v for _, v in subs)}
    else:
        out["save"] = None
    return out


OPS = {"info": op_info, "read": op_read, "dump": op_dump, "obs": op_obs,
       "obs_stable": op_obs_stable, "scanptr": op_scanptr, "resolve": op_resolve,
       "curve": op_curve, "heroes": op_heroes, "gold": op_gold, "psd": op_psd,
       "goldlive": op_goldlive, "goldsub": op_goldsub}


def main():
    global READER, REGIONS, INST, CLASSES, PID, GA_BASE
    # espelha stdout/stderr em output/agent.log (pro Claude monitorar de fora, ex.: o share)
    tee_stdio(os.path.join(os.path.dirname(os.path.abspath(__file__)), "output", "agent.log"))
    PID = find_pid()
    if not PID:
        print("[ERRO] jogo fechado.")
        return
    handle = open_process(PID)
    if not handle:
        print("[ERRO] OpenProcess falhou (rodar como admin?).")
        return
    READER = Reader(handle)
    GA_BASE = module_base(PID)
    print(f"[ok] anexado (pid {PID}). GameAssembly.dll base = "
          f"{hex(GA_BASE) if GA_BASE else 'NAO ACHADO'}. mapeando memoria...")
    REGIONS = regions(READER)
    print(f"[ok] {len(REGIONS)} regioes. resolvendo classes-chave (~1-2min)...")
    CLASSES, INST = resolve(READER, REGIONS, CORE_TARGETS)
    print("[ok] resolvido: " + ", ".join(f"{t}={len(INST.get(t, []))}" for t in CORE_TARGETS))

    outdir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "output")
    try:
        os.makedirs(outdir, exist_ok=True)
    except Exception:
        pass
    cmd_path = os.path.join(outdir, "agent_cmd.json")
    resp_path = os.path.join(outdir, "agent_resp.json")
    print(f"\n[PRONTO] escutando {cmd_path}\nDeixe esta janela aberta. Ctrl+C pra sair.\n")
    last_id = None
    try:
        while True:
            try:
                cmd = json.load(open(cmd_path, encoding="utf-8"))
            except Exception:
                cmd = None
            if cmd and cmd.get("id") != last_id:
                last_id = cmd.get("id")
                op = cmd.get("op")
                t0 = time.time()
                try:
                    result = OPS[op](cmd) if op in OPS else {"error": f"op desconhecido: {op}"}
                except Exception:
                    result = {"error": traceback.format_exc()}
                resp = {"id": last_id, "op": op, "ms": int((time.time() - t0) * 1000),
                        "result": result}
                try:
                    json.dump(resp, open(resp_path, "w", encoding="utf-8"), ensure_ascii=False)
                except Exception:
                    pass
                print(f"  > #{last_id} {op} ({resp['ms']}ms)")
            time.sleep(0.3)
    except KeyboardInterrupt:
        print("\n[fim] agente encerrado.")
    finally:
        close(handle)


if __name__ == "__main__":
    main()
