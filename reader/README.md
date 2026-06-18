# tbh-meter — reader (Python · Windows)

Lê a memória do jogo **read-only** (ctypes puro, **sem pip**) e produz os dados de cada run.
É a **fonte de dados** do app (`../app`). Roda no Windows (onde o jogo está).

## Constraint inegociável
Só `ReadProcessMemory` (ctypes, sem pip). **NUNCA injetar** — evita o anti-cheat (ACTk) e o
risco de ban. Toda solução é só LEITURA.

## O que dá pra ler (validado ao vivo)
- **Dano + DPS do TIME** (o jogo não guarda dano por-herói; só o total via Σ queda de HP).
- Por run: stage, modo, mobs, tempo, **gold de COMBATE** (contador vivo, SubKey 1), **XP**.
- Por herói: classe, nível, **64 stats**, **itens + mods**, **skills (ids)**, **ganho de XP**.
- IDs em tudo (itemKey, statId, gradeId, …) — o front resolve os nomes via `data/*.json` do repo.

## Estrutura
```
meter_windows.py   o reader que roda HOJE (escreve output/runs.jsonl). EM PRODUÇÃO.
                   ORQUESTRADOR FINO: monta um Reader e chama os módulos isolados
                   (gold/xp/dano/build migrados; só o close_run monta o record inline).
agent_windows.py   agente de inspeção de memória (debug). Self-contained; dirigido por
                   comandos JSON em output/agent_cmd.json (resposta em agent_resp.json).

config/   offsets.py (a bíblia de offsets) + level_curve.json + skill_attr_map.json
          + passive_skill_keys.json + calib_seed.json (seed de calibração, build-keyed)
shared/   memory.py (process + scanner + Reader: lê a RAM) · gamewindow.py · single_instance.py
          · utils.py (formatação + janela de tempo + resource_path)
metrics/  1 arquivo por métrica: gold.py · xp.py · dps.py · events.py · progress.py
il2cpp/   resolver.py (scan de classes — FALLBACK) · typeinfo.py (RVA + TypeInfoTable:
          fast path name-free que mata o scan) · finder.py (nome curto + singleton nn<T>)
game/     save.py · models.py · catalog.py · build.py · enums.py (leitura de domínio)
display/  console.py (painel rich — legado/órfão; o meter NÃO usa)
docs/     run-data-map · damage-model · value-mapping-plan · startup-optimization-plan
          · refactor-roadmap · extraction-spec · extraction-findings
```

## Rodar / deploy
O meter agora **importa o pacote**, então o deploy é a **pasta `reader/` inteira** (não mais 1
arquivo solto), e roda de dentro dela:
```bash
python meter_windows.py        # no Windows, com o jogo aberto. Saídas em output/.
```
> ⚠️ Deployar só o `meter_windows.py` (jeito antigo) quebra — ele importa `shared/`, `metrics/`,
> `il2cpp/`, `game/`, `config/`.

## Estado do refactor (orquestrador + fonte única)
O meter É um **orquestrador fino**: monta um `shared.memory.Reader` (o "fogão") e chama
módulos isolados, 1 por métrica (o "chef"). Cada lógica vive **num lugar só**.

- **Gold: MIGRADO ✓** — `metrics/gold.py` é a fonte única; o meter só orquestra (sem gold inline).
  Provado ao vivo: `gold_gained` == ganho real da carteira (sem o 2× e sem ruído de venda/idle).
- **XP: MIGRADO ✓** — `metrics/xp.py` (curva/level-up) + `game.build.read_live_party` (exp viva) +
  `game.save.read_heroes` (fallback) são a fonte única; o meter só orquestra (Σ por-herói + fallback
  live→save). A curva mora em `config/level_curve.json` (não mais o dict inline).
- **Dano/DPS: MIGRADO ✓** — `metrics/dps.py` (`DpsTracker`) é a fonte única; o meter só orquestra
  (sem HP/janela inline). Mobs lidos em LOTE por `game.models.live_monsters` (Reader); o stageKey
  vivo via `game.models.live_stage_key`. Equivalência bit-a-bit com o monólito (total_damage, kills,
  série de DPS) conferida.
- **Build (ficha): MIGRADO ✓** — `game/build.py` (`read_build`: itens/mods/skills+passivas +
  64 stats id-only + xp/nível vivos) é a fonte única; o meter só orquestra. O que resta inline é
  o `close_run` montar o record final (heroes_out/xp por-herói) — a última gordura do orquestrador.
- **Resolução: RVA + seed-calib ✓** — `il2cpp/typeinfo.py` resolve classes por RVA + TypeInfoTable
  (name-free, fast path); o scan de `resolver.py` virou FALLBACK. `config/calib_seed.json` (build-keyed)
  pula o scan no 1º launch de um build shipado. Ver `docs/startup-optimization-plan.md`.

Reusáveis ficam no `shared/` (Reader de memória, finder de classes, util de formatação/tempo);
offsets ficam todos em `config/offsets.py`; regra de negócio (ex.: "combate = SubKey 1") fica
com a lógica da métrica, não no offsets.
```
