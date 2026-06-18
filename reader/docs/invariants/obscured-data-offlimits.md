---
type: invariant
description: "Dados Obscured (XOR) são PERMANENTEMENTE proibidos de ler — dão lixo: Unit core stats (ObscuredFloat) e Monster.cache. Use os campos PLAIN. E identidade de classe de herói é EEquipClassType, NUNCA o enum órfão EHeroType (mapeamento diferente → rotula Knight como Ranger)."
symptoms:
  - "ObscuredFloat"
  - "ObscuredInt"
  - "stats por heroi runtime"
  - "per-hero stats runtime"
  - "ler 0x104"
  - "core stats lixo"
  - "EHeroType"
  - "classe de heroi errada"
  - "wrong hero class"
  - "Knight virou Ranger"
  - "Monster cache"
code_anchors:
  - config/offsets.py::Unit.CORE_STATS_OBSCURED
  - config/offsets.py::Monster.CACHE_OBSCURED
  - config/offsets.py::EEquipClassType
  - config/offsets.py::StatsHolder.FINAL_STATS
asserts:
  - config.offsets.Unit.CORE_STATS_OBSCURED == 0x104
  - config.offsets.Monster.CACHE_OBSCURED == 0x3B8
  - config.offsets.EEquipClassType.Knight == 1
  - config.offsets.EEquipClassType.Ranger == 2
guarded_by:
  - tests/test_obscured_markers.py::test_no_reader_module_reads_obscured_offsets
  - tests/test_obscured_markers.py::test_obscured_markers_exist
  - tests/test_offsets.py::TestEEquipClassType::test_knight_is_1
---

# Dados Obscured: o que NUNCA ler (+ enums órfãos)

Parte da memória do jogo é cifrada por XOR (`ACTk` Obscured: `ObscuredInt`/`ObscuredFloat`/
`ObscuredULong`). **Ler nesses offsets dá lixo** — o `hidden ^ key` não é o valor; o valor real
seria o `fakeValue` PLANO num outro campo, mas o mapeamento por-índice se perdeu, então o campo
Obscured é simplesmente **proibido de ler**. É uma classe de bug real (alguém vê o offset, lê,
e emite um número sem sentido). A regra dura: leia o equivalente **PLAIN**, nunca o Obscured.

## Off-limits e o substituto PLAIN

- **Unit core stats `@Unit.CORE_STATS_OBSCURED`** — os 12 stats core são **`ObscuredFloat`** (NÃO
  `ObscuredInt`, como a skill antiga dizia — o comentário em `config/offsets.py` é a verdade). Use
  **`StatsHolder.FINAL_STATS`** (`xd.FINAL_STATS`), um `Dict<StatType,float>` **PLANO** com os 64
  stats finais. (É um `DictFloat` — [[invariants/dict-strides]] manda a geometria.)
- **`Monster.CACHE_OBSCURED`** (`ud.tl`) — Obscured. Use os **campos PLAIN do `Monster`** (ex.:
  `Monster.STAGE_KEY` para o stageKey vivo). Nunca derefencie o cache cifrado.

Os dois offsets existem em `config/offsets.py` SÓ como **marcadores nomeados** ("NÃO LER"), pra
esta nota ancorar e pro teste guardar. Eles **não devem ser referenciados por nenhum módulo de
leitura** (`metrics/`, `game/`) — se um módulo cita `CORE_STATS_OBSCURED`/`CACHE_OBSCURED`, é
porque alguém vai ler ali, e o `guarded_by` falha de propósito.

## Enum órfão: identidade de classe de herói

A classe de um herói (Knight/Ranger/…) sai de **`EEquipClassType`**
(`All=0, Knight=1, Ranger=2, Sorcerer=3, Priest=4, Hunter=5, Slayer=6`) — é o enum que
`HeroInfoData.CLASS_TYPE` indexa e que `game/build.py` mapeia. **NUNCA** use `EHeroType`: é um
enum **órfão** com **mapeamento diferente**; o reader nem o define em `offsets.py`. Trocar um pelo
outro **rotula Knight como Ranger** (classe errada no app) sem nenhum erro — o valor "resolve",
só está semanticamente trocado. É o mesmo gênero de armadilha do Obscured: o número lido é
plausível mas sem sentido.

## Related
- [[invariants/offsets-single-source]] — por que os marcadores e o enum certo vivem em `config/offsets.py` (e a regra de negócio, não)
- [[invariants/memory-safety]] — a disciplina de leitura geral (read-only, deref guardado); ler Obscured é o caso "leu, mas é lixo"
- [[invariants/dict-strides]] — `FINAL_STATS` é um `DictFloat`; usar a geometria errada corromperia os stats que você foi buscar no lugar do Obscured
- [[reference/extraction-viability]] — Obscured aparece como a coluna "não extraível" da matriz de viabilidade
- [[reference/run-data-map]] — os campos PLAIN canônicos que o reader lê por run (os substitutos certos)
