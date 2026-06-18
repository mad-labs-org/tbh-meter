#!/usr/bin/env python3
"""validate_live.py — GATE de validação AO VIVO pós-update (READ-ONLY, zero-arg).

POR QUÊ: o diff estático (scripts/diff_offsets_vs_dump.py) só verifica classes NOMEADAS. As
OFUSCADAS — AggregateManager (gold), HeroRuntime (party + xp), StatsHolder — ele marca como
"não-verificáveis, valide ao vivo" e segue. Foi EXATAMENTE aí que DOIS bugs passaram para um
build no 1.00.11: o gold (idx_ut via value-scan que não convergia) e a party (cap do
pick_live_sm estourado por 1162 instâncias). Validar só o campo que se consertou (gold) deixou
a party passar batida. Este gate fecha o buraco: resolve pelo SEED embarcado (igual ao 1º launch
do RC/stable) e valida CADA métrica-chave AO VIVO, com PASS/FAIL e exit code. É o passo de
validação OBRIGATÓRIO da skill /meter-game-update — nenhum build sai sem PASS em tudo.

VALIDA (com o jogo ABERTO e EM COMBATE numa fase):
  [calib/seed]  o SEED embarcado cobre o fp do build vivo -> fast path, sem cold scan
  [gold]        AggregateManager resolve (idx do seed) + GoldEarn[SubKey1] vivo > 0
  [party-viva]  StageManager (pick_live_sm) resolve + 1..12 heróis DEPLOYADOS (não o roster do save)
  [hero-class]  cada herói deployado resolve uma EEquipClassType (classId) plausível pelo hero_cat
  [save-build]  pick_live_psd + read_gold>0 + read_heroes>=1 (o caminho SAVE que quebrou no 1.00.12)
  [build-record] read_build (o heroes[] que a run SOBE) >=1 herói E >=1 com items[] OU skills[]
                 (prova ATTRIBUTES/ITEMS/EQUIPPED_* — não só HEROES) + read_account_snapshot
                 (runes/inventory/stash) não-tudo-None (prova RUNES/INVENTORY/STASH/ITEMS)
  [xp-viva]     os heróis deployados têm nível/exp vivos plausíveis (HeroRuntime fakeValue)
  [dps]         MonsterSpawnManager + UnitHealthController: >=1 monstro vivo com hp_max>0
  [stats]       StatsHolder.FINAL_STATS (DictFloat): >=1 herói com um dict de ~64 stats vivos
  [stage]       o currentStageKey vivo resolve uma entrada do catálogo StageInfoData
  [run-cycle]   LogManager resolve + LOG_LIST estruturalmente legível (size>=0) — a boundary de run
  [catálogos]   stage_info (incl. ACTBOSS x-10) + item_cat + hero_cat não-vazios

USO (Windows, ADMIN, jogo aberto e EM COMBATE):  python reader\\scripts\\validate_live.py
Exit 0 = tudo PASS (pode shipar). Exit != 0 = alguma métrica FAIL (NÃO shipar). Tee em
validate_live_out.txt ao lado do arquivo. NÃO escreve no jogo nem no resolve_cache real.
"""
import os
import sys
import time

# bootstrap idêntico ao seed_calib_capture.py: acha reader/ da raiz do share ou de reader/scripts/.
_here = os.path.dirname(os.path.abspath(__file__))
_reader_root = next(
    (c for c in (os.path.join(_here, "reader"), _here, os.path.dirname(_here),
                 os.path.dirname(os.path.dirname(_here)))
     if os.path.isfile(os.path.join(c, "meter_windows.py"))),
    None,
)
if _reader_root is None:
    sys.exit("[x] meter_windows.py não encontrado. Rode da raiz do share tbh-meter-dev ou de reader/scripts/.")
sys.path.insert(0, _reader_root)

import meter_windows as mw                                       # noqa: E402
from shared.memory import Reader, find_pid, open_process         # noqa: E402
from il2cpp import typeinfo                                      # noqa: E402
from metrics import gold                                         # noqa: E402
from game import save, build, models                             # noqa: E402
from config.offsets import CommonSaveData, List, LogManager, EEquipClassType  # noqa: E402

# Faixa válida de classId = os membros REAIS de EEquipClassType (single-source: derivada do enum,
# não um literal). CLASS_TYPE é EEquipClassType, NUNCA EHeroType (órfão) — ver invariante obscured.
_CLASS_IDS = {int(c) for c in EEquipClassType}


def main():
    _f = open(os.path.join(_here, "validate_live_out.txt"), "w", encoding="utf-8")

    def log(s=""):
        print(s)
        _f.write(s + "\n")
        _f.flush()

    pid = find_pid()
    if not pid:
        log("[x] jogo não aberto. Abra o jogo, ENTRE NUMA FASE (combate) e rode de novo.")
        return 2
    handle = open_process(pid)
    if not handle:
        log("[x] OpenProcess falhou — abra o terminal como ADMINISTRADOR.")
        return 2
    reader = Reader(handle)
    gv = mw._detect_game_version(handle)
    ga_base0, _ = typeinfo.ga_module(pid)
    fp = typeinfo.build_fingerprint(reader, ga_base0, gv) if ga_base0 else None
    log(f"[ok] anexado (pid {pid}) | build {gv} | fp {fp}")
    if not fp:
        log("[x] não consegui ler o fingerprint do build — não dá pra validar.")
        return 2

    # Resolve pelo SEED embarcado: cache tmp vazio -> load_calib cai no seed -> fast path, exatamente
    # como o 1º launch do RC/stable. NÃO toca o resolve_cache real. Se o seed não cobrir o fp,
    # seed_calib=None (e o resolve cairia no cold scan) -> o check [calib/seed] FALHA, sinal de build ruim.
    tmp_cache = os.path.join(_here, ".validate_live_cache.tmp.json")
    try:
        os.remove(tmp_cache)
    except OSError:
        pass
    seed_calib = mw.load_calib(tmp_cache, fp)   # tmp vazio -> só acha se o SEED embarcado cobre o fp
    log("[..] resolvendo pelo seed (fast path, ~s)...")
    t0 = time.time()
    (sc, sf, msm, lm, csd_list, psd_list, stage_info, item_cat, hero_cat,
     sm_list, gold_klass, gb, die, res) = mw.resolve_all(reader, pid, fp, tmp_cache)
    try:
        os.remove(tmp_cache)
    except OSError:
        pass
    log(f"[ok] resolvido em {time.time() - t0:.0f}s\n")

    checks = []  # (nome, ok, detalhe)

    # [calib/seed] o seed cobre o fp -> fast path. None = o build sairia sem seed válido -> cold scan.
    checks.append(("calib/seed", seed_calib is not None,
                   (f"seed cobre fp (idx_ut={seed_calib['idx_ut']})" if seed_calib
                    else f"seed NÃO cobre fp {fp} → cairia no cold scan")))

    # [gold] gold_klass resolveu (via idx do seed) + GoldEarn[SubKey1] vivo > 0 (não 0, não lixo).
    glive = gold.combat_gold_live(reader, gold_klass) if gold_klass else None
    checks.append(("gold", bool(gold_klass) and glive is not None and glive > 0,
                   f"klass={hex(gold_klass) if gold_klass else None} live={glive}"))

    # [party-viva] StageManager resolve + 1..12 heróis DEPLOYADOS (a party REAL, não o roster do save).
    sm = save.pick_live_sm(reader, sm_list)
    party = build.read_live_party(reader, sm) if sm else {}
    checks.append(("party-viva", bool(sm) and 1 <= len(party) <= 12,
                   f"sm={'ok' if sm else 'NOT found'} deployados={len(party)} keys={sorted(party)}"))

    # [hero-class] cada herói deployado resolve uma EEquipClassType (HeroInfoData.CLASS_TYPE via hero_cat),
    # não EHeroType (órfão). Sem isto, CLASS_TYPE@0x48 podia deslizar e o diff estático nunca afere o VALOR
    # (matriz: HeroInfoData.CLASS_TYPE é S=✓/L=✗). classId tem que ser um membro REAL de EEquipClassType.
    cls_ids = [hero_cat.get(hk) for hk in party]
    cls_ok = bool(party) and all(c in _CLASS_IDS for c in cls_ids)
    checks.append(("hero-class", cls_ok,
                   (f"classIds={cls_ids}" if party else "sem party viva (em combate?)")))

    # [save-build] o BUILD da run (heroes/itens/runas) vem do SAVE (pick_live_psd + read_heroes),
    # NÃO da party viva acima. Foi AQUI que o 1.00.12 quebrou e shipou verde: o bucket-box deslocou
    # as listas do PlayerSaveData (+0x10) → read_gold=0 → pick_live_psd=None → read_heroes={} →
    # a run sai com heroes=[] → o app não sobe (eligible exige heroes>0) → sessão vazia. A
    # [party-viva] (caminho VIVO) passava e MASCARAVA isso. Este check exerce o caminho do SAVE.
    psd = save.pick_live_psd(reader, psd_list)
    save_gold = save.read_gold(reader, psd) if psd else 0
    save_heroes = save.read_heroes(reader, psd) if psd else {}
    checks.append(("save-build", bool(psd) and save_gold > 0 and len(save_heroes) >= 1,
                   f"psd={'ok' if psd else 'None'} saveGold={save_gold} saveHeroes={len(save_heroes)}"))

    # [build-record] o heroes[] que a run REALMENTE sobe não vem de read_heroes (acima, só sanidade do
    # roster) nem da party viva — vem de build.read_build, uma TERCEIRA leitura do save que re-deref
    # ATTRIBUTES/ITEMS/EQUIPPED_ITEMS/EQUIPPED_SKILLS p/ montar gear+skills+nível de cada herói. Um
    # shift em qualquer uma dessas listas deixa heroes.length>0 (upload PASSA) porém TODO herói sobe com
    # items[]/skills[] vazios — perda silenciosa de gear na frota, invisível a [save-build] e [party-viva].
    # Exige >=1 herói E >=1 com items[] OU skills[] não-vazio (prova que as listas além de HEROES resolvem).
    # E read_account_snapshot (runes/inventory/stash): se as TRÊS vierem None, o caminho do snapshot está
    # morto (RUNES/INVENTORY/STASH/ITEMS deslocados) — inventário/stash vazios silenciosos em toda run.
    build_recs = build.read_build(reader, psd, item_cat, hero_cat) if psd else []
    geared = sum(1 for h in build_recs if h.get("items") or h.get("skills"))
    snap = build.read_account_snapshot(reader, psd, item_cat) if psd else (None, None, None)
    snap_alive = any(x is not None for x in snap)
    checks.append(("build-record", len(build_recs) >= 1 and geared >= 1 and snap_alive,
                   f"heroes={len(build_recs)} comGearOuSkills={geared} "
                   f"snapshot(runes/inv/stash)={[None if x is None else len(x) for x in snap]}"))

    # [xp-viva] os heróis deployados têm nível/exp vivos plausíveis (HeroRuntime fakeValue; read_live_party gateia).
    xp_ok = bool(party) and all(0 < lvl <= 999 and exp >= 0 for lvl, exp in party.values())
    checks.append(("xp-viva", xp_ok,
                   (f"{len(party)} heróis c/ nível/exp válidos" if party else "sem party viva (em combate?)")))

    # [dps] MonsterSpawnManager + UnitHealthController: o DPS = Σ quedas de HP dos monstros. models.live_monsters
    # itera (unit, hp_atual, hp_max) lendo MONSTER_LIST/SUMMONED_LIST + Unit.HEALTH_CONTROLLER + HP@0x40/0x4C.
    # NUNCA exercido ao vivo antes (matriz: DPS é L=✗) → um shift de MONSTER_LIST/HP deixava dps=0 silencioso
    # na frota. Exige >=1 monstro vivo com hp_max>0 (prova a cadeia inteira: lista + HealthController + HP).
    mons = list(models.live_monsters(reader, msm)) if msm else []
    dps_ok = any(hp_max and hp_max > 0 for _u, _cur, hp_max in mons)
    checks.append(("dps", dps_ok,
                   f"msm={'ok' if msm else 'None'} monstros={len(mons)} comHpMax={sum(1 for _u, _c, m in mons if m and m > 0)}"))

    # [stats] StatsHolder.FINAL_STATS (Dict<StatType,float>, DictFloat 0x10/@0xC): os 64 stats FINAIS vivos por
    # herói. NUNCA validado ao vivo (matriz: FINAL_STATS é L=✗) → um StatsHolder/FINAL_STATS deslocado, ou a
    # geometria DictFloat confundida com Dict8B, dava stats vazios/lixo silenciosos. Exige >=1 herói com um dict
    # razoavelmente cheio (>=32 das 64 entries) — pega tanto o dict morto ([]) quanto a leitura truncada/desalinhada.
    stats_by_hero = build.read_live_stats_by_hero(reader, sm) if sm else {}
    stats_sizes = {hk: len(d) for hk, d in stats_by_hero.items()}
    stats_ok = any(n >= 32 for n in stats_sizes.values())
    checks.append(("stats", stats_ok, f"heróisComStats={len(stats_by_hero)} tamanhos={sorted(stats_sizes.values())}"))

    # [stage] o currentStageKey vivo resolve uma entrada do catálogo (modo derivável != '?').
    csd = save.pick_live_csd(reader, csd_list)
    skey = reader.ri32(csd + CommonSaveData.CURRENT_STAGE_KEY) if csd else None
    checks.append(("stage", bool(stage_info) and skey is not None and skey in stage_info,
                   f"curKey={skey} {'no catálogo' if skey in (stage_info or {}) else 'FORA do catálogo'}"))

    # [run-cycle] LogManager resolve + LOG_LIST estruturalmente legível. O fim de TODA run é detectado pelo
    # crescimento da LOG_LIST (LogManager.LOG_LIST@0x20, size@List.SIZE); um LogManager mal-resolvido ou um
    # LOG_LIST deslocado = a lista nunca cresce = NENHUMA run fecha (classe "runs não fecham", já causada uma
    # vez por size=0 de lixo sombreando o real). validate_live resolvia o lm mas nunca lia o LOG_LIST (matriz:
    # LogManager.LOG_LIST é L=✗). Espelha meter_windows: rptr(LOG_LIST) -> ri32(SIZE), exige size>=0 legível.
    ll = reader.rptr(lm + LogManager.LOG_LIST) if lm else None
    ll_size = reader.ri32(ll + List.SIZE) if ll else None
    checks.append(("run-cycle", bool(lm) and ll is not None and ll_size is not None and ll_size >= 0,
                   f"lm={'ok' if lm else 'None'} logList={'ok' if ll else 'None'} size={ll_size}"))

    # [catálogos] não-vazios, incl. ACTBOSS x-10 (mobs==0) — senão x-10 mostraria '?'.
    actboss = sum(1 for v in (stage_info or {}).values() if v[2] == 0)
    checks.append(("catálogos",
                   len(stage_info) > 0 and len(item_cat) > 0 and len(hero_cat) > 0 and actboss > 0,
                   f"stages={len(stage_info)} (ACTBOSS={actboss}) items={len(item_cat)} heroes={len(hero_cat)}"))

    log("===== VALIDAÇÃO AO VIVO (build {}) =====".format(gv))
    for name, ok, detail in checks:
        log(f"  [{'PASS' if ok else 'FAIL'}] {name:13s} — {detail}")
    all_pass = all(ok for _, ok, _ in checks)
    log("")
    if all_pass:
        log("[OK] ✅ TUDO PASS — o build resolve todas as métricas ao vivo pelo seed. Pode shipar.")
        return 0
    fails = [n for n, ok, _ in checks if not ok]
    log(f"[x] ❌ FAIL em: {', '.join(fails)} — NÃO shipe. Quase TODO check precisa do jogo EM COMBATE "
        f"numa fase com a party deployada (party/hero-class/build-record/xp/dps/stats/stage). Se rodou "
        f"fora de combate, entre numa fase e rode de novo; se persistir em combate, é regressão real.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
