"""meter_windows.py — METER POR RUN (v4). RODA NO WINDOWS. ZERO deps. So LE memoria.

Cada RUN (uma tentativa de stage) registra:
  - status: SUCESSO (StageClearLog) ou FALHA (StageFailedLog)
  - Stage A-B + modo (Normal/Nightmare/Hell/Torment), tudo do StageInfoData[currentStageKey]
  - dano total (queda de HP) + DPS, mobs X/total (boss conta como +1, sem problema)
  - gold/xp GANHOS na run (delta do save; o save e snapshot -> so no fechamento)
  - FICHA dos herois no INICIO da run (classe, nivel, itens equipados c/ raridade e
    decorations/engravings/inscriptions) — congelada (ignora troca de equip no meio)
Se trocar de stage no meio sem clarear/falhar -> a run parcial e ABANDONADA e recomeca.

Saidas em --output (default ~/tbh-meter): raw/<ts_ms>.json (1 record CRU por run; id = horario de
FIM em ms, sem session/contador — Redesign 2; o conversor do app vira logs/<id>.json), live.json
(snapshot CRU da run atual, sobrescrito ~1x/s, o app cozinha o overlay), meter.log (log de evento,
com timestamp), resolve_cache.json. O reader é SENSOR BURRO: emite cru pros dois fluxos; o app
deriva dps/label/format e a SESSION (sem cozinhar aqui).
Rodar: python meter_windows.py [--output DIR] [--hz N] [--debug] (Ctrl+C sai).
"""

import argparse
import json
import os
import sys
import time
import traceback

# Orquestrador FINO: ZERO leitura de memória inline. Monta um shared.memory.Reader e delega
# tudo às lógicas isoladas — shared.memory (anexar/regiões/scan), il2cpp.resolver (acha as
# classes), game.* (domínio), metrics.* (métricas). Offsets vêm só de config.offsets.
from config.offsets import (List, Array, Class, MonsterSpawnManager, LogManager,
                            StageInfoData, StageClearLog, StageFailedLog, GetBoxLog,
                            HeroDieLog, ResurrectionLog, EMonsterLogType,
                            CommonSaveData, ItemInfoData, HeroInfoData, EStageDifficulty,
                            EStageType, name_map)
from shared.memory import Reader, regions, find_pid, open_process, close, process_image_path
from shared.utils import tee_stdio, resource_path, init_diag_log, diag
from shared.single_instance import acquire as acquire_single_instance
from shared.envelope import err, ok
from il2cpp.resolver import resolve, resolve_via_rva, instances_of, SINGLETONS
from il2cpp import typeinfo
from metrics.gold import (resolve_combat_gold_klass, combat_gold_klass_ok,
                          combat_gold_live, combat_gold_save, run_gain,
                          resolve_combat_gold_klass_by_index, gold_index_of_klass,
                          gold_index_by_structure)
from metrics import xp
from metrics.dps import DpsTracker
from game import build, save
from game.models import live_monsters as read_live_monsters, live_stage_key as read_live_stage_key

TARGETS = ["MonsterSpawnManager", "LogManager", "StageClearLog", "StageFailedLog",
           "GetBoxLog", "HeroDieLog", "ResurrectionLog",
           "CommonSaveData", "CurrencySaveData", "HeroSaveData", "StageInfoData",
           "PlayerSaveData", "ItemInfoData", "HeroInfoData", "StageManager"]


def _suffix_int(s):
    """'HeroName_601' -> 601, 'MonsterName_30102' -> 30102. None se não houver sufixo numérico.
    Os logs de morte/revive trazem name-keys nesse formato (cravado ao vivo)."""
    if not s:
        return None
    tail = s.rsplit("_", 1)[-1]
    return int(tail) if tail.isdigit() else None


# Sessão NÃO é mais do reader (Redesign 2): o APP deriva a session das runs (gap 6h + cortes "Nova
# sessão" app-side, em session-cuts.json). O reader é sensor puro — cada run tem id = seu próprio
# horário de fim (build_raw_record), então a identidade nunca depende de session/contador. Removidos
# daqui: load_session/save_session/session_for/resume_session/consume_session_reset, SESSION_GAP_SECONDS
# e o session.json/flag session_reset. `run_num` abaixo sobrou só como contador LOCAL do console/log
# (reinicia a cada launch, NÃO é id nem persiste).


# GetBoxLog @0x40 é o TIPO do baú como string ("TreasureChest_Monster|StageBoss|ActBoss"),
# NÃO uma item key (cravado ao vivo 2026-06-06: @0x40 = "TreasureChest_StageBoss" com
# monster_type=1). O tier autoritativo é monster_type @0x50 (EMonsterLogType 0/1/2). A
# variante exata da box não vem no evento, então mapeia o tier -> box item key canônica
# ("Box 1" de cada tier), que resolve a nome/sprite/loot e basta pro app escolher 1 dos 3 sprites.
BOX_KEY_BY_TIER = {0: 910011, 1: 920001, 2: 930101}  # Monster / Boss / ActBoss

# Baús de BOSS SEGUEM o clear: o jogo emite o GetBoxLog do baú de boss ~0.6s DEPOIS do
# StageClearLog, num crescimento SEPARADO da LOG_LIST (provado ao vivo, 1.00.11). Sem o
# pending-close abaixo, o close já tinha resetado R e o baú caía na run SEGUINTE — invisível
# grindando o mesmo stage, gritante quando a próxima é abandonada (blue chest numa run de 0s).
# mt=0 (mob) dropa DURANTE a stage → roteia pra run atual, como sempre.
TRAILING_BOX_TIERS = (EMonsterLogType.Boss, EMonsterLogType.ActBoss)
# Janela do pending-close: o record de um SUCCESS fica PENDENTE (em memória) por até este
# tanto de segundos pra absorver o(s) boss box(es) atrasado(s) antes do flush em disco.
# 3.0 = 5x o trail observado (~0.6s) e ≥2-3 snapshots do live.json (a contagem viva sobe a
# tempo do rising-edge do app, com o stage_key vivo ainda no stage clareado). O FECHAMENTO
# em si NÃO atrasa (leituras/métricas/ts_ms/new_run acontecem no close, como sempre — atrasar
# o close vazaria os primeiros segundos da run seguinte pro record no auto-replay, pior que o
# bug); só a ESCRITA do arquivo é adiada. Trade-off ACEITO: um kill duro (ex.: AV SIGKILL)
# dentro da janela perde esse record. Ver docs/invariants/run-lifecycle.
PENDING_CLOSE_GRACE = 3.0

GAME_VERSION = "1.00.14"   # FALLBACK: build do GameAssembly.dll contra a qual o reader foi feito; a versão INSTALADA vem do Version.txt do jogo (_detect_game_version)
# raw/<id>.json: formato VIVO que o reader emite (1 arquivo por run). Bumpa SÓ quando a FORMA da
# saída muda — NÃO por build do jogo (re-seed/endereço não conta). O conversor (app) faz dispatch
# por este valor. Espelha app/src/shared/raw-types.ts::RawRunV2. Ver [[invariants/schema-versioning]].
# v2 (Redesign 2): id = o HORÁRIO DE FIM da run em MILISSEGUNDOS (string), `ts` em ms, SEM session_id
# nem run — a identidade da run é o próprio instante, não um contador de sessão (mata a classe de bug
# do run_num-reset → id colidido → run sumida). Session é DERIVADA pelo app.
RAW_SCHEMA_VERSION = 2
# LEGADO (congelado): última versão do runs.jsonl append-only que o reader emitiu ANTES do raw/. O
# reader NÃO escreve mais runs.jsonl; o conversor usa este marco p/ ramificar a migração (≤11 = legado).
SCHEMA_VERSION = 11        # (6 = chaves/status EN; 7 = skills [{key, lv}]; 8 = + skillLevels; 9 = skills inclui PASSIVAS; 10 = drops[] de baú; 11 = mortes/revives/killed_by por herói + deaths/revives totais na run)
DIFF_NAMES = name_map(EStageDifficulty)   # {0: Normal, 1: Nightmare, 2: Hell, 3: Torment}

def _emit_status(state):
    """Marcador de ciclo de vida (machine-readable) p/ o splash do app Electron — lido
    em reader-process.ts (statusFromLine). flush=True garante que chega no pipe de stdout
    NA HORA (senão fica preso no buffer de bloco e o splash atrasa). Os logs humanos
    abaixo continuam iguais. Fases: searching -> resolving -> ready."""
    print(f"[[STATUS]] {state}", flush=True)


def _detect_game_version(handle):
    """Versão INSTALADA do jogo, lida do Version.txt ao lado do exe (caminho via o handle
    read-only já aberto). None se não der pra ler -> caller usa o fallback GAME_VERSION."""
    try:
        exe = process_image_path(handle)
        if not exe:
            return None
        with open(os.path.join(os.path.dirname(exe), "Version.txt"), encoding="utf-8-sig") as f:
            return f.read().strip()[:40] or None
    except Exception:
        return None


CACHE_FMT = 9   # bump qdo muda o shape do cache. 9 = stage_info inclui stages ACTBOSS (x-10) — calibs antigos não têm essas keys e o fast path os reusa pra sempre, então força UM re-scan. 8 = CALIB-ONLY: bloco calib{fp:...} keyed por fingerprint de build — anchor_rva relativo (ASLR-stable) + índices{nome:idx} + idx_ut + catálogos build-estáveis. O cache LEGADO de endereços absolutos (sc_class/msm/lm/... + load_cache/save_cache/_managers_ok) FOI REMOVIDO: calib é build-keyed e o fast path revalida por round-trip + size de instância a cada launch (não guarda endereço absoluto, então não há o que revalidar por endereço). Histórico: 7 = +die_class/res_class; 6 = +gb_class; 5 = +gold_klass; 4 = +sm_list p/ party viva.


def _seed_path():
    """Caminho do SEED de calibração EMBARCADO (read-only no bundle), via resource_path — casa
    com `--add-data "config/calib_seed.json;config"` no frozen, resolve em reader/config/ no
    source. O seed é OPCIONAL: ausente → resource_path aponta p/ um arquivo inexistente, e
    _read_calib devolve None de boa (caller cai no scan)."""
    return resource_path("config/calib_seed.json")


def _stage_info_ok(stage_info):
    """Sanidade do catálogo stage_info: não-vazio e TODA row no shape (act, stage_no, horda,
    diff) — 4 ints, com act/stage_no plausíveis (1..200, espelha o gate de linha do
    _read_catalogs; horda NÃO tem range-check — boss x-10 legitimamente tem horda=0) e diff
    dentro do EStageDifficulty (as keys de DIFF_NAMES, exatamente o que close_run/overlay
    resolvem via DIFF_NAMES.get). Row fora disso = catálogo suspeito (misread no scan ou
    cache envenenado): servir/persistir viraria modo "?" PERMANENTE.
    É o gate dos DOIS lados: no LOAD (_read_calib rejeita → load_calib cai pro seed → scan,
    auto-curando um resolve_cache.json envenenado sem o usuário deletar nada) e no PERSIST
    (save_calib não grava catálogo ruim). Diferente do anchor/índices, os catálogos NÃO têm
    revalidação viva por round-trip no fast path — a defesa deles é este gate de VALOR + o
    gate de COMPLETUDE-vs-seed (_covers_seed_keys)."""
    if not stage_info:
        return False
    # bool é subclasse de int em Python: um `true` num cache editado à mão passaria como
    # diff=1 — exclui explicitamente (JSON real do save_calib só produz ints).
    return all(isinstance(row, tuple) and len(row) == 4
               and all(isinstance(x, int) and not isinstance(x, bool) for x in row)
               and 1 <= row[0] <= 200 and 1 <= row[1] <= 200
               and row[3] in DIFF_NAMES
               for row in stage_info.values())


def _covers_seed_keys(seed_entry, stage_info, item_cat, hero_cat):
    """Gate de COMPLETUDE-vs-seed: os catálogos candidatos cobrem TODA key que o seed
    embarcado tem pro MESMO fp? Catálogos são CONSTANTES do build — pro mesmo fingerprint,
    o seed shipado (validado ao vivo na captura) é ground truth de QUAIS keys existem; um
    catálogo local sem alguma key do seed tem BURACO (linha dropada por misread no gate de
    linha do _read_catalogs) e é provadamente pior. Sem seed pro fp (None) não há
    referência → sem restrição (True). SÓ PRESENÇA de key, NUNCA comparação de valor: key
    extra local sempre passa, e o valor local vence quando presente (protege contra um
    seed hipoteticamente stale sob o mesmo fp)."""
    if seed_entry is None:
        return True
    return (set(seed_entry["stage_info"]) <= set(stage_info)
            and set(seed_entry["item_cat"]) <= set(item_cat)
            and set(seed_entry["hero_cat"]) <= set(hero_cat))


def load_calib(path, fp):
    """Lê o bloco de calibração BUILD-ESTÁVEL `calib[fp]`. Tenta o cache do USUÁRIO (`path`,
    ~/tbh-meter/resolve_cache.json) PRIMEIRO; se não cobrir `fp`, cai no SEED embarcado
    (config/calib_seed.json). Retorna {anchor_rva, indices{nome:idx}, idx_ut, stage_info,
    item_cat, hero_cat} ou None (fmt antigo / fp ausente nos dois / JSON corrompido → scan).

    SEED FALLBACK (estratégia seed-calib): faz o PRIMEIRO launch num build SHIPADO pular o scan
    de ~70s (vira ~ms de load). O seed é só MAIS UMA hipótese calib[fp] — ZERO confiança nova: o
    fast path (_resolve_fast) revalida vivo a cada launch (round-trip de nome + size de instância
    + round-trip do gold) e degrada pro scan garantido em QUALQUER mismatch; um seed velho/de
    outro build é simplesmente um MISS por fp (cai no scan), nunca envenena. O cache do usuário
    tem prioridade — um calib APRENDIDO localmente (save_calib) sobrepõe o seed no próximo launch.
    Provado em tbh-meter-dev/seed_calib_probe.py (20/20, seed-path 7.8s vs scan 73s, ~9x; negativos
    anchor/idx corrompidos → _resolve_fast None).

    Amendment R3 (completude-vs-seed): a prioridade do cache do usuário é CONDICIONADA à
    cobertura de keys do seed do MESMO fp (_covers_seed_keys). Um cache cujos catálogos
    perderam keys que o seed tem é um catálogo com BURACO (linhas dropadas por misread no
    gate de linha do _read_catalogs): passa nos gates de valor, mas servido sombrearia o
    seed bom PRA SEMPRE (nada re-dispara scan) → mesmo sintoma do cache envenenado (modo
    "?" no stage do buraco), de novo só curável deletando cache na mão. Nesse caso serve o
    SEED (com log de observabilidade). Custo: o seed é parseado UMA vez por load, mesmo em
    cache-hit (~ms, aceitável). Semântica preservada no resto: cache bom → cache; cache
    None → seed; ambos None → None."""
    seed = _read_calib(_seed_path(), fp)
    entry = _read_calib(path, fp)
    if entry is not None:
        if _covers_seed_keys(seed, entry["stage_info"], entry["item_cat"], entry["hero_cat"]):
            return entry
        # Nomeia CADA catálogo com buraco (não só o total): a triagem é remota, via
        # meter.log — "stage_info=2" vs "item_cat=40" apontam pra misreads bem diferentes.
        holes = {c: len(set(seed[c]) - set(entry[c]))
                 for c in ("stage_info", "item_cat", "hero_cat")}
        detail = " ".join(f"{c}={n}" for c, n in holes.items() if n)
        print(f"[calib] user cache for fp {fp} missing seed keys: {detail} — serving seed")
        return seed
    return seed


def _read_calib(path, fp):
    """Lê o bloco `calib[fp]` de UM arquivo (fmt==CACHE_FMT). None se fmt antigo / fp ausente /
    JSON corrompido ou de shape inesperado (ex.: top-level não-dict) / arquivo inexistente.
    TOTAL por construção — NUNCA levanta: todo acesso ao shape mora dentro de try. Importa
    porque o gate de completude-vs-seed do save_calib chama isto FORA do try do save_calib,
    e _calibrate promete "NUNCA quebra o fluxo" (um arquivo malformado não pode crashar o
    pós-scan).

    NÃO valida endereços absolutos: o bloco calib NÃO tem nenhum — `anchor_rva` é RELATIVO ao
    ga_base (relido vivo a cada launch) e os índices são CONSTANTES do build. Anchor/índices
    são "dado bruto, VALIDADO PELO CALLER": o resolver revalida 1 nome via round-trip + size de
    instância a cada start; um anchor/índice ruim degrada pro scan, NUNCA envenena. Catálogos
    reconstruídos com int(k)/tuple(v) como no load_cache legado.

    EXCEÇÃO — stage_info é validado AQUI (_stage_info_ok): catálogo não tem round-trip vivo no
    fast path, então um cache envenenado (ex.: rows com diff -1 gravadas antes do gate de diff
    no _read_catalogs) seria servido pra sempre → modo "?" em toda run. Rejeitar o bloco aqui
    faz o load_calib cair pro seed embarcado (e este, se também falhar/missar, pro scan, que
    re-calibra e SOBRESCREVE o calib[fp] envenenado) — auto-cura, sem deletar cache na mão."""
    try:
        c = json.load(open(path, encoding="utf-8"))
        if c.get("fmt") != CACHE_FMT:
            return None
        entry = c.get("calib", {}).get(fp)
    except Exception:
        return None
    if not entry:
        return None
    try:
        indices = {k: int(v) for k, v in entry.get("indices", {}).items()}
        si = {int(k): tuple(v) for k, v in entry.get("stage_info", {}).items()}
        if not _stage_info_ok(si):
            return None
        item_cat = {int(k): tuple(v) for k, v in entry.get("item_cat", {}).items()}
        hero_cat = {int(k): (v if v is not None else None)
                    for k, v in entry.get("hero_cat", {}).items()}
        return {"anchor_rva": entry.get("anchor_rva"), "indices": indices,
                "idx_ut": entry.get("idx_ut"), "stage_info": si,
                "item_cat": item_cat, "hero_cat": hero_cat}
    except Exception:
        return None


def save_calib(path, fp, anchor_rva, indices, idx_ut, stage_info, item_cat, hero_cat):
    """Persiste a calibração de UM build (`fp`) no bloco calib do cache. MERGE: relê o JSON
    existente, seta calib[fp]={...}, preserva os demais fps e o bloco legado de endereços.

    PERSIST-GATE de COMPLETUDE (amendment R1): só persiste se os catálogos estão SÃOS
    (len>0 nos três), espelhando o guard `if msm and lm and sc_class and sf_class:` do run().
    Senão um scan rodado FORA de stage gravaria catálogo vazio → o fast-path serviria catálogo
    degradado pra SEMPRE nesse fp, sem trigger de re-resolve. NÃO persistir calib incompleto.
    Amendment R2: stage_info passa por _stage_info_ok (toda row com diff EStageDifficulty
    válido) — espelha o load-gate do _read_calib; um misread nunca vira calibração persistida.
    Amendment R3: completude-vs-seed (_covers_seed_keys) — quando o seed embarcado cobre o fp,
    um scan cujos catálogos NÃO têm toda key do seed (linhas dropadas por misread no gate de
    linha do _read_catalogs) NÃO persiste: o catálogo com buraco sombrearia o seed bom pra
    sempre nesse fp (espelha o load-gate do load_calib; o seed segue servindo nos próximos
    launches). Sem seed cobrindo o fp, persiste exatamente como antes.

    ESCRITA ATÔMICA: json.dump em path+".tmp", flush()+os.fsync(), os.replace(tmp, path). Mesmo
    volume (`~/tbh-meter` local) → os.replace é atômico no SO → um kill no meio NUNCA deixa o
    cache truncado/poison. (Corrige a hygiene de escrita não-atômica do save_cache legado.)"""
    if not (_stage_info_ok(stage_info) and len(item_cat) > 0 and len(hero_cat) > 0):
        return
    if not _covers_seed_keys(_read_calib(_seed_path(), fp), stage_info, item_cat, hero_cat):
        return
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        try:
            doc = json.load(open(path, encoding="utf-8"))
            if not isinstance(doc, dict) or doc.get("fmt") != CACHE_FMT:
                doc = {"fmt": CACHE_FMT}
        except Exception:
            doc = {"fmt": CACHE_FMT}
        calib = doc.get("calib")
        if not isinstance(calib, dict):
            calib = {}
        calib[fp] = {
            "anchor_rva": anchor_rva,
            "indices": {k: int(v) for k, v in indices.items()},
            "idx_ut": idx_ut,
            "stage_info": {str(k): list(v) for k, v in stage_info.items()},
            "item_cat": {str(k): list(v) for k, v in item_cat.items()},
            "hero_cat": {str(k): v for k, v in hero_cat.items()},
        }
        doc["calib"] = calib
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(doc, f)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except Exception:
        pass


def fmt(n):
    n = float(n or 0)
    for u in ("", "K", "M", "B", "T"):
        if abs(n) < 1000:
            return (f"{n:.0f}{u}" if u == "" else f"{n:.2f}{u}")
        n /= 1000.0
    return f"{n:.2f}P"


def _append(path, line):
    try:
        with open(path, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


def _write_atomic(path, text):
    """Grava `text` em `path` ATOMICAMENTE: escreve num `.tmp` e renomeia (os.replace é atômico no
    mesmo filesystem). O app pode estar lendo a pasta raw/ a qualquer momento -> nunca pode ver um
    arquivo meio-escrito. Best-effort: em falha, limpa o .tmp e não deixa lixo."""
    tmp = path + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp, path)
    except Exception:
        try:
            os.remove(tmp)
        except OSError:
            pass


def build_raw_record(*, ts_ms, run_outcome, game_version, duration,
                     stage_key, act, stage_no, difficulty, total_mobs,
                     mobs, total_damage, clear_time,
                     gold, gold_ok, gold_source, xp_gained, xp_ok, xp_source,
                     drops, heroes, heroes_ok, runes, inventory, stash):
    """Monta o record RAW v2 (raw/<id>.json) a partir dos valores JÁ lidos — observação CRUA, SEM
    derivar (dps/taxas/labels/partial/skip/status ficam pro CONVERSOR, app). Cada campo de DADO vai
    num envelope ok/err (shared.envelope) pro conversor distinguir "não-li" de "li zero" (o bug do
    gold:0). A meta estrutural (id/ts/...) vai CRUA. PURA e testável: não toca memória nem relógio
    (`ts_ms` entra por parâmetro). Espelha app/src/shared/raw-types.ts::RawRunV2 (chaves 1:1).

    - `id` = o HORÁRIO DE FIM em MILISSEGUNDOS como string (= `str(ts_ms)`). É a IDENTIDADE da run —
      SEM session, SEM contador: dois plays numa máquina são sequenciais, nunca dividem um ms. O
      external_id de upload é `device:id` (colado app-side). O ARQUIVO é raw/<id>.json. (v1 usava
      `session_id:run`, que reciclava no restart do reader → id colidido → run nova sumida.)
    - `*_ok=False` -> o campo vira err (não 0/None): foi o que consertou o gold:0 (não-li != zero).
    - campos do stage (stageKey/act/stageNo/difficulty/total_mobs) = err quando não resolveram.
      stageKey=None é LEITURA FALHA (a chave de ranking), não "sem stage" — vira err pra o conversor
      degradar a run (o caminho abandoned só fecha com stage_key não-None, ver close_run)."""
    def _stage(v):
        return ok(v) if v is not None else err("stage unresolved")
    return {
        "raw_schema_version": RAW_SCHEMA_VERSION,
        "id": str(int(ts_ms)),
        "ts": int(ts_ms),
        "run_outcome": run_outcome,
        "game_version": game_version,
        "duration": int(duration),
        "stageKey": ok(stage_key) if stage_key is not None else err("stageKey unread"),
        "act": _stage(act),
        "stageNo": _stage(stage_no),
        "difficulty": _stage(difficulty),
        "total_mobs": _stage(total_mobs),
        "mobs": ok(mobs),
        "total_damage": ok(round(total_damage, 2)),
        "clear_time": ok(clear_time),
        "gold_gained": ok(int(gold)) if gold_ok else err("gold unread (live+save failed)"),
        "gold_source": gold_source,
        "xp_gained": ok(round(xp_gained, 2)) if xp_ok else err("xp unread (live+save failed)"),
        "xp_source": xp_source,
        "drops": ok(drops),
        "heroes": ok(heroes) if heroes_ok else err("party live off (StageManager unresolved)"),
        # Snapshot da conta no fechamento (fonte SAVE): runas + inventário + stash, CRUS, gravado em
        # TODA run. Em ENVELOPE ok/err como os demais data fields: None (NÃO-LI) -> err, lista -> ok
        # (incl. [] = vazio GENUÍNO). Jamais ok([]) numa falha de leitura — seria o bug do gold:0 de
        # volta. Aditivo SEM bump de RAW_SCHEMA_VERSION: o conversor lê por nome e ignora chave
        # desconhecida (convert.ts), app intacto; o wiki deriva depois (drop-rate real / correção de wave).
        "runes": ok(runes) if runes is not None else err("runes unread (save/list unreadable)"),
        "inventory": ok(inventory) if inventory is not None else err("inventory unread (save/list unreadable)"),
        "stash": ok(stash) if stash is not None else err("stash unread (save/list unreadable)"),
    }


def build_live_record(*, run, stage_key, act, stage_no, difficulty,
                       mobs, total_mobs, damage_now, elapsed, gold_now, xp_now, party, drops,
                       party_stats=None):
    """Monta o snapshot LIVE CRU (live.json, sobrescrito ~1x/s) a partir dos valores JÁ lidos —
    observação CRUA, SEM cozinhar. O reader DEIXOU de derivar dps/label/format aqui: ele emite só os
    números/ids vivos e o APP cozinha (computeDps/resolveStage/modeName) com os MESMOS helpers do
    record (live-source.ts + converter/helpers.ts) → uma fórmula só, sem drift Python↔TS. Pura e
    testável: não toca memória nem relógio (`elapsed`/leituras entram por parâmetro). Espelha
    app/src/shared/live-types.ts::RawLive (chaves 1:1).

    - Sem `run_outcome`: o live é SEMPRE a run em andamento (o outcome só existe no close → vai no
      raw/<id>.json, não aqui). Sem envelope: o live é best-effort e efêmero (sobrescrito a cada tick;
      nada persiste). Um campo que não resolveu vira `null` (gold/xp vivos) ou some no app — diferente
      do raw/<id>.json por-run, que É auditado (lá o envelope distingue "não-li" de "li zero"). O live
      nunca grava lixo permanente, então não precisa do ok/err.
    - `stageKey`/`act`/`stageNo`/`difficulty` vão CRUS (o app formata "3-9" e o nome do mode no render).
    - `goldNow`/`xpNow` = ganho vivo acumulado na run (cadeia live→save, ver metric-fallback-chains);
      `None` quando nem live nem save resolveram (o overlay simplesmente não mostra a linha).
    - `party_stats` = {heroKey: {statId: valor}} dos 64 stats FINAIS vivos por herói (mesma fonte do
      raw, read_live_stats_by_hero). ADITIVO (sem bump, exceção da schema-versioning): reader velho não
      emite → o app detecta pela presença e o overlay degrada (sem tooltip). Vazio = sem party viva."""
    return {
        "raw_schema_version": RAW_SCHEMA_VERSION,
        "run": run,
        "stageKey": stage_key,
        "act": act,
        "stageNo": stage_no,
        "difficulty": difficulty,
        "mobs": mobs,
        "total_mobs": total_mobs,
        "damage_now": round(damage_now, 2),
        "elapsed": int(elapsed),
        "gold_now": None if gold_now is None else int(gold_now),
        "xp_now": None if xp_now is None else round(xp_now, 2),
        "party": party,
        "drops": drops,
        "party_stats": party_stats or {},
    }


def _valid_list_size(reader, inst, list_off, cap):
    """size do List<T> em inst+list_off SE for um List ESTRUTURALMENTE válido, senão None.
    O scan de ponteiros acha a classe-K em DEZENAS de slots que NÃO são o objeto real (vtables,
    cópias, metadata): o singleton verdadeiro é o único cujo list_off é um List<T> de verdade —
    items legível, capacidade >= size, e entries que são objetos (classe legível). Antes só se
    checava 0<=size<cap: um slot de lixo com o qword em +SIZE caindo na faixa (ex.: 0 de memória
    zerada) passava, a "lista" nunca crescia e NENHUMA run fechava (bug não-determinístico/launch)."""
    ll = reader.rptr(inst + list_off)
    if not ll or ll < 0x10000:
        return None
    size = reader.ri32(ll + List.SIZE)
    items = reader.rptr(ll + List.ITEMS)
    if size is None or not (0 <= size < cap) or not items or items < 0x10000:
        return None
    maxlen = reader.ri32(items + Array.MAX_LENGTH)
    if maxlen is None or not (size <= maxlen < 1_000_000):
        return None
    for idx in ({0, size - 1} if size else ()):       # entries são objetos com classe legível?
        e = reader.rptr(items + Array.DATA + idx * 8)
        if not e or not reader.read_cstr(reader.rptr((reader.rptr(e) or 0) + Class.NAME)):
            return None
    return size


def _pick_list_singleton(reader, cands, list_off, cap):
    """Singleton REAL entre os falsos-positivos do scan: o candidato com o List estruturalmente
    válido de MAIOR size (o log/monster-list vivo tem entries; o lixo, não). Fallback no pick
    antigo (1o na faixa) p/ um resolve bom NUNCA regredir a None num estado degenerado."""
    best, best_sz = None, -1
    for a in cands:
        s = _valid_list_size(reader, a, list_off, cap)
        if s is not None and s > best_sz:
            best, best_sz = a, s
    if best is not None:
        return best
    return next((a for a in cands
                 if (lambda s: s is not None and 0 <= s < cap)(
                     reader.ri32((reader.rptr(a + list_off) or 0) + List.SIZE))), None)


def _should_skip_run(measured, clear_time, stage):
    """Run com menos de 30s NÃO conta (descarta) — EXCETO stage x-10 (luta só de boss, pode
    durar segundos), que sempre conta. `stage` é o NÚMERO do stage (StageNo), NÃO um
    EStageType.ACTBOSS — são sinais diferentes (ver docs/invariants/run-lifecycle)."""
    return max(measured, clear_time or 0) < 30 and stage != 10


def _is_partial(status, clear_time, measured, total_damage):
    """Captura PARCIAL: o meter entrou numa run já em andamento (<80% do clear oficial) ->
    subcontagem. Trava em clear_time>=30 p/ runs x-10 (boss, segundos) não serem mal-marcadas.
    EXCEÇÃO: success com dano medido <=0 é sempre captura perdida (cobre x-10 com clear<30s que
    pulavam a checagem e subiam 0-de-tudo pro leaderboard, #163)."""
    return bool(status == "success" and (
        (clear_time >= 30 and measured < clear_time * 0.8) or total_damage <= 0))


def _box_belongs_to_pending(mt, has_pending):
    """Roteamento do GetBoxLog: baú de BOSS (mt em TRAILING_BOX_TIERS) com um success
    PENDENTE pertence à run que ACABOU de fechar — o jogo emite esse log ~0.6s DEPOIS do
    StageClearLog, quando o close já abriu a run seguinte. Qualquer outro caso (mob mt=0,
    que dropa durante a stage; mt desconhecido; SEM pendente — ex.: o reader anexou logo
    após um clear alheio) → run atual. Puro/testável (ver run-lifecycle)."""
    return mt in TRAILING_BOX_TIERS and has_pending


def _absorb_drop(rec, drop):
    """Anexa `drop` DENTRO do envelope ok de drops do record pendente. build_raw_record NÃO
    copia a lista (shared.envelope.ok referencia), então mutar o value aqui é exatamente o
    que sai no JSON do flush; a run nova não enxerga (new_run cria drops=[] fresco). True se
    anexou; record fora da forma esperada (nunca acontece: drops é sempre ok(list)) → False
    e o caller mantém o baú na run atual — um baú real NUNCA é descartado. never-raises."""
    env = rec.get("drops") if isinstance(rec, dict) else None
    if isinstance(env, dict) and env.get("ok") is True and isinstance(env.get("value"), list):
        env["value"].append(drop)
        return True
    return False


def _drop_counts(drops, absorbed=None):
    """Contagem de baús por tier [Monster, Boss, ActBoss] pro live.json: drops da run ATUAL
    + os ABSORVIDOS pelo pending-close. O boss box atrasado tem que SUBIR a contagem viva
    enquanto o stage_key vivo ainda é o do clear — é esse rising-edge que o cooldown-tracker/
    drop-notifier do app detectam (uma queda só rebaixa a baseline deles, sem evento; pós-flush
    a contagem cai de volta, inofensivo). NÃO soma a lista completa do record pendente: os
    grays dele ficariam pendurados no overlay até o flush. Puro/testável."""
    dc = [0] * len(EMonsterLogType)
    for d in list(drops or ()) + list(absorbed or ()):
        mt = d.get("monster_type")
        if mt in (EMonsterLogType.Monster, EMonsterLogType.Boss, EMonsterLogType.ActBoss):
            dc[mt] += 1
    return dc


def _new_pending(rec, path, now):
    """Constrói o estado do pending-close que um SUCCESS cria: o record COMPLETO + onde
    escrevê-lo + a deadline do flush (now + PENDING_CLOSE_GRACE) + a lista FRESCA de baús
    absorvidos pós-close (só eles entram na contagem do live; herdar a lista de um close
    anterior re-atribuiria baú — o próprio bug). FONTE ÚNICA da forma: close_run E os testes
    usam este construtor (um espelho de mão nos testes deixaria a forma driftar em silêncio).
    Puro/testável (now entra por parâmetro)."""
    return {"rec": rec, "path": path,
            "deadline": now + PENDING_CLOSE_GRACE, "absorbed": []}


def _flush_pending_rec(pending):
    """Escreve o record do pending-close em disco (a MESMA escrita atômica do close imediato).
    never-raises (roda no tick loop, pós-varredura da LOG_LIST / dentro do close): _write_atomic
    já é best-effort; uma falha de serialização — nunca vista, o record é todo primitivo — vira
    uma linha no meter.log, não um crash que mata a sessão. O caller limpa o estado pendente."""
    if not pending:
        return
    try:
        _write_atomic(pending["path"], json.dumps(pending["rec"], ensure_ascii=False))
    except Exception:
        print(f"\n[pending] WARN flush failed — run record "
              f"{(pending.get('rec') or {}).get('id', '?')} lost")


def _read_catalogs(reader, inst):
    """Deriva os catálogos build-estáveis (stage_info/item_cat/hero_cat) das instâncias
    *Data resolvidas. Usado pelo scan (slow path); o fast path reusa os do calib."""
    stage_info = {}
    for a in inst.get("StageInfoData", []):
        sk = reader.ri32(a + StageInfoData.STAGE_KEY)
        st = reader.ri32(a + StageInfoData.STAGE_TYPE)
        wa = reader.ri32(a + StageInfoData.WAVE_AMOUNT)
        wm = reader.ri32(a + StageInfoData.WAVE_MOB_AMOUNT)
        act = reader.ri32(a + StageInfoData.ACT)
        sno = reader.ri32(a + StageInfoData.STAGE_NO)
        diff = reader.ri32(a + StageInfoData.DIFFICULTY)
        # DIFF, ACT e STAGE_NO são obrigatórios e plausíveis em TODA linha (horda E boss):
        # diff dentro do EStageDifficulty (as keys de DIFF_NAMES — exatamente o que
        # close_run/overlay resolvem), act/sno em 1..200. Uma linha de horda com diff
        # ilegível/fora do enum era catalogada com -1 → modo "?" em TODA run desse stage,
        # PRA SEMPRE (o catálogo persiste na calib). Linha suspeita NÃO entra (§6: degrada,
        # nunca serve/persiste dado errado) — mas dropar abre um BURACO com o MESMO blast
        # radius do x-10 abaixo (modo "?" no fechamento/overlay e adoção/troca de stage
        # cegas no loop), e o buraco persistiria no calib[fp] pela vida do build, não "só
        # nessa run". Quem cura a recorrência é o gate de completude-vs-seed
        # (_covers_seed_keys, no save_calib E no load_calib): com seed cobrindo o fp, um
        # catálogo com buraco nunca persiste nem sombreia o seed são.
        diff_ok = diff in DIFF_NAMES
        actsno_ok = (act is not None and sno is not None
                     and 1 <= act <= 200 and 1 <= sno <= 200)
        waves_ok = bool(wa and wm and 1 <= wa <= 200 and 1 <= wm <= 200) and diff_ok and actsno_ok
        # x-10 (ACTBOSS) não tem waves de horda (wa/wm fora da faixa) -> a linha caía no
        # filtro acima e o stage ficava FORA do catálogo: modo "?" no fechamento/overlay
        # e adoção/troca de stage cegas no loop. Valida pelo STAGE_TYPE + campos
        # plausíveis; horda = 0 (o "+1 = o boss" dos consumidores já cobre o total).
        boss_ok = st == EStageType.ACTBOSS and diff_ok and actsno_ok
        if sk is not None and (waves_ok or boss_ok):
            stage_info[sk] = (act, sno, wa * wm if waves_ok else 0, diff)
    item_cat = {}
    for a in inst.get("ItemInfoData", []):
        ik = reader.ri32(a + ItemInfoData.ITEM_KEY)
        if ik is not None and 0 < ik < 10_000_000 and ik not in item_cat:
            item_cat[ik] = (reader.ri32(a + ItemInfoData.GRADE), reader.ri32(a + ItemInfoData.PARTS),
                            reader.ri32(a + ItemInfoData.LEVEL))
    hero_cat = {}
    for a in inst.get("HeroInfoData", []):
        hk = reader.ri32(a + HeroInfoData.HERO_KEY)
        if hk is not None and 0 < hk < 10_000_000 and hk not in hero_cat:
            hero_cat[hk] = reader.ri32(a + HeroInfoData.CLASS_TYPE)
    return stage_info, item_cat, hero_cat


def _resolve_fast(reader, ga_base, calib):
    """CAMINHO RÁPIDO (name-free, ~ms): resolve a MESMA tupla de 14 do scan a partir do bloco
    `calib` build-estável (sem scan nenhum). Tudo que é leitura/validação de memória mora em
    typeinfo/resolver/gold — aqui só orquestramos: relê a table_base viva pelo anchor_rva (o
    ga_base muda por ASLR a cada launch, o anchor_rva é build-estável), resolve classes/singletons
    por índice + round-trip + size (resolver), o gold por índice (gold) e monta a tupla. Os
    catálogos vêm do calib (build-estáveis). Retorna a tupla de 14 ou None em QUALQUER sanity-fail
    (§6: degrada pro scan, NUNCA serve dado errado).

    PSD/CSD/StageManager NÃO são singletons úteis pra cá: PlayerSaveData/CommonSaveData não são
    singletons (bbwf→None) e o `pick_live_sm` precisa da instância PORTADORA-DE-PARTY (o bbwf do
    StageManager dá UMA instância qualquer, não necessariamente a viva). Os TRÊS vêm de UM backref
    direcionado (resolver.instances_of) sobre as regiões READABLE — K já obtido por índice, falta
    só achar quem aponta pra ele. Single-sweep (#110): 3 needles ≈ 1, ~8s na máquina do Mario. Isso
    deixa psd_list/csd_list/sm_list POPULADOS antes do `ready` → o new_run() do startup (que lê PSD
    p/ build/heroes/baselines) tem PSD vivo. `pick_live_sm` opera como hoje sobre a lista do backref."""
    tbase = typeinfo.table_base(reader, ga_base, calib["anchor_rva"])
    if not tbase:
        return None
    rv = resolve_via_rva(reader, tbase, calib["indices"], TARGETS, SINGLETONS)
    gold_klass = resolve_combat_gold_klass_by_index(reader, tbase, calib["idx_ut"])
    if rv is None or not gold_klass:
        return None
    classes, instances = rv
    sc_class = next(iter(classes["StageClearLog"]))
    sf_class = next(iter(classes["StageFailedLog"]))
    gb_class = next(iter(classes["GetBoxLog"]))
    die_class = next(iter(classes["HeroDieLog"]))
    res_class = next(iter(classes["ResurrectionLog"]))
    # Managers MSM/LM: o resolver já validou a instância por size (§ resolver._manager_inst_ok).
    msm = next(iter(instances["MonsterSpawnManager"]), None)
    lm = next(iter(instances["LogManager"]), None)
    # PSD/CSD/StageManager por backref direcionado (UM scan, ~8s). PSD/CSD não-singletons; o
    # StageManager vem daqui (não do bbwf) p/ que pick_live_sm escolha a instância com party,
    # exatamente como no slow path. PSD vazio (ex.: não-logado) NÃO falha o fast path — é a
    # mesma degradação que o scan teria (pick_live_psd→None → build vazio só dessa run, §6).
    _tb = time.time()
    insts = instances_of(reader, regions(reader),
                         {name: next(iter(classes[name])) for name in
                          ("PlayerSaveData", "CommonSaveData", "StageManager")})
    print(f"[calib] fast path PSD/CSD/StageManager backref in {time.time() - _tb:.1f}s "
          f"(PSD={len(insts['PlayerSaveData'])} CSD={len(insts['CommonSaveData'])} "
          f"SM={len(insts['StageManager'])})")
    psd_list = insts["PlayerSaveData"]
    csd_list = insts["CommonSaveData"]
    sm_list = insts["StageManager"]
    return (sc_class, sf_class, msm, lm, csd_list, psd_list,
            calib["stage_info"], calib["item_cat"], calib["hero_cat"],
            sm_list, gold_klass, gb_class, die_class, res_class)


def _resolve_scan(reader):
    """CAMINHO LENTO (scan ~190s + value-scan do gold ~90s): resolve do zero via il2cpp.resolver
    e deriva todos os managers/catálogos. Fallback GARANTIDO (§6) — sempre funciona, qualquer
    build. Retorna (tupla de 14, classes) — `classes` alimenta a calibração no resolve_all."""
    regs = regions(reader)
    classes, inst = resolve(reader, regs, TARGETS)
    sc_class = next(iter(classes["StageClearLog"]), None)
    sf_class = next(iter(classes["StageFailedLog"]), None)
    gb_class = next(iter(classes.get("GetBoxLog", [])), None)
    die_class = next(iter(classes.get("HeroDieLog", [])), None)
    res_class = next(iter(classes.get("ResurrectionLog", [])), None)
    # Pick os managers por VALIDAÇÃO ESTRUTURAL (não 1o-na-faixa): o scan retorna dezenas de
    # falsos-positivos; um slot de lixo com size=0 num endereço menor sombreava o LogManager real
    # → a lista nunca crescia → NENHUMA run fechava. Caps canônicos: MSM=2000, LM=100000 (LOG_LIST
    # cresce a sessão inteira). Ver _pick_list_singleton/_valid_list_size.
    msm = _pick_list_singleton(reader, inst["MonsterSpawnManager"], MonsterSpawnManager.MONSTER_LIST, 2000)
    lm = _pick_list_singleton(reader, inst["LogManager"], LogManager.LOG_LIST, 100000)
    # infra-log: pick estrutural dos managers (instance-selection). Um LM mal-escolhido (lista morta)
    # = NENHUMA run fecha (bug histórico "runs não fecham"). Logar cands/escolhido torna isso visível.
    diag(f"[manager-pick] MSM cands={len(inst['MonsterSpawnManager'])} picked={hex(msm) if msm else None}; "
         f"LM cands={len(inst['LogManager'])} picked={hex(lm) if lm else None}")
    csd_list = list(inst.get("CommonSaveData", []))
    psd_list = list(inst.get("PlayerSaveData", []))
    sm_list = list(inst.get("StageManager", []))
    stage_info, item_cat, hero_cat = _read_catalogs(reader, inst)
    # Gold vivo: resolve o klass do AggregateManager por ESTRUTURA (name-free; ver metrics.gold).
    # Toda a lógica de gold mora no gold.py — aqui (e no resto do meter) a gente SÓ chama.
    _tg = time.time()
    gold_klass = resolve_combat_gold_klass(reader, psd_list)
    print(f"[resolve] gold singleton (writable value-scan) in {time.time() - _tg:.1f}s")
    tup = (sc_class, sf_class, msm, lm, csd_list, psd_list, stage_info,
           item_cat, hero_cat, sm_list, gold_klass, gb_class, die_class, res_class)
    return tup, classes


def _calibrate(reader, pid, fp, cache_path, classes, stage_info, item_cat, hero_cat, gold_klass):
    """CALIBRA após um scan completo: descobre o anchor_rva + índices + idx_ut e persiste em
    calib[fp] (deliverable 02). Toda a lógica de descoberta mora em typeinfo/gold — aqui só
    orquestramos + persistimos. NUNCA quebra o fluxo (falhar = só não acelera da próxima).

    O idx_ut sai de um WALK barato da tabela: por valor==gold_klass (gold_index_of_klass) quando o
    scan já bootstrapou o `gold_klass`, OU — quando o value-scan NÃO converge (gold_klass None: o
    save defasou do vivo, visto no 1.00.11) — por ESTRUTURA (gold_index_by_structure: o índice cujo
    table[idx] passa combat_gold_klass_ok, o MESMO gate do fast path). Ambos name-free e sem re-rodar
    o value-scan de ~40s. (Histórico: find_gold_index(reader, tbase, []) com psd vazio fazia o
    value-scan falhar → idx_ut None → calib NUNCA salvava → o fast path nunca ativava. Bug.)

    OBRIGAÇÃO CARREGADA (validação 01): se a descoberta falhar (anchor OU idx_ut None), EMITE
    um log-event claro — um build que "nunca acelera" tem que ser OBSERVÁVEL (o stdout vai pro
    meter.log + relay do app). Sem fp/ga_base não dá pra calibrar (cai fora sem ruído)."""
    if not fp:
        return
    ga_base, ga_size = typeinfo.ga_module(pid)
    if not ga_base or not ga_size:
        print("[calib] FAILED to read GameAssembly.dll module — build will keep scanning")
        return
    regs = regions(reader)
    known_K = {name: next(iter(classes[name])) for name in classes if classes[name]}
    disc = typeinfo.discover_anchor(reader, ga_base, ga_size, known_K, regs)
    if disc is None:
        print("[calib] FAILED to discover anchor — build will keep scanning")
        return
    anchor_rva, tbase2, indices = disc
    # idx_ut: reusa o klass do scan como atalho (gold_index_of_klass) quando existe; senão — value-scan
    # não convergiu (gold_klass None) — deriva por ESTRUTURA (gold_index_by_structure), name-free e
    # independente do save. Ambos varrem a mesma tabela; os dois evitam re-rodar o value-scan.
    idx_ut = gold_index_of_klass(reader, tbase2, gold_klass) if gold_klass else None
    if idx_ut is None:
        idx_ut = gold_index_by_structure(reader, tbase2)
    if idx_ut is None:
        print("[calib] FAILED to locate gold idx in table — build will keep scanning")
        return
    save_calib(cache_path, fp, anchor_rva, indices, idx_ut, stage_info, item_cat, hero_cat)
    print(f"[calib] anchor_rva={hex(anchor_rva)} idx_ut={idx_ut} indices={len(indices)} — "
          "fast path armed for this build")


def resolve_all(reader, pid, fp, cache_path):
    """Orquestra a resolução com GATE por fingerprint de build (§1: fino — toda lógica RVA mora
    em typeinfo/resolver/gold). Cadeia de fallback (§6): calib[fp] (build-estável) → scan+calibra.
    Reusável no startup E no re-attach. Tupla de 14 na ordem do cache (shape NUNCA muda).

    `pid` é necessário p/ ler o módulo GameAssembly.dll (typeinfo.ga_module); `fp` é o
    fingerprint de build (computado no run() via _detect_game_version, chave do calib);
    `cache_path` é o resolve_cache.json (respeita --output)."""
    ga_base, _ga_size = typeinfo.ga_module(pid)
    # FAST PATH: build conhecido → resolve por índice/bbwf (~ms), sem scan.
    if fp and ga_base:
        calib = load_calib(cache_path, fp)
        if calib:
            tup = _resolve_fast(reader, ga_base, calib)
            if tup is not None:
                print(f"[calib] fast path (fp {fp}) — resolved via RVA, no scan")
                diag(f"[resolve] path=FAST fp={fp} (calib hit, RVA, no scan)")
                return tup
            print("[calib] fast path sanity-fail (RVA/idx/size) — falling back to scan")
            diag(f"[resolve] fast-path SANITY-FAIL (RVA/idx/size) → cold scan fp={fp}")
        else:
            diag(f"[resolve] calib MISS (seed+cache não cobrem fp) → cold scan fp={fp}")
    else:
        diag(f"[resolve] sem fp/ga_base (fp={fp} ga_base={hex(ga_base) if ga_base else None}) → cold scan")
    # SLOW PATH: scan garantido + calibra ao final (persist-gate em save_calib).
    _emit_status("scanning")   # app: splash mostra "primeira vez nesta versão, mapeando (~1 min)"
    print("resolving classes/instances (~1-2min)...")
    tup, classes = _resolve_scan(reader)
    (sc_class, sf_class, msm, lm, _csd, _psd, stage_info,
     item_cat, hero_cat, _sm, gold_klass, *_rest) = tup
    if msm and lm and sc_class and sf_class:
        _calibrate(reader, pid, fp, cache_path, classes, stage_info, item_cat, hero_cat, gold_klass)
        diag(f"[resolve] path=SCAN fp={fp} → calibrated (persisted)")
    else:
        diag(f"[resolve] path=SCAN fp={fp} → NÃO calibrado (incompleto: "
             f"msm={bool(msm)} lm={bool(lm)} sc={bool(sc_class)} sf={bool(sf_class)})")
    return tup


def run(hz, output_dir, debug=False):
    _emit_status("searching")   # app: splash mostra "procurando o jogo"
    cache_path = os.path.join(output_dir, "resolve_cache.json")
    pid = find_pid()
    if not pid:
        print("[error] game is not open."); diag("[attach] game NOT open (find_pid None)"); return
    handle = open_process(pid)
    if not handle:
        print("[error] OpenProcess failed (run as admin?).")
        diag(f"[attach] OpenProcess FAILED pid={pid} (admin/AV?)"); return
    # O meter monta o Reader (fogão); TODA leitura de memória passa por ele. Módulos isolados (o
    # chef): shared.memory/il2cpp (anexar/resolver), game.save/build, metrics.gold/xp/dps.
    reader = Reader(handle)
    print(f"[ok] attached (pid {pid}).")
    _emit_status("resolving")   # app: splash mostra "lendo a memória do jogo"
    gv = _detect_game_version(handle)
    game_version = gv or GAME_VERSION
    print(f"[ok] game version {game_version}" + ("" if gv else " (fallback — Version.txt unreadable)") + ".")
    t0 = time.time()
    # run_num = contador LOCAL do console/log só (reinicia a cada launch). NÃO é a identidade da run
    # (essa é o horário, em build_raw_record) nem a session (o app deriva). Sem session.json.
    run_num = 1
    # Fingerprint de build = chave do calib (build-estável). Computado UMA vez aqui (precisa do
    # ga_base do módulo + da versão instalada lida pelo handle); passado pro resolve_all gatear.
    ga_base0, _ = typeinfo.ga_module(pid)
    fp = typeinfo.build_fingerprint(reader, ga_base0, gv) if ga_base0 else None
    diag(f"[attach] pid={pid} version={game_version} fp={fp} "
         f"ga_base={hex(ga_base0) if ga_base0 else None}")
    # Cadeia única (calib-only, sem cache legado de endereços): calib[fp] (build-estável,
    # revalidado por round-trip + size a cada launch) → scan+calibra. resolve_all gateia.
    (sc_class, sf_class, msm, lm, csd_list, psd_list, stage_info, item_cat,
     hero_cat, sm_list, gold_klass, gb_class, die_class, res_class) = resolve_all(reader, pid, fp, cache_path)
    # tbase/idx_ut: handles do fast path do GOLD p/ os re-resolve mid-sessão (re-resolve do
    # startup, self-heal pós-run, re-attach). resolve_all NÃO devolve isso (a tupla de 14 tem shape
    # fixo — o re-attach a desempacota), então recomputamos aqui a partir do calib build-estável:
    # idx_ut é constante do build; tbase = ponteiro vivo da TypeInfoTable via anchor_rva (relido por
    # ga_base, que muda por ASLR a cada launch — reusamos o ga_base0 já computado p/ o fp). Sem calib
    # (build novo, ainda em scan) → ambos None → os sítios caem no value-scan, como hoje (§6).
    # NEW-2: tbase/idx_ut são LOCAIS de run(), REatribuídos no lugar (aqui e no re-attach); close_run
    # os lê como free-vars (sem nonlocal p/ leitura). No re-attach o ga_base MUDA → tbase recomputado.
    _calib0 = load_calib(cache_path, fp) if fp else None
    if _calib0 and ga_base0:
        tbase = typeinfo.table_base(reader, ga_base0, _calib0["anchor_rva"])
        idx_ut = _calib0["idx_ut"]
    else:
        tbase = idx_ut = None
    print(f"[ok] resolved in {time.time()-t0:.0f}s. stages={len(stage_info)} "
          f"items-catalog={len(item_cat)} heroes-catalog={len(hero_cat)} "
          f"PSD={len(psd_list)} CSD={len(csd_list)}.\n")
    # infra-log: o meter.log NÃO loga o nº de candidatas StageManager nem o gold — e foi a contagem
    # de SM (453) que importou no party-off do 1.00.13 (ver shared/utils.diag).
    diag(f"[resolve] fp={fp} SM={len(sm_list)} PSD={len(psd_list)} CSD={len(csd_list)} "
         f"gold={'ok' if gold_klass else 'None'} stages={len(stage_info)} "
         f"items={len(item_cat)} heroes={len(hero_cat)}")

    if not (msm and lm and sc_class and sf_class):
        print("\n[error] incomplete resolution. Try again with the game in combat.")
        diag(f"[resolve] INCOMPLETE → abort (msm={bool(msm)} lm={bool(lm)} "
             f"sc={bool(sc_class)} sf={bool(sf_class)})")
        return

    csd = save.pick_live_csd(reader, csd_list)
    sm = save.pick_live_sm(reader, sm_list)
    print(f"[live party] StageManager {'ok' if sm else 'NOT found (live xp off, uses save)'}"
          f" — {len(build.read_live_party(reader, sm))} heroes deployed.")
    # infra-log: a decisão do pick em detalhe — candidatas, carriers REAIS vs ghosts (heroKey ok mas
    # read_live_party vazio), qual foi escolhida + amostra de ghosts. ISTO faltou no debug do 1.00.13:
    # "carriers=0 picked=0x.. party_read=0" + um ghost com lvl=0 teria apontado a causa na hora.
    _smd = build.describe_sm_candidates(reader, sm_list, sm)
    diag(f"[party-pick] startup candidates={_smd['total']} hk-accept={_smd['hk_accept']} "
         f"carriers={_smd['carriers']} picked={hex(_smd['picked']) if _smd['picked'] else None} "
         f"party_read={len(build.read_live_party(reader, sm))}")
    for _ga, _gh in _smd["ghosts"]:
        diag(f"[party-pick]   ghost {hex(_ga)} heroes(hk,lvl,exp)={_gh}")
    # infra-log: pick do SAVE — PSD (fonte de gold/heroes do build) e CSD (stage atual). PSD None foi
    # o bug do 1.00.12 (offsets do save deslocados → read_gold=0 → pick_live_psd None → run sem
    # heroes/gold → upload parava). Logar psd/gold/heroes aqui torna esse modo de falha visível.
    _psd = save.pick_live_psd(reader, psd_list)
    diag(f"[save-pick] psd_cands={len(psd_list)} psd={hex(_psd) if _psd else None} "
         f"gold={save.read_gold(reader, _psd) if _psd else None} "
         f"heroes={len(save.read_heroes(reader, _psd)) if _psd else 0}; "
         f"csd_cands={len(csd_list)} csd={hex(csd) if csd else None}")
    # Gold vivo: lê GoldEarn[SubKey1] do AggregateManager VIVO, resolvido por ESTRUTURA (name-free,
    # imune ao nome ofuscado mudar entre builds; ver metrics.gold). Reusa o klass do cache se ainda
    # válido (barato); senão resolve. Toda a lógica mora no gold.py — aqui a gente só chama.
    if not (gold_klass and combat_gold_klass_ok(reader, gold_klass)):
        # §6 fallback: índice primário (~ms, build calibrado) → value-scan fallback (~90s, sem calib
        # ou índice falhou). resolve_combat_gold_klass_by_index já tem o gate anti-veneno (round-trip),
        # então None = índice ruim/sem calib → cai no value-scan, NUNCA serve klass errado.
        gold_klass = None
        if tbase and idx_ut is not None:
            gold_klass = resolve_combat_gold_klass_by_index(reader, tbase, idx_ut)
        if not gold_klass:
            gold_klass = resolve_combat_gold_klass(reader, psd_list)
    if gold_klass:
        print(f"[live gold] AggregateManager klass {hex(gold_klass)} — GoldEarn[SubKey1] live "
              f"(exact per-run, lag-free, exclui venda; imune a drift de nome)")
    else:
        print("[live gold] NOT resolved — combat gold from save (stale, fallback)")
    # infra-log: gold resolvido + valor vivo (combate). klass=None ou live absurdo (0 / 1.97T) =
    # a fonte de gold quebrou — bugs históricos do gold (value-scan pegando frozen=0 ou junk).
    diag(f"[gold] klass={hex(gold_klass) if gold_klass else None} "
         f"live={combat_gold_live(reader, gold_klass) if gold_klass else None}")
    print("Measuring per run (success/fail) — Ctrl+C to exit.\n")
    _emit_status("ready")   # app: reader anexou + resolveu -> splash fecha

    snap_dir = output_dir
    try:
        os.makedirs(snap_dir, exist_ok=True)
    except Exception:
        pass
    # Snapshot vivo CRU (~1x/s), sobrescrito: o reader emite números/ids vivos e o APP cozinha o
    # overlay (computeDps/resolveStage/modeName) — reader burro de apresentação.
    # Substituiu o meter_live.txt cozido (dps/label/format no reader). Transporte =
    # arquivo sobrescrito (não canal); o app faz poll por mtime-advance (LiveSource, SMB-skew immune).
    live_path = os.path.join(snap_dir, "live.json")
    raw_dir = os.path.join(snap_dir, "raw")   # 1 arquivo por run: raw/<ts_ms>.json (cru; id = horário)
    os.makedirs(raw_dir, exist_ok=True)

    interval = 1.0 / hz

    def new_run():
        nonlocal sm
        # pick_live_sm retorna None se nenhuma party está em campo (anexou na cidade/menu): re-tenta
        # a cada run p/ pegar a instância PORTADORA-DE-PARTY assim que uma party é deployada. Sem
        # isso, sm fica None a sessão inteira se o startup foi fora de combate → party/XP vivos off.
        if not sm:
            sm = save.pick_live_sm(reader, sm_list)
        p = save.pick_live_psd(reader, psd_list)
        pl0 = build.read_live_party(reader, sm)
        # Acumulador VIVO de xp por-herói (metrics.xp.PartyXpAccumulator) — o LIVE primário da
        # cadeia de xp. Estado da run nasce AQUI (nunca só no close — vazaria a run anterior) e é
        # SEMEADO com a party do t=0. Quem entra DEPOIS (deploy tardio / morto da run anterior que
        # revive no meio) semeia no 1º avistamento do snapshot 1s — o fix do +0xp que o delta de
        # endpoints (exp_start só no t=0) dava a herói fora do baseline.
        xpacc = xp.PartyXpAccumulator()
        xpacc.update(pl0)
        return {"dps": DpsTracker(), "mobs": 0, "start": time.time(),
                "gold_start": save.read_gold(reader, p) or 0,
                # Baseline do gold de combate VIVO no INÍCIO (delta no fechamento = gold da run).
                # + baseline do save como fallback (se o vivo não resolver). Tudo via gold.py.
                "gold_live_start": combat_gold_live(reader, gold_klass),
                "gold_save_start": combat_gold_save(reader, p),
                "heroes_start": {k: v[1] for k, v in save.read_heroes(reader, p).items()},
                "party_live_start": pl0,
                "xp_acc": xpacc,
                "build": build.read_build(reader, p, item_cat, hero_cat),
                "drops": [],
                # heroKeys vistos deployados durante a run (acumulado do snapshot 1s) — cobre o
                # sm que resolve TARDE: pl_start vazio, mas a party aparece segundos depois.
                "party_seen": {},
                # Mortes/revives/quem-matou da run (heroKey-keyed; dos logs HeroDie/Resurrection).
                "deaths": {}, "revives": {}, "killers": {},
                "stage_key": None, "adopt_until": time.time() + 3.0}

    R = new_run()
    # run_num NÃO é zerado aqui — vem retomado de resume_session (acima) p/ não reciclar id.
    _ll0 = reader.rptr(lm + LogManager.LOG_LIST)
    last_size = (reader.ri32(_ll0 + List.SIZE) or 0) if _ll0 else 0
    last_alive = 0
    prev_dead = None    # tamanho anterior do DeadMonsterUnit (p/ detectar reload do stage)
    dead_reads = 0      # leituras consecutivas falhando = jogo fechou/reiniciou (re-anexa)
    last_snap = 0.0
    last_refresh = 0.0
    REFRESH = 1.0
    # variaveis "ao vivo" lidas no loop (usadas tb no fechamento)
    cur_key = reader.ri32(csd + CommonSaveData.CURRENT_STAGE_KEY) if csd else None
    total_mobs = None
    stage_lbl = "?"
    mode_txt = "?"

    # PENDING-CLOSE (boss box atrasado): o record de um SUCCESS não vai pro disco na hora —
    # fica pendente por até PENDING_CLOSE_GRACE pra absorver o GetBoxLog mt=1/2 que o jogo
    # emite ~0.6s DEPOIS do StageClearLog (senão o baú do boss caía na run SEGUINTE).
    # fail/abandoned escrevem na hora (boss box só segue clear). Estado: rec (a mutar via
    # _absorb_drop) + path + deadline + absorbed (só os baús pós-close, pro live count).
    pending = None

    def flush_pending():
        # Escreve o pendente (se houver) e limpa. Chamado de TODOS os pontos de saída da
        # janela: no tick com a deadline vencida, APÓS a varredura da LOG_LIST (um boss box
        # que aflora no MESMO tick da expiração ainda absorve — janela efetiva GRACE + ≤1
        # tick); TOPO do close_run (qualquer status — preserva a ordem dos records em disco
        # e garante NO MÁXIMO um pendente); caminho de game-closed/re-attach (o pendente é
        # uma run COMPLETA já fechada; perdê-la porque o jogo fechou 2s após o clear seria
        # regressão — hoje já estaria em disco); e o finally do run() (Ctrl+C/exceção).
        # never-raises (_flush_pending_rec).
        nonlocal pending
        _flush_pending_rec(pending)
        pending = None

    def close_run(status, stage_key, e=None):
        # Fecha a run atual com um status (sucesso/falha/abandonada), registra e recomeça.
        # stage_key = stage que ESTAVA sendo jogado (na abandonada, o antigo).
        nonlocal R, run_num, gold_klass, pending
        # Flush do pendente ANTES de montar o record novo: dois closes dentro da janela
        # (ex.: clear → abandono na expiração da graça) saem em ORDEM no disco e nunca há
        # dois pendentes. No caso comum (sem pendente) é no-op.
        flush_pending()
        si = stage_info.get(stage_key)
        act = si[0] if si else None
        stage = si[1] if si else None
        total = (si[2] + 1) if si else None
        mode = DIFF_NAMES.get(si[3], "?") if si else "?"
        clear_time = 0
        wave_now = wave_tot = None
        if status in ("success", "fail") and e is not None:
            la, ls = reader.ri32(e + StageClearLog.ACT), reader.ri32(e + StageClearLog.STAGE)
            act = la if la is not None else act
            stage = ls if ls is not None else stage
            if status == "success":
                clear_time = reader.ri32(e + StageClearLog.CLEAR_TIME) or 0
            else:
                wave_now = reader.ri32(e + StageFailedLog.NOW_WAVE)
                wave_tot = reader.ri32(e + StageFailedLog.TOTAL_WAVE)
        measured = time.time() - R["start"]
        # O reader emite TODA run — curta/parcial inclusive ("skip ≠ sumir", senão o user acha que o
        # meter quebrou). Quem decide o que CONTA (floor 15s exc. x-10) é o CONVERSOR (app), aplicando
        # _should_skip_run sobre os campos CRUS deste record — por isso o reader NÃO o chama mais aqui
        # (segue como a spec canônica drift-testada, portada pro TS no conversor). `partial` abaixo é
        # só anotação do summary/console; também NÃO entra no record (o conversor o deriva).
        fp = save.pick_live_psd(reader, psd_list)
        heroes_end = save.read_heroes(reader, fp)
        # Gold por run = delta do cumulativo de combate VIVO (GoldEarn[SubKey1] do AggregateManager;
        # exato, tempo real, exclui venda/idle). Só cai pro delta do SAVE se o vivo não resolver/ler
        # (save é defasado e em saltos -> pode dar 0 ou ~2x; por isso é só fallback). Tudo no gold.py.
        live_gain = run_gain(R.get("gold_live_start"), combat_gold_live(reader, gold_klass))
        if live_gain is not None:
            gold_gain, ge_src, gold_ok = live_gain, "live", True
        else:
            save_delta = run_gain(R.get("gold_save_start"), combat_gold_save(reader, fp))
            # Vivo E save falharam -> NÃO grava 0 (era o bug do gold:0, indistinguível de ganho zero):
            # gold_ok=False -> o envelope marca err e o conversor degrada a run, honesto.
            gold_ok = save_delta is not None
            gold_gain, ge_src = (save_delta if gold_ok else 0), "save"
        # Captura PARCIAL: o meter entrou numa run já em andamento (viu < 80% do clear oficial) ->
        # dano/gold/xp subcontados. Marca EXPLÍCITO p/ o app descartar pela flag, em vez de inferir
        # "parcial" de gold==0 (que escondia em silêncio runs COMPLETAS sempre que a leitura do gold
        # vivo falhava). Só em clear (clear_time = duração oficial); trava em >=30s p/ runs x-10
        # (boss, segundos) nunca serem mal-marcadas. EXCEÇÃO da exceção: success com dano medido
        # ZERO é sempre captura perdida (o jogo não limpa stage sem dano) — cobre o gap das x-10
        # com clear <30s, que pulavam a checagem e subiam pro leaderboard com 0 de tudo (#163).
        partial = _is_partial(status, clear_time, measured, R["dps"].total_damage)
        # xp save-side (só fallback): delta de HeroExp por herói (já inclui runas/itens/bônus).
        # HeroExp zera no level-up -> o ganho de quem sobe de nível fica subestimado (raro p/ herói
        # alto). No CAP o HeroExp também NUNCA reseta (sem level-up pra consumir) -> o delta do save
        # é XP FANTASMA: herói no cap (xp.level_capped) vale 0, igual à viva. xp_gain = soma dos
        # deltas por-herói (a viva, sem esses problemas, é o caminho normal).
        xp_by_hero = {k: 0.0 if xp.level_capped(v[0]) else max(0.0, v[1] - R["heroes_start"].get(k, 0.0))
                      for k, v in heroes_end.items()}
        xp_gain = sum(xp_by_hero.values())
        # XP VIVA = o ACUMULADOR por-herói (metrics.xp.PartyXpAccumulator), que integrou o
        # within-level (EXP_FAKE) tick-a-tick a run INTEIRA (semeado no new_run, alimentado pelo
        # snapshot 1s). Aqui só: 1 tick FINAL (banka o último ≤1s) + leitura dos records prontos.
        # Substitui o delta de endpoints (baseline t=0 → leitura no close), que dava +0 a herói
        # FORA do baseline (deploy tardio / morto da run anterior em revive: gain=None → +0 no
        # app) e exigia re-ler o uf do morto — o acumulador já bankou o ganho de quem morreu
        # (morto acumula 0 enquanto morto, comportamento real do jogo, preservado).
        xpacc = R["xp_acc"]
        pl_end = build.read_live_party(reader, sm)     # never-raises -> {} em falha
        xpacc.update(pl_end)
        R["party_seen"].update(dict.fromkeys(pl_end))  # vivo no close = visto (live_keys ⊇ acc)
        # XP por-run = a VIVA (real-time, exata). O save é snapshot defasado (delta inútil: 0 ou pulo
        # de ~10M conforme o save-write cai na run = jitter) -> NÃO registra mais; só fallback silencioso
        # se a viva não rolou (acumulador nunca viu ninguém = sm off a run inteira), pra nunca zerar
        # xp num caso degradado. total() devolve None nesse caso — NUNCA conflar com 0 (ganho válido).
        xp_total_live = xpacc.total()
        xp_live_ok = xp_total_live is not None
        xp_best = round(xp_total_live, 2) if xp_live_ok else xp_gain
        xp_src = "live" if xp_live_ok else "save"
        # Leu xp se a viva rolou (acumulador viu alguém) OU houve dado de save (heroes_end). Nenhum ->
        # err no envelope (mesma lógica do gold: não-li != ganhei-zero).
        xp_ok = xp_live_ok or bool(heroes_end)
        # Artefato = só os heróis REALMENTE deployados nesta run (party viva = StageManager.HeroList).
        # O save lista a party arranjada/roster (jogando solo com a Ranger o save lista os 6) -> filtra
        # por live_keys: pl_start ∪ party_seen (sm que resolve TARDE entra via snapshot 1s).
        # DEGRADAÇÃO HONESTA (party viva off a run INTEIRA, sm nulo => live_keys vazio): NINGUÉM entra
        # (hero_in_run), heroes vira `err` e a run leva ⚠ no log — NUNCA despejar o roster do save (era
        # o BUG — 5 heróis com +0xp jogando solo) nem proxy-chute por xp>0 (pegaria xp idle). Ver
        # [[invariants/party-live-resolution]].
        live_stats = build.read_live_stats_by_hero(reader, sm)  # T3: 64 stats FINAIS vivos por heroKey
        pl_start = R.get("party_live_start", {})
        live_keys = set(pl_start) | set(R.get("party_seen") or ())
        party_degraded = not live_keys
        heroes_out = []
        for h in R["build"]:
            hk = h["heroKey"]
            # Inclusão (regra pura/testável em build.hero_in_run): SÓ os heróis da party VIVA
            # (live_keys). SEM party viva, NINGUÉM entra -> heroes vira `err` (heroes_ok=False abaixo),
            # nunca o roster nem um chute. Era o bug dos 5 heróis com +0xp jogando solo.
            if not build.hero_in_run(hk, live_keys):
                continue
            hh = dict(h)
            hh["stats"] = live_stats.get(hk, {})
            xrec = xpacc.record(hk)
            if xrec is not None:
                # Caminho normal: o acumulado VIVO da run (0.0 = ganho zero VÁLIDO, não falha).
                hh["xp_gained"] = xrec["gain"]
                hh["exp_start"] = xrec["exp_start"]
                hh["exp_end"] = xrec["exp_end"]
                if xrec["levelup"]:
                    hh["levelup"] = True
                if hk not in pl_end:
                    hh["died"] = True   # ausente do HeroList no fechamento (morto sem revive)
            else:
                # Em live_keys mas o acumulador nunca o viu — não deveria ocorrer (o acc come as
                # MESMAS leituras que alimentam pl_start/party_seen). Fallback por-herói do SAVE
                # (xp_by_hero), NUNCA None/+0 (o bug do morto-na-fronteira) nem o roster. ⚠ no log
                # torna o invariante OBSERVÁVEL (em vez de assumido): se disparar, sum(heroes.xp)
                # passa do total da run (acc exclui este herói save-sourced) — sinal de regressão.
                hh["xp_gained"] = round(xp_by_hero.get(hk, 0.0), 2)
                print(f"⚠ xp acc-miss hero={hk} (em live_keys sem record do acc) "
                      f"-> save fallback +{hh['xp_gained']}")
            # Sobrevivência por herói (dos logs HeroDie/Resurrection): mortes, revives, quem matou.
            deaths_h = R["deaths"].get(hk, 0)
            if deaths_h:
                hh["deaths"] = deaths_h
            revives_h = R["revives"].get(hk, 0)
            if revives_h:
                hh["revives"] = revives_h
            killed_by = R["killers"].get(hk)
            if killed_by:
                hh["killed_by"] = killed_by                            # monsterKeys que mataram este herói
            heroes_out.append(hh)
        ref = clear_time if clear_time else max(measured, 1)
        total_damage = R["dps"].total_damage
        dps = total_damage / ref
        def _hxp(h):
            return fmt(h.get("xp_gained", 0.0)) + ("⇧lvl" if h.get("levelup") else "")
        party = ", ".join(f"{h['heroKey']}/{h['class']}/{h['level']}(+{_hxp(h)}xp)"
                          for h in heroes_out) or "?"
        mark = {"success": "✔", "fail": "✗", "abandoned": "↩"}.get(status, "•")
        if status == "success":
            head = f"official {clear_time}s (measured {measured:.0f}s)"
            if clear_time and abs(measured - clear_time) > 0.2 * clear_time:
                head += " ⚠ measured≠official"
            if partial:
                head += " ⚠partial"
        elif status == "fail":
            head = f"measured {measured:.0f}s  wave {wave_now}/{wave_tot}"
        else:
            head = f"measured {measured:.0f}s  (partial)"
        n_deaths = sum(R["deaths"].values())
        # party degradada (viva off a run INTEIRA): heroes vira `err` no raw -> o conversor sela a run
        # `degraded` (não sobe pro leaderboard; aparece no app, marcada). A linha leva ⚠ no meter.log
        # -> observável (e o validate_live.py pega ao vivo). Nunca passa batido.
        party_warn = " ⚠party indisponível(viva off)" if party_degraded else ""
        summary = (f"{mark} run #{run_num} [{status.upper()}]  Stage {act}-{stage} [{mode}]  "
                   f"{head}  DPS {fmt(dps)}/s  damage {fmt(total_damage)}  deaths {n_deaths}  "
                   f"mobs {R['mobs']}/{total or '?'}  "
                   f"gold +{fmt(gold_gain)}[{ge_src}]  xp +{fmt(xp_best)}[{xp_src}]  "
                   f"party{party_warn} [{party}]")
        print("\n" + summary)   # vai pro meter.log (log de evento) — não é a fonte do app
        # infra-log (reader-diag.log): POR QUE a run é boa/degradada, em campos estruturados (o
        # meter.log mistura tudo numa linha de texto). gold_ok/xp_ok/party_degraded apontam QUAL
        # campo caiu (party_degraded=True → heroes:err → run degradada); src=live/save = o fallback.
        diag(f"[run-close] #{run_num} {status} stage={act}-{stage}[{mode}] measured={measured:.0f}s "
             f"clear={clear_time}s partial={partial} gold_ok={gold_ok}/{ge_src} "
             f"xp_ok={xp_ok}/{xp_src} party_degraded={party_degraded} "
             f"heroes_out={len(heroes_out)} live_keys={len(live_keys)}")
        # Snapshot da conta no fechamento (fonte SAVE): runas + inventário + stash CRUS. Reusa a `fp`
        # (psd viva já escolhida acima) e o `item_cat` (free-var de run()). never-raises; NÃO-LI ->
        # None (vira err no record abaixo), nunca [] silencioso.
        runes, inventory, stash = build.read_account_snapshot(reader, fp, item_cat)
        # Record CRU v2 (raw/<id>.json), 1 arquivo por run, escrita atômica. SÓ observação — sem
        # dps/taxas/partial/mode/stage-string/totais (o conversor deriva). Campos de leitura vão
        # em envelope ok/err. `dps`/`partial` acima são só do summary/live; NÃO entram aqui.
        ts_ms = int(time.time() * 1000)   # id = horário de FIM em ms (a identidade da run; sem session/contador)
        rec = build_raw_record(
            ts_ms=ts_ms, run_outcome=status,
            game_version=game_version, duration=measured,
            stage_key=stage_key, act=act, stage_no=stage,
            difficulty=(si[3] if si else None), total_mobs=total,
            mobs=R["mobs"], total_damage=total_damage, clear_time=clear_time,
            gold=gold_gain, gold_ok=gold_ok, gold_source=ge_src,
            xp_gained=xp_best, xp_ok=xp_ok, xp_source=xp_src,
            drops=R["drops"], heroes=heroes_out, heroes_ok=(not party_degraded),
            runes=runes, inventory=inventory, stash=stash)
        rec_path = os.path.join(raw_dir, f"{rec['id']}.json")   # raw/<ts_ms>.json (id = ts em ms)
        if status == "success":
            # SUCCESS pende em vez de escrever JÁ: o boss box do clear (GetBoxLog mt=1/2)
            # chega ~0.6s depois, noutro crescimento da LOG_LIST — o loop o absorve no rec
            # pendente (_absorb_drop) e o flush sai na deadline/próximo close/re-attach/exit.
            # O record está COMPLETO (id = ts_ms de agora); só a escrita é adiada.
            pending = _new_pending(rec, rec_path, time.time())
        else:
            # fail/abandoned: boss box só segue clear → escreve na hora, como sempre.
            _write_atomic(rec_path, json.dumps(rec, ensure_ascii=False))
        # Self-heal: SUCCESS com dano mas o gold veio do SAVE (o vivo não leu) = o klass ficou
        # stale (ex.: jogo trocou de save/instância) -> re-resolve o AggregateManager p/ a próxima.
        # MESMO gatilho de sempre (success + ge_src=="save" + total_damage>0); só muda o COMO: §6
        # índice primário (~ms — num build calibrado não trava mais o loop ~90s) → value-scan fallback.
        # tbase/idx_ut lidos como free-vars (run()-locais; no re-attach o tbase é reatribuído ao novo
        # ga_base, então um self-heal pós-re-attach usa a tabela viva, não a morta — NEW-2).
        if status == "success" and ge_src == "save" and total_damage > 0:
            gk = None
            if tbase and idx_ut is not None:
                gk = resolve_combat_gold_klass_by_index(reader, tbase, idx_ut)
            gold_klass = gk or resolve_combat_gold_klass(reader, psd_list)
        run_num += 1   # contador local do console/log (não persiste; a identidade da run é o horário)
        R = new_run()

    try:
        while True:
            now = time.time()
            # GAME fechou/reiniciou? Ler o processo morto falha (rptr -> None). Sustentado
            # por ~5s => descarta a run interrompida, espera o jogo voltar, re-anexa e re-resolve.
            if reader.rptr(lm + LogManager.LOG_LIST) is None:
                dead_reads += 1
            else:
                dead_reads = 0
            if dead_reads >= int(hz * 5):
                print("\n[game closed/restarted] reads failing — discarding run, re-attaching...")
                # O pendente é uma run COMPLETA (success já fechado) — flush ANTES de descartar
                # a run interrompida: o jogo fechar 2s após um clear não pode sumir com o record
                # (sem o pending-close ele já estaria em disco). Normalmente a deadline (3s) já
                # flushou antes destes 5s de reads mortos; isto é o cinto-e-suspensório.
                flush_pending()
                close(handle)
                while True:
                    npid = find_pid()
                    if npid:
                        handle = open_process(npid)
                        if handle:
                            reader = Reader(handle)
                            print(f"[re-attaching] game came back (pid {npid}), re-resolving (~1-2min)...")
                            # O restart pode ter sido um update do jogo -> re-lê versão + recomputa
                            # o fp ANTES de resolver (o restart muda o ga_base por ASLR — o anchor_rva
                            # do calib é build-estável e relido vivo; o fp só muda se o build mudou).
                            gv = _detect_game_version(handle)
                            game_version = gv or GAME_VERSION
                            ga_base_r, _ = typeinfo.ga_module(npid)
                            fp = typeinfo.build_fingerprint(reader, ga_base_r, gv) if ga_base_r else None
                            # infra-log: um UPDATE do jogo aparece aqui como fp DIFERENTE do startup
                            # → seed-miss → cold scan (o resolve_all abaixo loga o path). Visível na hora.
                            diag(f"[reattach] pid={npid} version={game_version} fp={fp} "
                                 f"ga_base={hex(ga_base_r) if ga_base_r else None}")
                            try:
                                # calib é fp-keyed e já persistido pelo scan inicial → NÃO re-salvar
                                # aqui (sem save_cache legado: o gate cuida do persist no slow path).
                                rr = resolve_all(reader, npid, fp, cache_path)
                            except Exception:
                                rr = None
                            if rr and rr[0] and rr[1] and rr[2] and rr[3]:
                                (sc_class, sf_class, msm, lm, csd_list, psd_list,
                                 stage_info, item_cat, hero_cat, sm_list, gold_klass, gb_class,
                                 die_class, res_class) = rr
                                csd = save.pick_live_csd(reader, csd_list)
                                sm = save.pick_live_sm(reader, sm_list)
                                _smd = build.describe_sm_candidates(reader, sm_list, sm)
                                diag(f"[party-pick] re-attach candidates={_smd['total']} "
                                     f"hk-accept={_smd['hk_accept']} carriers={_smd['carriers']} "
                                     f"picked={hex(_smd['picked']) if _smd['picked'] else None}")
                                # gold_klass já veio de resolve_all (rr) acima
                                # NEW-2: o re-attach mudou o ga_base (ASLR) → o tbase velho está MORTO.
                                # Recomputa o tbase run()-local pelo anchor_rva (build-estável) sobre o
                                # ga_base_r NOVO, p/ que os self-heals seguintes leiam a TypeInfoTable
                                # viva (senão o gold cairia no value-scan ~90s toda run). idx_ut é
                                # constante do build (mesmo fp) → inalterado no re-attach.
                                _cr = load_calib(cache_path, fp) if fp else None
                                if _cr and ga_base_r:
                                    tbase = typeinfo.table_base(reader, ga_base_r, _cr["anchor_rva"])
                                    idx_ut = _cr["idx_ut"]
                                else:
                                    tbase = idx_ut = None
                                R = new_run()
                                _ll = reader.rptr(lm + LogManager.LOG_LIST)
                                last_size = (reader.ri32(_ll + List.SIZE) or 0) if _ll else 0
                                last_alive = 0
                                prev_dead = None
                                cur_key = reader.ri32(csd + CommonSaveData.CURRENT_STAGE_KEY) if csd else None
                                dead_reads = 0
                                print(f"[ok] re-attached (game version {game_version}"
                                      + ("" if gv else " (fallback — Version.txt unreadable)") + "). "
                                      "Interrupted run discarded; measuring again.\n")
                                break
                            close(handle)
                    time.sleep(3)
                continue
            # DPS orquestrado: lê os mobs em LOTE (game.models.live_monsters via Reader) e
            # delega ao metrics.dps.DpsTracker — dano = Σ queda de HP + golpe final, janela
            # de 5s e total mora no tracker (reset por run via new_run). Aqui só o que é do
            # meter: contagem de kills (queda do nº de vivos) e o DPS suavizado p/ a tela.
            dps_t = R["dps"]
            dps_t.update(read_live_monsters(reader, msm), now)
            alive = dps_t.alive
            if alive < last_alive:
                R["mobs"] += (last_alive - alive)
            last_alive = alive
            dps_live = dps_t.dps(now)

            if now - last_refresh >= REFRESH:
                c = save.pick_live_csd(reader, csd_list)
                if c:
                    csd = c
                last_refresh = now

            # stageKey VIVO: prefere o do MONSTRO (bceo) — o do save congela na troca.
            # Sem monstros (entre stages/waves), mantém o último conhecido.
            live_sk = read_live_stage_key(reader, msm)
            if live_sk:
                cur_key = live_sk
            elif cur_key is None and csd:
                cur_key = reader.ri32(csd + CommonSaveData.CURRENT_STAGE_KEY)
            _si = stage_info.get(cur_key)
            # +1 = o boss (StageInfoData conta só os mobs de horda; matamos tb o boss)
            total_mobs = (_si[2] + 1) if _si else None
            stage_lbl = f"{_si[0]}-{_si[1]}" if _si else "?"
            mode_txt = DIFF_NAMES.get(_si[3], "?") if _si else "?"

            # RESTART manual do MESMO stage: DeadMonsterUnit é cumulativo e CAI quando o
            # stage recarrega no restart manual. Clear/auto-replay NÃO zeram (logam à parte).
            dead_now = reader.ri32((reader.rptr(msm + MonsterSpawnManager.DEAD_MONSTER_LIST) or 0) + List.SIZE)
            reloaded = (prev_dead is not None and dead_now is not None and dead_now < prev_dead - 2)
            if dead_now is not None:
                prev_dead = dead_now

            # fechamento por LOG: StageClearLog (sucesso) ou StageFailedLog (falha)
            closed = False
            loglist = reader.rptr(lm + LogManager.LOG_LIST)
            size = reader.ri32(loglist + List.SIZE) if loglist else None
            if size is not None and size != last_size:
                if size > last_size:
                    items = reader.rptr(loglist + List.ITEMS)
                    for i in range(last_size, min(size, last_size + 300)):
                        e = reader.rptr(items + Array.DATA + i * 8) if items else None
                        if not e:
                            continue
                        kl = reader.rptr(e)
                        if kl == sc_class:
                            close_run("success", cur_key, e); closed = True
                        elif kl == sf_class:
                            close_run("fail", cur_key, e); closed = True
                        elif gb_class and kl == gb_class:
                            # GetBoxLog @0x40 é o TIPO ("TreasureChest_<Type>"), NÃO item key
                            # (cravado ao vivo). O tier autoritativo é monster_type @0x50; a
                            # variante exata da box não vem no evento → mapeia o tier -> box key
                            # canônica (BOX_KEY_BY_TIER). O int(bk_str) antigo engolia TODO drop.
                            # ROTEAMENTO: baú de BOSS (mt 1/2) chega ~0.6s DEPOIS do clear (até
                            # no MESMO batch de entries: o close de cima já trocou R) → pertence
                            # ao success PENDENTE, não à run nova. Mob (mt=0) → run atual. Sem
                            # pendente (anexou logo após um clear) → run atual + WARN; um baú
                            # real nunca é descartado. Ver docs/invariants/run-lifecycle.
                            mt = reader.ri32(e + GetBoxLog.MONSTER_TYPE)
                            box_key = BOX_KEY_BY_TIER.get(mt)
                            if box_key is not None:
                                drop = {"box_key": box_key, "monster_type": mt}
                                if (_box_belongs_to_pending(mt, pending is not None)
                                        and _absorb_drop(pending["rec"], drop)):
                                    pending["absorbed"].append(drop)
                                    print(f"\n[box] boss box (mt={mt}) absorbed into closed "
                                          f"run {pending['rec'].get('id')}")
                                else:
                                    if mt in TRAILING_BOX_TIERS:
                                        # Dois motivos DISTINTOS no log (a triage do meter.log
                                        # não pode mentir): sem pendente (ex.: anexou logo após
                                        # um clear) vs absorb recusado (rec pendente fora da
                                        # forma — inalcançável por construção hoje).
                                        why = ("absorb refused (malformed pending rec)"
                                               if pending is not None else "no pending close")
                                        print(f"\n[box] WARN boss box (mt={mt}) — {why}; "
                                              "credited to current run")
                                    R["drops"].append(drop)
                        elif die_class and kl == die_class:
                            # HeroDie: @0x48 = herói morto, @0x40 = monstro que matou (LIVE-CRACKED).
                            victim = _suffix_int(reader.read_string(reader.rptr(e + HeroDieLog.VICTIM_HERO)))
                            killer = _suffix_int(reader.read_string(reader.rptr(e + HeroDieLog.KILLER_MONSTER)))
                            if victim is not None:
                                R["deaths"][victim] = R["deaths"].get(victim, 0) + 1
                                if killer is not None:
                                    R["killers"].setdefault(victim, []).append(killer)
                        elif res_class and kl == res_class:
                            # Resurrection: @0x40 = herói revivido. Auto-revive (~115s) ou skill da Priest.
                            rev = _suffix_int(reader.read_string(reader.rptr(e + ResurrectionLog.HERO)))
                            if rev is not None:
                                R["revives"][rev] = R["revives"].get(rev, 0) + 1
                last_size = size

            # Pending-close venceu (GRACE expirou sem mais boss box) → flush e limpa. DEPOIS
            # da varredura da LOG_LIST de propósito: um boss box que aflora no MESMO tick em
            # que a deadline expira ainda é absorvido (janela efetiva = GRACE + ≤1 tick,
            # inofensivo); no topo do tick ele cairia no fallback com WARN. A ordem em disco
            # não muda (close_run segue se auto-flushando no topo). A contagem do live cai
            # de volta no próximo snapshot (baseline no app, sem evento).
            if pending is not None and now >= pending["deadline"]:
                flush_pending()

            # adota a stage durante a graça inicial (lida com auto-replay/avanço pós-clear)
            if cur_key is not None and cur_key in stage_info and (
                    R["stage_key"] is None or now < R["adopt_until"]):
                R["stage_key"] = cur_key
            # FIM por RESTART/troca sem clear/falha: dead caiu (reload do mesmo stage) OU
            # bceo mudou (troca de stage). Passada a graça, abandona a parcial e recomeça.
            if not closed and now >= R["adopt_until"] and R["stage_key"] is not None:
                switched = (cur_key is not None and cur_key in stage_info
                            and cur_key != R["stage_key"])
                if reloaded or switched:
                    close_run("abandoned", R["stage_key"])

            elapsed = int(now - R["start"])
            mtxt = f"{R['mobs']}/{total_mobs}" if total_mobs else str(R["mobs"])
            # Per-tick live line (~hz/s). The app's overlay reads live.json (written
            # just below), NOT this stdout stream, and the reader runs hidden — so by
            # default this would only bloat meter.log. Emit it ONLY under --debug; that
            # keeps meter.log an event-level log (attach / resolve / run-close / errors).
            if debug:
                sys.stdout.write(
                    f"\rrun #{run_num}  Stage {stage_lbl} [{mode_txt}]  mobs {mtxt}  "
                    f"DAMAGE {fmt(dps_t.total_damage)}  DPS {fmt(dps_live)}/s  [{elapsed}s]   ")
                sys.stdout.flush()
            if now - last_snap >= 1.0:
                # "Nova sessão" é app-side agora (Redesign 2): o app grava um corte em session-cuts.json
                # e DERIVA a session das runs — o reader não rotaciona nada (era consume_session_reset).
                # Gold/XP/party VIVOS por-run (1x/s): o app mostra no overlay. Linha omitida
                # (None/vazia) -> some no app (degrada limpo num reader sem isso). A party viva
                # é lida UMA vez aqui e reusada p/ xp + frame. Build segue só no close.
                if not sm:  # achado preguiçosamente quando o jogador entra numa stage
                    sm = save.pick_live_sm(reader, sm_list)
                pl_end = build.read_live_party(reader, sm)   # never-raises -> {} em falha
                R["party_seen"].update(dict.fromkeys(pl_end))
                # Acumulador VIVO de xp (o MESMO objeto que fecha a run no close_run): integra o
                # tick por-herói — 1º avistamento semeia baseline; depois soma incrementos > 0
                # (level-up pela curva). Morto/ausente não anda (acumulado fica banked).
                R["xp_acc"].update(pl_end)
                # 64 stats FINAIS vivos por herói (mesma leitura do close). Aditivo no live.json:
                # alimenta o tooltip de resistência efetiva por herói no overlay. never-raises -> {}.
                live_stats = build.read_live_stats_by_hero(reader, sm)
                # Live preferido; cai no SAVE quando o vivo não resolve (ex.: StageManager NOT
                # found -> sem party/xp vivos) — o MESMO dado que o run record usa, pra o overlay
                # não ficar vazio. Best-effort: qualquer falha de leitura só omite a linha.
                psd = save.pick_live_psd(reader, psd_list)
                # Mesma fonte EXATA do fechamento (gold.py): cumulativo vivo - baseline do início.
                g_gain = run_gain(R.get("gold_live_start"), combat_gold_live(reader, gold_klass))
                if g_gain is None:
                    try:
                        g_gain = run_gain(R.get("gold_save_start"), combat_gold_save(reader, psd))
                    except Exception:
                        g_gain = None
                # xp vivo do overlay = o total do acumulador (inclui o banked de quem morreu e o
                # de quem entrou tarde — o overlay não "perde" xp quando um herói morre). None =
                # nenhum herói visto vivo ainda -> cai pro SAVE abaixo (nunca conflar com 0).
                x_gain = R["xp_acc"].total()
                if x_gain is None:
                    try:
                        heroes_now = save.read_heroes(reader, psd)
                        # Herói no CAP: delta do save é fantasma (HeroExp nunca reseta) -> 0.0,
                        # a MESMA regra do xp_by_hero do close_run (paridade overlay/record).
                        x_gain = (sum(0.0 if xp.level_capped(v[0])
                                      else max(0.0, v[1] - R["heroes_start"].get(k, 0.0))
                                      for k, v in heroes_now.items()) if heroes_now else None)
                    except Exception:
                        x_gain = None
                # Party keys: quem ENTROU na run (start) + quem foi VISTO deployado depois
                # (party_seen; morto não some do frame) — NUNCA o roster do save (mostraria
                # heróis não-deployados). Vazio -> linha omitida -> frame some no app.
                pl0 = R.get("party_live_start") or {}
                party_keys = list(pl0) + [k for k in R["party_seen"] if k not in pl0]
                # Loot ao vivo: contagem de baús por EMonsterLogType (índice = valor do enum) —
                # run ATUAL + os absorvidos pelo pending-close (o boss box atrasado SOBE a
                # contagem enquanto o stage_key vivo ainda é o do clear; é esse rising-edge que
                # o cooldown-tracker/drop-notifier do app detectam — ver _drop_counts).
                dc = _drop_counts(R["drops"], pending["absorbed"] if pending else None)
                # Snapshot CRU (sem cozinhar): act/stageNo/difficulty vão crus (o app formata "3-9" e
                # o nome do mode), damage_now/elapsed crus (o app deriva o dps com o MESMO computeDps do
                # record). gold/xp/party/drops como já lidos; None some no overlay. Escrita ATÔMICA
                # (tmp+rename): o app pode ler o live.json a qualquer momento → nunca um meio-arquivo.
                _si_live = stage_info.get(cur_key)
                live_rec = build_live_record(
                    run=run_num,
                    stage_key=cur_key,
                    act=_si_live[0] if _si_live else None,
                    stage_no=_si_live[1] if _si_live else None,
                    difficulty=_si_live[3] if _si_live else None,
                    mobs=R["mobs"], total_mobs=total_mobs,
                    damage_now=dps_t.total_damage, elapsed=elapsed,
                    gold_now=g_gain, xp_now=x_gain,
                    party=party_keys, drops=[dc[0], dc[1], dc[2]],
                    party_stats=live_stats)
                _write_atomic(live_path, json.dumps(live_rec))
                last_snap = now
            time.sleep(interval)
    except KeyboardInterrupt:
        print(f"\n\n[done] runs in {raw_dir}. cheers!")
    finally:
        # Um clear nos últimos GRACE segundos antes do Ctrl+C/exceção não pode sumir: o
        # pendente é uma run completa — flush antes de soltar o handle.
        flush_pending()
        close(handle)


DEFAULT_OUTPUT = os.path.join(os.path.expanduser("~"), "tbh-meter")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--hz", type=float, default=10.0)
    # Pasta de saída de TUDO (raw/<ts_ms>.json, live.json, meter.log,
    # resolve_cache.json). Default = ~/tbh-meter (a pasta que o app já lê).
    ap.add_argument("--output", default=DEFAULT_OUTPUT,
                    help="output directory (default: ~/tbh-meter)")
    ap.add_argument("--selftest", action="store_true",
                    help="load bundled resources (config/level_curve.json, skill_attr_map.json) "
                         "and exit; CI uses this to catch a broken PyInstaller --add-data/_MEIPASS")
    ap.add_argument("--debug", action="store_true",
                    help="print the per-tick live meter line to stdout (legacy terminal "
                         "view). Off by default: the app reads live.json and the "
                         "reader runs hidden, so this is only useful when you run the "
                         "reader in a terminal yourself to debug.")
    args = ap.parse_args()
    if args.selftest:
        # Force the frozen-resource path: xp.curve()/build.skill_attr_map() load their
        # bundled config JSON via shared.utils.resource_path. A broken --add-data /
        # sys._MEIPASS fails HERE (nonzero exit, at CI build time) instead of silently
        # at runtime (a level-up / a run close).
        try:
            levels = len(xp.curve())
            skills = len(build.skill_attr_map())
        except Exception as e:
            print(f"selftest FAILED: {e}")
            raise SystemExit(1) from e
        if not skills:
            print("selftest FAILED: skill_attr_map loaded 0 entries (missing/empty bundle)")
            raise SystemExit(1)
        # SEED de calibração (seed-calib): OPCIONAL. Se EMBARCADO, valida o shape (fmt + bloco
        # calib não-vazio) p/ um seed corrompido/truncado FALHAR aqui no CI, não em runtime. Se
        # AUSENTE, passa com log — "sem seed ainda" é estado válido e releasável (build novo antes
        # da captura via scripts/dump_calib_seed.py). O --add-data + arquivo commitado garantem que,
        # quando deve existir, existe (PyInstaller falha o build se o --add-data aponta p/ sumido).
        seed_fps = None
        try:
            _sd = json.load(open(_seed_path(), encoding="utf-8"))
            if _sd.get("fmt") != CACHE_FMT or not _sd.get("calib"):
                print(f"selftest FAILED: calib_seed.json bundled but malformed "
                      f"(fmt={_sd.get('fmt')}, calib empty?)")
                raise SystemExit(1)
            seed_fps = list(_sd["calib"].keys())
            # Cada fp do seed tem que passar o MESMO gate de load do runtime (_read_calib,
            # incl. _stage_info_ok): um seed que o runtime rejeitaria silenciosamente
            # (→ cold scan em todo 1º launch) falha AQUI, no CI.
            _bad = [f for f in seed_fps if _read_calib(_seed_path(), f) is None]
            if _bad:
                print(f"selftest FAILED: calib_seed.json fp(s) rejected by load "
                      f"validation: {_bad}")
                raise SystemExit(1)
        except FileNotFoundError:
            pass
        except SystemExit:
            raise
        except Exception as e:
            print(f"selftest FAILED: calib_seed.json unreadable: {e}")
            raise SystemExit(1) from e
        seed_msg = f", calib_seed [{', '.join(seed_fps)}]" if seed_fps else ", calib_seed (none — ok)"
        print(f"selftest OK: level_curve ({levels} levels), skill_attr_map ({skills} skills){seed_msg}")
        return
    output_dir = args.output
    try:
        os.makedirs(output_dir, exist_ok=True)
    except Exception:
        pass
    # Instância única: só UM reader pode rodar. Dois processos anexam ao mesmo jogo e
    # duplicam os records raw/<id>.json (run duplicada + gold 2× do fallback save sob
    # contenção). O mutex é liberado pelo SO no fim do processo — sem stale-lock. Ver single_instance.py.
    if not acquire_single_instance():
        print("[exit] another tbh-reader is already running — not starting a second one.")
        return
    # espelha stdout/stderr em <output>/meter.log (pro Claude monitorar de fora, ex.: o share)
    tee_stdio(os.path.join(output_dir, "meter.log"))
    # log de infra SEPARADO (reader-diag.log): interno da resolução + seleção de instância — os
    # dados que faltaram em debugs como o party-off do 1.00.13 (ver shared/utils.diag).
    init_diag_log(os.path.join(output_dir, "reader-diag.log"))
    try:
        run(args.hz, output_dir, args.debug)
    except Exception as e:
        traceback.print_exc()
        diag(f"[fatal] run() raised: {type(e).__name__}: {e}")


if __name__ == "__main__":
    main()
