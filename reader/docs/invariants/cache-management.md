---
type: invariant
description: "CACHE_FMT bumpa quando a FORMA do bloco calib muda; todo bump EXIGE recapturar config/calib_seed.json (seed.fmt tem que == CACHE_FMT) — senão o --selftest da RC falha e o runtime rejeita o seed por fmt e cai no cold scan. Validação de VALOR do catálogo (stage_info via _stage_info_ok, nos gates de save E load) NÃO bumpa fmt — rejeita o calib e degrada pela escada (seed → scan), auto-curando cache envenenado (modo \"?\" persistente). Completude-vs-seed (_covers_seed_keys, também nos dois gates): catálogo com BURACO — sem alguma key que o seed do MESMO fp tem — nunca persiste nem sombreia o seed."
symptoms:
  - "cache stale"
  - "stale cache"
  - "calib_seed desatualizado"
  - "seed fmt mismatch"
  - "CACHE_FMT"
  - "calib_seed"
  - "cold scan"
  - "scan toda vez"
  - "scan every launch"
  - "fast path não ativa"
  - "fmt"
  - "selftest FAILED calib_seed"
  - "modo ? persistente"
  - "stage mode ? em toda run"
  - "catálogo envenenado"
  - "poisoned cache"
  - "diff -1 no stage_info"
  - "buraco no catálogo"
  - "stage sumiu do catálogo"
  - "stage ? só num stage específico"
  - "cache com menos stages que o seed"
code_anchors:
  - meter_windows.py::CACHE_FMT
  - meter_windows.py::_stage_info_ok
  - meter_windows.py::_covers_seed_keys
  - il2cpp/resolver.py::resolve_via_rva
  - config/calib_seed.json
asserts:
  - meter_windows.CACHE_FMT == 9
guarded_by:
  - tests/test_calib.py::TestTolerateOldJson::test_old_fmt_returns_none
  - tests/test_calib.py::TestSeedFallback::test_seed_fp_miss_returns_none
  - tests/test_calib.py::TestAtomicityAndMerge::test_written_file_has_current_fmt
  - tests/test_calib.py::TestPoisonedCatalogSelfHeal::test_poisoned_user_cache_falls_through_to_seed
  - tests/test_calib.py::TestPoisonedCatalogSelfHeal::test_holey_user_cache_healed_by_seed_same_load
  - tests/test_calib.py::TestSeedCoverageGateLoad::test_cache_missing_seed_stage_key_serves_seed
  - tests/test_calib.py::TestSeedCoverageGateLoad::test_cache_with_extra_keys_beyond_seed_served
  - tests/test_calib.py::TestSeedCoverageGatePersist::test_holey_stage_info_not_persisted_when_seed_covers_fp
  - tests/test_calib.py::TestSeedCoverageGatePersist::test_no_seed_for_fp_persists_as_today
  - tests/test_calib.py::TestPersistGate::test_invalid_diff_stage_info_not_persisted
  - tests/test_meter_windows.py::test_bundled_seed_passes_load_validation
---

# Gerenciamento de cache (CACHE_FMT + calib_seed)

O reader não guarda mais endereços absolutos. O único artefato persistido é o **bloco
`calib[fp]`** — um par `{anchor_rva, indices{nome:idx}, idx_ut, stage_info, item_cat, hero_cat}`
**build-estável**, gravado no `resolve_cache.json` do usuário (aprendido ao final de um scan, em
`save_calib`) e no **seed embarcado** `config/calib_seed.json` (capturado offline, commitado, e
incluído no `.exe` via `--add-data`). É isso que faz o PRIMEIRO launch num build shipado pular o
scan de ~70s (vira ~ms).

**A regra dura.** `CACHE_FMT` (a única definição viva mora em `meter_windows.py`) bumpa **sempre
que a FORMA do bloco calib muda** — uma chave nova, uma forma diferente de um catálogo, uma
semântica nova de um campo. A `9` atual, por exemplo, passou a incluir os stages ACTBOSS (x-10)
no `stage_info`; calibs gravados sob a forma anterior não têm essas keys, e como o fast path os
reusaria pra sempre, o bump força UM re-scan. **Mas bumpar `CACHE_FMT` SOZINHO é um meio-bump que
quebra o seed:** o `calib_seed.json` commitado ainda carrega o `fmt` velho, e em DUAS frentes:

1. **Build-time** — o `--selftest` (rodado na CI da RC) lê o seed e exige `seed.fmt == CACHE_FMT`;
   na divergência ele imprime `selftest FAILED: calib_seed.json bundled but malformed` e sai com
   código 1 → **a RC nem builda**.
2. **Runtime** — mesmo que passasse, `_read_calib` rejeita qualquer arquivo cujo `fmt` não bate
   com `CACHE_FMT` (devolve `None`), então `load_calib` ignora o seed defasado e o run() degrada
   pro scan garantido → **cold scan em TODA primeira inicialização do build** (exatamente a
   classe de bug "scan toda vez / cache stale").

**A receita ao bumpar `CACHE_FMT`:** rode o capturador (`scripts/seed_calib_capture.py` — zero-arg,
faz um scan vivo e carimba o `fmt` corrente) para **recapturar** `config/calib_seed.json` no novo
formato, e atualize esta nota + o `assert` (`meter_windows.CACHE_FMT == 9`). O share/`reader/` pode
estar num fmt antigo → sincronize o HEAD antes de capturar, ou o seed sai estampado errado.

**Por que isso é SEGURO mesmo se o seed estiver velho/de outro build.** O calib é
**build-keyed por fingerprint** (`fp` = versão + hashes do módulo, computado vivo no run()): um
seed que não cobre o `fp` corrente é um simples MISS (`load_calib → None` → scan), nunca
envenena. O **cache do usuário tem prioridade** sobre o seed (`load_calib` tenta o
`resolve_cache.json` primeiro, depois o seed embarcado) — prioridade CONDICIONADA à
completude-vs-seed: um cache cujos catálogos não cobrem toda key do seed do mesmo `fp` é
um catálogo com buraco e o seed é servido no lugar (ver a seção do buraco abaixo). E o
seed é **zero confiança nova**: o
fast path (`_resolve_fast` → `resolve_via_rva`) **revalida vivo a cada launch** — round-trip de
nome de classe (`class_name(K) == nome`) + sanidade de `size` da instância (e round-trip do
gold) — e degrada pro scan em QUALQUER mismatch. Por isso `_read_calib` carrega o bloco como
"dado bruto, validado pelo caller": não guarda nenhum endereço absoluto (o `anchor_rva` é
RELATIVO ao `ga_base`, que é relido por ASLR a cada start), então não há "endereço stale" a
revalidar — só round-trip semântico, sempre.

**Higiene de escrita.** `save_calib` só persiste com **persist-gate de completude** (os três
catálogos com `len > 0`, o `stage_info` com toda row VÁLIDA, e os catálogos cobrindo toda key
do seed do mesmo `fp` quando ele existe — ver as duas seções abaixo) — um scan rodado
FORA de stage gravaria catálogo vazio e o fast path o serviria degradado pra sempre nesse `fp`.
E grava **atomicamente** (`.tmp` + `fsync` + `os.replace`), então um kill no meio nunca deixa o
cache truncado/envenenado.

**Sanidade de VALOR do catálogo (sem bump de fmt).** Diferente do anchor/índices, os
**catálogos não têm round-trip vivo** no fast path — o que está no calib é servido como está.
Por isso o `stage_info` passa pelo gate `_stage_info_ok` (toda row no shape de 4 ints com
`diff` dentro do `EStageDifficulty`, as keys de `DIFF_NAMES`) em **dois pontos**: no
**persist** (`save_calib` recusa um catálogo com row suspeita — um misread do scan nunca vira
calibração) e no **load** (`_read_calib` rejeita o bloco → `load_calib` cai pro seed → scan).
O caso real: o `_read_catalogs` antigo catalogava linha de horda com `DIFFICULTY` ilegível
como diff `-1` → `DIFF_NAMES.get(-1)` = modo `"?"` em TODA run, persistido no
`resolve_cache.json` e sobrevivendo a restarts. O load-gate **auto-cura** esse cache: o bloco
envenenado é rejeitado, o seed (ou o scan, que re-calibra e sobrescreve o `calib[fp]`) serve o
catálogo são — sem o usuário deletar nada. Isso é validação de VALOR, não mudança de FORMA:
**não** bumpa `CACHE_FMT` (e o `--selftest` roda cada fp do seed pelo mesmo `_read_calib`, pra
um seed que o runtime rejeitaria falhar no CI, não em produção).

**Catálogo com BURACO nunca sombreia o seed (completude-vs-seed, sem bump de fmt).** O gate
de linha do `_read_catalogs` DROPA a linha misread em vez de catalogá-la com lixo — o que
troca o veneno por um **buraco**: um catálogo a que falta um stage passa em TODOS os gates de
VALOR (`_stage_info_ok` não sabe quais keys deveriam existir) e, servido/persistido, vira
"stage sumiu do catálogo" — modo `"?"` só num stage específico + adoção/troca de stage cegas
no loop pra esse stage — persistido no `calib[fp]` e **sombreando o seed bom PRA SEMPRE**
(nada re-dispara scan; antes deste gate, só deletar o cache na mão curava). A regra:
**catálogos são CONSTANTES do build** — pro MESMO `fp`, o seed shipado (validado ao vivo na
captura) é ground truth de QUAIS keys existem, então um cache com menos stages que o seed é
provadamente pior. O gate `_covers_seed_keys` exige que o candidato cubra TODA key de cada
catálogo do seed do mesmo `fp`, nos MESMOS dois pontos do gate de valor: no **persist**
(`save_calib` recusa o catálogo com buraco; o seed segue servindo nos próximos launches) e no
**load** (`load_calib` serve o SEED no lugar do cache com buraco, com log `[calib] user cache
... missing seed keys: stage_info=N ...` nomeando cada catálogo com buraco — triagem remota
via meter.log). **SÓ PRESENÇA de key, nunca comparação de valor**: key
extra local sempre passa e o valor local vence quando presente (protege contra um seed
hipoteticamente stale sob o mesmo fp); sem seed cobrindo o `fp` não há referência → tudo se
comporta como antes. Custo aceito: `load_calib` parseia o seed mesmo em cache-hit (~ms).

## Related
- [[invariants/rva-index-resolution]] — o fast path que consome os índices da calib; o seed só acelera, nunca é confiado sem o round-trip vivo.
- [[invariants/gold-singleton-resolution]] — o `idx_ut` da calib alimenta o fast path do gold.
- [[invariants/metric-fallback-chains]] — calib→scan é a cadeia de fallback da resolução.
