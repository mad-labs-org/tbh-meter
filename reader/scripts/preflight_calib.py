#!/usr/bin/env python3
"""preflight_calib.py — o GATE ESTÁTICO de UM COMANDO antes de re-seedar/shipar o reader.

POR QUÊ EXISTE: o reader já quebrou TRÊS vezes shipando um seed/calibração errado, sempre
SILENCIOSO (o reader lê lixo/vazio SEM erro), sempre porque a verificação foi PARCIAL:
  (1) gold (1.97T / 0): o singleton AggregateManager (idx_ut) resolveu por um value-scan que não
      convergia — só um run ao vivo pegaria;
  (2) party (+0xp, roster no lugar da party): o cap do pick_live_sm estourou a StageManager viva e
      caiu no roster do save — só um run ao vivo com a party deployada pegaria;
  (3) 1.00.12 (frota inteira parou de subir): o bucket-box inseriu campos no PlayerSaveData e
      deslocou TODAS as listas do save +0x10; o offsets.py apontava pro offset velho → read_gold/
      read_heroes liam a lista ERRADA → pick_live_psd None → run com heroes=[] → o app não subia
      (eligible exige heroes>0) → sessões vazias. Passou VERDE porque o tripwire estático só checava
      PRESENÇA de offset (outro campo caiu no offset velho) e o gate ao vivo só exercia o caminho
      LIVE (StageManager/AggregateManager), nunca o caminho do SAVE que o record de run usa.

A lição das três: NENHUM gate sozinho basta, e validar só o que você mexeu é o anti-padrão.
A imunidade é em CAMADAS (ver docs/process/live-validation-gate.md):
  1. ruff + pytest          — regressão de unidade (offsets pinados, lógica do tripwire, envelopes);
  2. diff_offsets_vs_dump   — tripwire código↔JOGO contra um dump.cs FRESCO (offsets de campo +
                              nomes + enums + TypeDefIndex/idx_ut do seed): pega INSERÇÃO/reorder;
  3. validate_live          — o gate AO VIVO (gold/party/xp/stage/dps/stats/save-build/build-record/
                              run-cycle/catálogos) que cobre as classes OFUSCADAS que o diff não vê.

Este script roda as CAMADAS 1 e 2 (tudo que dá pra rodar SEM o jogo) num único comando e, no fim,
IMPRIME o comando exato da camada 3 que o operador TEM que rodar ao vivo (este script NÃO consegue
rodar o jogo — precisa do Windows com o TBH aberto e EM COMBATE). Exit 0 = as camadas estáticas
PASSARAM; ainda FALTA a camada 3 (validate_live) antes de bumpar GAME_VERSION / shipar.

USO (da raiz do worktree, de reader/, ou de reader/scripts/):
    python3 scripts/preflight_calib.py --dump ~/tbh-dump/out/dump.cs --seed config/calib_seed.json
Sem --dump usa o caminho de saída padrão do Il2CppDumper da skill meter-game-update
(~/tbh-dump/out/dump.cs); se o dump não existir, FALHA com o comando de dump (nunca passa verde
sem ter diffado contra o build novo). --seed default = config/calib_seed.json (o seed commitado).
Pule a camada estática 1/2 só com --skip-ruff/--skip-pytest/--skip-diff (NÃO recomendado fora de
debug — some com a rede de segurança que cada break histórico provou ser necessária).

ESTE É UM GATE ESTÁTICO. Ele NUNCA pode declarar "pronto pra shipar" — só "as camadas estáticas
passaram". A camada ao vivo (validate_live.py) é obrigatória e roda na máquina do mantenedor.
"""
import argparse
import os
import shutil
import subprocess
import sys

# bootstrap idêntico aos outros scripts: acha o reader root (o que tem meter_windows.py) a partir
# da raiz do share tbh-meter-dev (tem reader/ como subpasta), de reader/, ou de reader/scripts/.
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

_DIFF = os.path.join(_here, "diff_offsets_vs_dump.py")
_VALIDATE = os.path.join(_here, "validate_live.py")
# Caminho de saída padrão do Il2CppDumper na skill meter-game-update (passo 2: `dotnet ... out`).
_DEFAULT_DUMP = os.path.expanduser("~/tbh-dump/out/dump.cs")
_DEFAULT_SEED = os.path.join(_reader_root, "config", "calib_seed.json")


def _hdr(title):
    print("\n" + "=" * 70)
    print(f"  {title}")
    print("=" * 70)


def _run(cmd, cwd):
    """Roda um subprocesso herdando stdout/stderr (o output da ferramenta aparece direto). Devolve
    o returncode, ou 127 se o executável não existe (FileNotFoundError)."""
    print(f"$ {' '.join(cmd)}  (cwd={cwd})")
    try:
        return subprocess.run(cmd, cwd=cwd).returncode
    except FileNotFoundError:
        return 127


def _ruff_cmd():
    """`ruff check .` se o ruff está no PATH; senão `uvx ruff check .` (o ruff.toml documenta o uvx
    como o jeito de rodar sem instalar — `uv` já está no ambiente do mantenedor). None se nem um nem
    outro existe (aí a camada não dá pra rodar — o operador instala o ruff)."""
    if shutil.which("ruff"):
        return ["ruff", "check", "."]
    if shutil.which("uvx"):
        return ["uvx", "ruff", "check", "."]
    return None


def main():
    ap = argparse.ArgumentParser(
        description="Gate ESTÁTICO de um comando antes de re-seedar/shipar o reader "
                    "(ruff + pytest + diff_offsets_vs_dump). Imprime o comando da camada AO VIVO no fim.")
    ap.add_argument("--dump", default=_DEFAULT_DUMP,
                    help=f"dump.cs FRESCO do Il2CppDumper do build novo (default: {_DEFAULT_DUMP})")
    ap.add_argument("--seed", default=_DEFAULT_SEED,
                    help="config/calib_seed.json a conferir (TypeDefIndex + idx_ut). Default: o commitado")
    ap.add_argument("--skip-ruff", action="store_true", help="pula o ruff (debug — não recomendado)")
    ap.add_argument("--skip-pytest", action="store_true", help="pula o pytest (debug — não recomendado)")
    ap.add_argument("--skip-diff", action="store_true",
                    help="pula o diff código↔dump (debug — só se você AINDA não tem o dump.cs)")
    args = ap.parse_args()

    results = []  # (nome_camada, ok, detalhe)

    # --- CAMADA 1a: ruff (lint — pega nome morto/indefinido que o refactor mais arrisca) ----------
    _hdr("CAMADA 1a — ruff check (lint estático)")
    if args.skip_ruff:
        print("[skip] --skip-ruff")
        results.append(("ruff", True, "PULADO (--skip-ruff)"))
    else:
        rc = _ruff_cmd()
        if rc is None:
            print("[x] ruff não encontrado no PATH e uvx indisponível. Instale: brew install ruff "
                  "(ou rode num ambiente com uv). Ver ruff.toml.")
            results.append(("ruff", False, "ruff/uvx ausente"))
        else:
            code = _run(rc, _reader_root)
            results.append(("ruff", code == 0, f"exit {code}"))

    # --- CAMADA 1b: pytest (regressão: offsets pinados, lógica do tripwire, envelopes, etc.) ------
    _hdr("CAMADA 1b — pytest (regressão de unidade, inclui o drift-test docs↔código)")
    if args.skip_pytest:
        print("[skip] --skip-pytest")
        results.append(("pytest", True, "PULADO (--skip-pytest)"))
    else:
        code = _run([sys.executable, "-m", "pytest", "-q"], _reader_root)
        results.append(("pytest", code == 0, f"exit {code}"))

    # --- CAMADA 2: diff código↔JOGO (o tripwire que deveria ter pego o 1.00.12 ANTES do ship) -----
    _hdr("CAMADA 2 — diff_offsets_vs_dump (tripwire código↔JOGO vs dump.cs fresco)")
    if args.skip_diff:
        print("[skip] --skip-diff (você AINDA não tem o dump.cs do build novo? gere-o — ver a skill)")
        results.append(("diff_offsets", True, "PULADO (--skip-diff)"))
    elif not os.path.isfile(args.dump):
        # Dump ausente NÃO pode passar verde — é exatamente o cenário 1.00.12 (não diffar = não saber).
        print(f"[x] dump.cs não encontrado em: {args.dump}")
        print("    Gere o dump do build NOVO (estático, não precisa do jogo rodando):")
        print("      cd ~/tbh-dump && cp /Volumes/TaskbarHero/GameAssembly.dll . && \\")
        print("        cp /Volumes/TaskbarHero/TaskBarHero_Data/il2cpp_data/Metadata/global-metadata.dat .")
        print("      DOTNET_ROLL_FORWARD=Major dotnet tool/Il2CppDumper.dll GameAssembly.dll "
              "global-metadata.dat out < /dev/null")
        print("    Depois rode de novo com --dump ~/tbh-dump/out/dump.cs (ou aponte --dump pro seu).")
        results.append(("diff_offsets", False, f"dump ausente: {args.dump}"))
    else:
        cmd = [sys.executable, _DIFF, "--dump", args.dump]
        if args.seed and os.path.isfile(args.seed):
            cmd += ["--seed", args.seed]
        else:
            print(f"[!] seed não encontrado em {args.seed} — diffando offsets/enums sem checar "
                  f"TypeDefIndex/idx_ut do seed (recomendado passar --seed config/calib_seed.json).")
        code = _run(cmd, _reader_root)
        # diff: exit 0 = sem drift; 1 = DRIFT (offsets.py/seed precisam atualizar); 2 = dump ilegível.
        results.append(("diff_offsets", code == 0,
                        "sem drift" if code == 0 else f"DRIFT/erro (exit {code})"))

    # --- RESUMO das camadas estáticas -------------------------------------------------------------
    _hdr("RESUMO — camadas ESTÁTICAS (1 + 2)")
    for name, ok, detail in results:
        print(f"  [{'PASS' if ok else 'FAIL'}] {name:14s} — {detail}")
    all_static_pass = all(ok for _, ok, _ in results)

    if not all_static_pass:
        fails = [n for n, ok, _ in results if not ok]
        print(f"\n[x] ❌ camada estática FALHOU em: {', '.join(fails)}.")
        print("    NÃO re-seede / NÃO bumpe GAME_VERSION / NÃO shipe. Conserte e rode de novo.")
        print("    (DRIFT no diff = atualize o símbolo em config/offsets.py a partir do dump — fonte")
        print("     única; ver docs/invariants/offsets-single-source.md e a skill meter-game-update.)")
        return 1

    # --- camada estática OK → IMPRIME o comando da camada AO VIVO (que este script NÃO roda) -------
    _hdr("✅ CAMADAS ESTÁTICAS PASSARAM — FALTA a camada AO VIVO (obrigatória)")
    print("As camadas 1+2 (ruff + pytest + diff código↔jogo) passaram: nada que o reader rastreia")
    print("deslocou de NOME/OFFSET/ENUM/índice neste dump. Mas as classes OFUSCADAS (gold via")
    print("AggregateManager, party+xp via HeroRuntime, StatsHolder) e os caminhos do SAVE/record que")
    print("a run SOBE (save-build/build-record/dps/stats/run-cycle) só se validam AO VIVO — é o ponto")
    print("cego onde os DOIS bugs do 1.00.11 e a parada de frota do 1.00.12 passaram batidos.")
    print("")
    print("ESTE GATE É ESTÁTICO E NÃO PODE RODAR O JOGO. Antes de bumpar GAME_VERSION / shipar, rode")
    print("a CAMADA 3 na máquina do mantenedor, com o TBH ABERTO e EM COMBATE numa fase:")
    print("")
    print("    # Windows, terminal como ADMINISTRADOR, party deployada numa fase:")
    print("    cd C:\\Users\\mario\\tbh-meter-dev")
    print("    python reader\\scripts\\validate_live.py")
    print("")
    print(f"  (código do gate ao vivo: {os.path.relpath(_VALIDATE, _reader_root)} — resolve pelo SEED")
    print("   embarcado, igual ao 1º launch do RC, e exige PASS em TODAS: calib/seed, gold,")
    print("   party-viva, hero-class, save-build, build-record, xp-viva, dps, stats, stage,")
    print("   run-cycle, catálogos. Exit != 0 = NÃO shipar. Lê de volta validate_live_out.txt.)")
    print("")
    print("⚠  NUNCA shipe só com este preflight verde. Validar parcialmente é EXATAMENTE como os três")
    print("   breaks passaram. Só DEPOIS de validate_live PASS em tudo: bumpe GAME_VERSION e shipe.")
    print("   Playbook completo: docs/guides/game-update.md + a skill meter-game-update.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
