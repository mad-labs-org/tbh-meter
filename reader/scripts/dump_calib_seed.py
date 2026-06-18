#!/usr/bin/env python3
"""dump_calib_seed.py — captura o SEED de calibração build-estável p/ embarcar no reader.

Estratégia seed-calib: o PRIMEIRO launch num build SHIPADO pula o scan de ~70s SE o reader já
vier com o `calib[fp]` daquele build. Este script extrai esse bloco do resolve_cache.json que o
reader APRENDEU (depois de 1 run em combate no build a ser shipado) e grava em
reader/config/calib_seed.json — pronto p/ commitar. É o passo de RELEASE (na máquina do
mantenedor), feito UMA vez por build do jogo.

NÃO toca a memória do jogo, NÃO calibra — só lê/filtra/grava JSON. Espelha o persist-gate do
save_calib (catálogos não-vazios) p/ NUNCA semear um calib degradado. Escrita atômica.

O seed é zero-regressão por construção: o fast path (_resolve_fast) revalida cada calib[fp] vivo
a cada launch e degrada pro scan em qualquer mismatch; um seed de outro build é só um MISS por fp.

USO:
    # extrai do cache padrão (~/tbh-meter/resolve_cache.json); se houver 1 fp, usa ele
    python scripts/dump_calib_seed.py
    # cache do RC, ou fp específico, ou saída custom:
    python scripts/dump_calib_seed.py --cache ~/tbh-meter-rc/resolve_cache.json --fp 1.00.09-0x6a203f51-0x62ea000
    # manter fps já no seed (multi-build) em vez de substituir:
    python scripts/dump_calib_seed.py --keep
"""
import argparse
import json
import os
import sys


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    reader_root = os.path.dirname(here)            # scripts/ -> reader/
    default_cache = os.path.join(os.path.expanduser("~"), "tbh-meter", "resolve_cache.json")
    default_out = os.path.join(reader_root, "config", "calib_seed.json")

    ap = argparse.ArgumentParser(
        description="captura calib[fp] do resolve_cache.json -> config/calib_seed.json (seed-calib)")
    ap.add_argument("--cache", default=default_cache,
                    help=f"resolve_cache.json de origem (default: {default_cache})")
    ap.add_argument("--fp", default=None,
                    help="fingerprint a extrair (default: o único do cache; erro se houver vários)")
    ap.add_argument("--out", default=default_out, help=f"arquivo de saída (default: {default_out})")
    ap.add_argument("--keep", action="store_true",
                    help="MERGE: mantém os fps já presentes no seed de saída (default: substitui)")
    args = ap.parse_args()

    try:
        doc = json.load(open(args.cache, encoding="utf-8"))
    except Exception as e:
        print(f"[x] não consegui ler o cache {args.cache}: {e}")
        return 1
    fmt = doc.get("fmt")
    calib = doc.get("calib") or {}
    if not calib:
        print(f"[x] cache sem bloco calib (fmt={fmt}). Rode o reader 1x EM COMBATE nesse build primeiro.")
        return 1

    fps = list(calib.keys())
    if args.fp:
        if args.fp not in calib:
            print(f"[x] fp {args.fp} não está no cache. disponíveis: {fps}")
            return 1
        chosen = [args.fp]
    elif len(fps) == 1:
        chosen = fps
    else:
        print(f"[x] o cache tem vários fps — escolha um com --fp. disponíveis: {fps}")
        return 1

    # persist-gate (espelha save_calib meter_windows.py): só semeia calib com catálogos não-vazios.
    for fp in chosen:
        e = calib[fp]
        if not (e.get("stage_info") and e.get("item_cat") and e.get("hero_cat")):
            print(f"[x] fp {fp}: catálogos vazios (scan rodou fora de stage?) — NÃO semeando degradado.")
            return 1

    out_calib = {}
    if args.keep and os.path.isfile(args.out):
        try:
            prev = json.load(open(args.out, encoding="utf-8"))
            if prev.get("fmt") == fmt:
                out_calib.update(prev.get("calib") or {})
        except Exception:
            pass
    for fp in chosen:
        out_calib[fp] = calib[fp]

    out_doc = {"fmt": fmt, "calib": out_calib}
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    tmp = args.out + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(out_doc, f, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, args.out)

    print(f"[ok] seed gravado: {args.out}")
    print(f"     fmt={fmt}  fps={list(out_calib.keys())}")
    for fp in chosen:
        e = calib[fp]
        print(f"     {fp}: anchor_rva={hex(e['anchor_rva'])} idx_ut={e['idx_ut']} "
              f"indices={len(e.get('indices', {}))} stages={len(e.get('stage_info', {}))} "
              f"items={len(e.get('item_cat', {}))} heroes={len(e.get('hero_cat', {}))}")
    print("     -> commite config/calib_seed.json e gere uma nova release.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
