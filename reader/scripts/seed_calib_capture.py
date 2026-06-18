#!/usr/bin/env python3
"""seed_calib_capture.py — ONE-SHOT, ZERO-ARG: varre o jogo VIVO e grava um calib_seed.json
FRESCO no CACHE_FMT ATUAL. Rode UMA vez no build que vai shipar, com o jogo ABERTO e EM COMBATE
(qualquer fase normal — você NÃO precisa de act-boss).

POR QUÊ: o fmt do seed é COPIADO do resolve_cache de onde ele foi extraído. Um seed extraído num
build ANTIGO do reader fica defasado-por-fmt depois de um bump de CACHE_FMT -> ignorado em runtime
(_read_calib rejeita fmt!=CACHE_FMT -> cai no scan frio mesmo assim) E reprova o --selftest do CI.
Este script captura a calib direto DESTE processo vivo, NO CACHE_FMT atual, então o seed nunca mais
fica atrás do build. Funde "rodar o reader 1x + scripts/dump_calib_seed.py" num único passo zero-arg.

ACT-BOSS (x-10): StageInfoData é o catálogo ESTÁTICO COMPLETO de fases (todos os atos/fases/
dificuldades), carregado independente do seu progresso. O fmt 9 parou de FILTRAR as linhas x-10
(ACTBOSS), então um scan em QUALQUER fase normal já as captura. Você NÃO precisa chegar/vencer um
boss. O script IMPRIME quantos ACTBOSS capturou pra você confirmar.

Reusa a resolução TESTADA do reader (_resolve_scan -> _calibrate -> save_calib); zero lógica de
RVA aqui. Escrita atômica; promove pro seed só depois de validar com os MESMOS checks do --selftest.
"""
import json
import os
import sys
import time

# --- bootstrap: poe o reader root no sys.path. Funciona da RAIZ do share tbh-meter-dev (que tem
# reader/ como subpasta), de dentro de reader/, ou de reader/scripts/ — acha quem tem meter_windows.py.
_here = os.path.dirname(os.path.abspath(__file__))
_reader_root = next(
    (c for c in (os.path.join(_here, "reader"), _here, os.path.dirname(_here),
                 os.path.dirname(os.path.dirname(_here)))
     if os.path.isfile(os.path.join(c, "meter_windows.py"))),
    None,
)
if _reader_root is None:
    sys.exit("[x] meter_windows.py não encontrado. Rode da raiz do share tbh-meter-dev (tem reader/) "
             "ou de dentro de reader/.")
sys.path.insert(0, _reader_root)

import meter_windows as mw                                   # noqa: E402
from shared.memory import Reader, find_pid, open_process     # noqa: E402
from il2cpp import typeinfo                                  # noqa: E402


def main():
    pid = find_pid()
    if not pid:
        print("[x] jogo não está aberto. Abra o jogo, ENTRE NUMA FASE (combate) e rode de novo.")
        return 1
    handle = open_process(pid)
    if not handle:
        print("[x] OpenProcess falhou — abra o terminal como ADMINISTRADOR e rode de novo.")
        return 1
    reader = Reader(handle)
    print(f"[ok] anexado (pid {pid}).")

    # Mesma sequência de fingerprint que o run(): versão instalada (handle) + ga_base do módulo.
    gv = mw._detect_game_version(handle)
    game_version = gv or mw.GAME_VERSION
    ga_base0, _ = typeinfo.ga_module(pid)
    fp = typeinfo.build_fingerprint(reader, ga_base0, gv) if ga_base0 else None
    if not fp:
        print("[x] não consegui ler GameAssembly.dll p/ o fingerprint do build — não dá pra semear.")
        return 1
    print(f"[ok] build {game_version} | fp {fp} | CACHE_FMT {mw.CACHE_FMT}")

    # FORÇA o slow path (scan completo) -> catálogos no fmt ATUAL, sem reusar calib/seed antigo.
    print("[..] scan COMPLETO (~1-3min) — forçado, pra capturar catálogos no fmt atual...")
    t0 = time.time()
    tup, classes = mw._resolve_scan(reader)
    (sc, sf, msm, lm, _csd, _psd, stage_info, item_cat, hero_cat,
     _sm, gold_klass, _gb, _die, _res) = tup
    print(f"[ok] scan em {time.time() - t0:.0f}s.")

    # GATE de resolução (espelha run()): managers/logs essenciais resolvidos.
    if not (msm and lm and sc and sf):
        print("[x] resolução incompleta (managers/logs ausentes). ENTRE NUMA FASE e rode de novo.")
        return 1
    # GATE de catálogos (espelha o persist-gate do save_calib): vazio = scan rodou fora de fase.
    if not (stage_info and item_cat and hero_cat):
        print(f"[x] catálogos vazios (stages={len(stage_info)} items={len(item_cat)} "
              f"heroes={len(hero_cat)}). ENTRE NUMA FASE (combate) — NÃO semeio degradado.")
        return 1

    actboss = sum(1 for v in stage_info.values() if v[2] == 0)   # mobs==0 <=> ACTBOSS (x-10)
    print(f"[ok] catálogos: stages={len(stage_info)} (ACTBOSS x-10={actboss}) "
          f"items={len(item_cat)} heroes={len(hero_cat)}")
    if actboss == 0:
        print("[!] AVISO: 0 fases ACTBOSS capturadas. O seed AINDA funciona (fmt atual -> pula o scan),"
              " mas x-10 mostraria '?' no fast path. Idealmente rode com uma fase de combate carregada.")

    # CALIBRA num TEMP (discover_anchor + idx_ut + escrita atômica via save_calib). Validar o TEMP —
    # e não o seed que já existe — evita falso-OK se a calibração falhar e o seed velho continuar lá.
    seed_path = mw._seed_path()
    tmp_cache = os.path.join(os.path.dirname(seed_path), ".calib_seed_capture.tmp.json")
    try:
        os.remove(tmp_cache)
    except OSError:
        pass
    mw._calibrate(reader, pid, fp, tmp_cache, classes, stage_info, item_cat, hero_cat, gold_klass)

    if not os.path.isfile(tmp_cache):
        print("[x] calibração não gravou nada — discover_anchor/idx_ut falhou (veja [calib] FAILED acima).")
        return 1
    try:
        doc = json.load(open(tmp_cache, encoding="utf-8"))
    finally:
        try:
            os.remove(tmp_cache)
        except OSError:
            pass
    # MESMOS checks do --selftest (meter_windows --selftest): fmt casa + bloco calib do fp não-vazio.
    if doc.get("fmt") != mw.CACHE_FMT or not (doc.get("calib") or {}).get(fp):
        print(f"[x] calib inválida (fmt={doc.get('fmt')}, fp presente="
              f"{bool((doc.get('calib') or {}).get(fp))}). Provável catálogo degradado — rode em combate.")
        return 1

    # PROMOVE pro seed real: 1 fp (o build atual), indent=2 igual ao arquivo commitado. Atômico.
    entry = doc["calib"][fp]
    seed_doc = {"fmt": mw.CACHE_FMT, "calib": {fp: entry}}
    os.makedirs(os.path.dirname(seed_path), exist_ok=True)
    tmp_out = seed_path + ".tmp"
    with open(tmp_out, "w", encoding="utf-8") as f:
        json.dump(seed_doc, f, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp_out, seed_path)

    print("")
    print(f"[OK] SEED gravado: {seed_path}")
    print(f"     fmt={seed_doc['fmt']}  fp={fp}")
    print(f"     anchor_rva={hex(entry['anchor_rva'])} idx_ut={entry['idx_ut']} "
          f"indices={len(entry['indices'])} stages={len(entry['stage_info'])} "
          f"(ACTBOSS={actboss}) items={len(entry['item_cat'])} heroes={len(entry['hero_cat'])}")
    print("")
    print("     -> copie p/ o repo em tbh-meter/reader/config/calib_seed.json, commite e rode a release.")
    print("     -> o --selftest do CI passa (fmt casa, calib não-vazio).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
