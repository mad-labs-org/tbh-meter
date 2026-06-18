---
type: guide
description: "O jogo atualizou? Playbook pra reconsertar o reader: diagnosticar pelo fingerprint PE (patch de conteúdo vs recompile), confirmar que nada que o offsets.py rastreia deslocou (dump IL2CPP + diff), re-seedar pro novo build, bumpar GAME_VERSION e validar ao vivo. Na maioria dos updates o reader NÃO está quebrado — só perdeu o fast path; o conserto é re-seedar, não editar offsets."
symptoms:
  - "jogo atualizou"
  - "nova versão"
  - "game updated"
  - "new version"
  - "gold 0 depois de atualizar"
  - "stage ? depois de update"
  - "mode ? pós-update"
  - "GAME_VERSION"
  - "Version.txt"
  - "1.00.x"
  - "recompile"
  - "fingerprint mudou"
  - "re-seed"
  - "reseed"
code_anchors:
  - scripts/preflight_calib.py
  - scripts/diff_offsets_vs_dump.py
  - scripts/seed_calib_capture.py
  - scripts/validate_live.py
  - il2cpp/typeinfo.py::build_fingerprint
  - meter_windows.py::GAME_VERSION
  - meter_windows.py::CACHE_FMT
---

# Guia — atualização do jogo (re-seed + verificação de offsets)

Todo update do TBH rebuilda o `GameAssembly.dll` → o **fingerprint de build muda** → o seed
embarcado (`config/calib_seed.json`) dá **miss** → o cliente cai no **cold scan**, que é o caminho
frágil (catálogo + value-scan do gold dependem do estado/timing do jogo). Sintoma clássico no
jogador: **dano/dps/xp funcionam** (managers sempre na memória) mas **gold = 0** e **stage com modo
"?"**. Na esmagadora maioria das vezes **nada que o reader lê mudou de offset** — o conserto é
**re-seedar**, não mexer no `offsets.py`. Este guia diz como ter CERTEZA disso (e o que fazer no
caso raro em que algo deslocou).

## Três baldes (o que muda num update)

1. **Nunca muda** — formato PE/OS e a **ABI do IL2CPP/Unity** (`String`/`Array`/`List`/`Dict`/
   `Class`): só mudam num upgrade de **engine** (`UnityPlayer.dll`), não num patch do jogo.
2. **Auto-cura** — `fingerprint`, `anchor_rva`, `indices`, `idx_ut`, catálogos: mudam **todo**
   update, mas o scan redescobre e o re-seed recaptura. **Zero edição de código** — só re-seedar.
   Ver [[invariants/cache-management]] e [[invariants/rva-index-resolution]].
3. **Quebra silenciosa** — offsets de campo + enums em `config/offsets.py`: mudam **raramente**
   (só quando os devs add/reordenam campos/membros nessas classes), mas quando mudam o reader lê
   **lixo/vazio SEM erro**. É o único balde que precisa de olho — e o passo 3 abaixo é o tripwire.

## Checklist (na ordem)

1. **Fingerprint — recompile ou só conteúdo?** Leia o header PE do `GameAssembly.dll` novo
   (`TimeDateStamp` + `SizeOfImage`) com a mesma fórmula de `il2cpp/typeinfo.py::build_fingerprint`,
   e a versão instalada do `Version.txt` ao lado do `.exe`. Compare a parte nativa com a chave do
   seed commitado:
   - **Igual** → patch só de **conteúdo**: offsets/índices intactos por construção; só a string de
     versão mudou. Vá direto ao passo 4 (re-seed).
   - **Diferente** → **recompile** do nativo: offsets/índices PODEM ter deslocado. Faça o passo 2+3
     antes de confiar.
2. **Dump IL2CPP do build novo.** `global-metadata.dat` do TBH é desencriptado (magic `af1bb1fa`);
   rode o Il2CppDumper (via `dotnet`) sobre `GameAssembly.dll` + `global-metadata.dat` → `dump.cs`
   (com offsets de campo + `TypeDefIndex`). É leitura estática, não precisa do jogo rodando.
3. **Preflight estático — UM COMANDO** (ruff + pytest + o tripwire código↔jogo). Rode
   `scripts/preflight_calib.py --dump <out/dump.cs> --seed config/calib_seed.json`: ele roda o
   `ruff`, a suíte `pytest` (regressão — inclui o drift-test docs↔código e os offsets pinados do
   `PlayerSaveData`) e então o `scripts/diff_offsets_vs_dump.py` (que importa o `config/offsets.py`
   AO VIVO e confere cada offset+NOME de campo de classe nomeada, cada enum por VALOR, e os
   `TypeDefIndex`/`idx_ut` do seed), e no fim IMPRIME o comando do `validate_live.py` (a camada ao
   vivo do passo 6, que ele NÃO consegue rodar). **Passe sempre `--seed config/calib_seed.json`** —
   sem ele, drift de índice/`idx_ut` fica invisível até você re-seedar.
   - **Exit 0** → toda camada estática passou; nada que o reader rastreia deslocou. Pode seguir pro re-seed.
   - **Não-zero** → PARE. `✗` no diff = atualize o símbolo deslocado em `config/offsets.py` (a fonte
     única — [[invariants/offsets-single-source]]) a partir do `dump.cs` e rode de novo até zerar;
     falha de ruff/pytest = regressão de código. Dump ausente FALHA de propósito (não diffar = não
     saber — a armadilha do 1.00.12). **Olhe o dump por-classe do diff** p/ uma classe cujos offsets
     não mudaram mas cujos NOMES de campo deslocaram (o único caso silencioso residual).
   - Classes de **nome ofuscado** (drifta por build: `UnitHealthController`/`HeroRuntime`/
     `StatsHolder`/`AggregateManager`/`StatModifier`) saem como "não-verificáveis" — o diff não as
     acha por nome; quem as valida é o run ao vivo do passo 6.
   - (Quer só o tripwire? Rode `scripts/diff_offsets_vs_dump.py` direto; o preflight só embrulha
     ruff+pytest em volta dele pra um re-seed nunca pular a regressão.)
4. **Re-seede pro novo build.** Com o jogo **aberto e em combate** (ouro subindo — o value-scan do
   gold e os catálogos precisam disso), rode `scripts/seed_calib_capture.py`: força um scan completo,
   descobre `anchor_rva`/`indices`/`idx_ut`, captura os catálogos e grava um `calib_seed.json` FRESCO
   no `CACHE_FMT` atual, keyed pelo fingerprint novo. (Se um bump de `CACHE_FMT` é parte do trabalho,
   o re-seed é OBRIGATÓRIO no mesmo PR — ver [[invariants/cache-management]].)
5. **Bumpe o `meter_windows.py::GAME_VERSION`** (o fallback) pra a versão nova. É só fallback (a
   versão viva vem do `Version.txt`), mas mantém a fonte única honesta — é a ÚNICA definição
   ([[invariants/offsets-single-source]]).
6. **Valide ao vivo — GATE OBRIGATÓRIO, TODAS as métricas.** Rode `--selftest` (shape do seed:
   `fmt == CACHE_FMT` + calib não-vazio) e então, com o jogo EM COMBATE numa fase, rode
   **`scripts/validate_live.py`**: ele resolve pelo seed (igual ao 1º launch do RC) e exige **PASS
   em TODAS** — `calib/seed`, `gold`, `party-viva`, `xp-viva`, `stage`, `catálogos`. Exit != 0 = NÃO
   shipe. Isto cobre as classes OFUSCADAS que o diff do passo 3 NÃO vê (gold = `AggregateManager`;
   party+xp = `HeroRuntime`; stats = `StatsHolder`) — o ponto cego onde bugs passaram batidos.
   **NUNCA valide só o campo que você consertou** ([[process/live-validation-gate]]): no 1.00.11 o
   gold foi conferido e a party (do `HeroRuntime` ofuscado) saiu quebrada porque ninguém olhou o resto.
7. **Ship.** Commite o `calib_seed.json` novo + o bump; o seed vai embutido no `.exe` (`--add-data`),
   então o fix só chega nos players via release promovido — ver [[invariants/cache-management]].

## Related
- [[process/live-validation-gate]] — o GATE ao vivo obrigatório do passo 6 (todas as métricas, não só a consertada)
- [[invariants/party-live-resolution]] — a party viva/degradação honesta que o gate confirma
- [[invariants/cache-management]]
- [[invariants/rva-index-resolution]]
- [[invariants/gold-singleton-resolution]]
- [[invariants/offsets-single-source]]
- [[process/value-mapping-method]]
