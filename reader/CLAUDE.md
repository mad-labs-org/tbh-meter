# Reader — leia antes de mexer

Vai alterar **qualquer coisa em `tbh-meter/reader/`**? A base de conhecimento que evita os
bugs históricos (dict stride trocado, nome ofuscado, schema não bumpado, runs que não fecham,
ObscuredFloat, cache stale) vive em **`docs/_index.md`** — comece por lá (tem um bloco
"por sintoma/tarefa"), ache a nota pelo sintoma, e siga os `code_anchors` até o código (a verdade).

- O conhecimento é **drift-tested**: rode `pytest tests/` depois de qualquer mudança
  (`tests/test_docs_consistency.py` falha se uma nota mentir sobre o código).
- Antes de abrir um PR, **varra o diff contra `docs/reference/anti-patterns.md`** — o checklist
  de smells conhecidos, cada um ligado à nota-invariant que ele viola.
- Ao adicionar uma nota ou mudar uma regra: a verdade é o CÓDIGO. Offset/enum/stride →
  `config/offsets.py`; regra de negócio → o módulo da lógica. Nunca duplique o valor numa nota —
  cite o símbolo (`code_anchors` + `asserts`), pra o drift-test te guardar. Convenções: `docs/README.md`.
