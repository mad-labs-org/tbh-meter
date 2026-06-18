"""
test_docs_consistency.py — o GUARD anti-drift da base de conhecimento (docs/).

A base do reader é um skill-graph: um índice (docs/_index.md) → notas pequenas
(docs/<tipo>/*.md) → o código (a verdade executável). Uma nota só vale se continuar
VERDADEIRA conforme o reader muda a cada PR. Este teste é o que impede a base de
apodrecer em silêncio (o caso `ficha.py`→`build.py`: o módulo foi renomeado e 5 docs
ficaram mentindo). Mas existência de símbolo NÃO basta — o pior drift é o texto que
ficou falso com o símbolo intacto. Então aqui validamos VALOR e COMPORTAMENTO, não só
"o símbolo existe":

  • frontmatter válido (type na taxonomia, description, campos obrigatórios por tipo)
  • code_anchors RESOLVEM por AST (Classe.attr / def / class), não por substring
    (substring daria falso-verde num comentário)
  • `asserts:` ("modulo.SIMBOLO == valor") batem com o literal real no código
  • `guarded_by:` nomeia um teste de comportamento que EXISTE e é coletável
  • `symptoms:` não-vazio nos invariants (a recuperação é lexical → o sintoma que o
    agent grepa tem que estar escrito)
  • PROIBIDO número-de-linha (arquivo.py:NN) no corpo — eles rotam; use code_anchors
  • PROIBIDO @0x cru em notas `reference` — cite o SÍMBOLO de offsets.py, não o literal
  • wikilinks em forma de caminho ([[invariants/foo]]) resolvem (dangling no namespace = falha)
  • _index lista toda nota e todo link do _index resolve (bidirecional)
  • SCHEMA_VERSION/GAME_VERSION definidos em UM só módulo (sem segunda-fonte contraditória)

Notas `archive/` são SNAPSHOTS: isentas dos checks de código (só frontmatter), porque
descrevem um estado passado. Só-stdlib + pytest (roda no Mac, não toca a memória do jogo).
"""
import ast
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent          # tbh-meter/reader/
DOCS = ROOT / "docs"
REPO = ROOT.parent                                       # tbh-meter/  (app/ é irmão de reader/)
NOTE_DIRS = ("invariants", "reference", "guides", "process", "archive")

VALID_TYPES = {"invariant", "reference", "guide", "process", "archive"}
REQUIRED = {
    "invariant": ("description", "code_anchors", "symptoms"),
    "reference": ("description", "code_anchors"),
    "guide":     ("description",),
    "process":   ("description",),
    "archive":   ("description", "status"),
}
MIN_DESC = 20
LINE_REF_RE = re.compile(r"\b[\w/]+\.(?:py|ts|cs|h):\d")   # meter_windows.py:530, app/x.ts:12
MD_LINE_REF_RE = re.compile(r"\.md:\d")
RAW_OFFSET_RE = re.compile(r"@0x[0-9A-Fa-f]")
WIKILINK_RE = re.compile(r"\[\[([^\]|]+)(?:\|[^\]]+)?\]\]")
ASSERT_RE = re.compile(r"^(.+?)==(.+)$")
HTML_COMMENT_RE = re.compile(r"<!--.*?-->", re.DOTALL)
_MISSING = object()


def strip_comments(text):
    """Conteúdo em <!-- --> é scaffolding não-renderizado (ex.: exemplos num template);
    os checks de corpo só valem para o conteúdo vivo."""
    return HTML_COMMENT_RE.sub("", text)


# --------------------------------------------------------------------------- #
# Parsing de notas (frontmatter YAML simples: escalares + listas)
# --------------------------------------------------------------------------- #
def parse_note(path):
    text = path.read_text(encoding="utf-8")
    m = re.match(r"^---\n(.*?)\n---\n?(.*)", text, re.DOTALL)
    if not m:
        return None, text
    fm_text, body = m.group(1), m.group(2)
    fm, key = {}, None
    for line in fm_text.split("\n"):
        li = re.match(r"^\s*-\s+(.+)$", line)
        if li and key is not None:
            fm.setdefault(key, [])
            if isinstance(fm[key], list):
                fm[key].append(li.group(1).strip().strip('"').strip("'"))
            continue
        kv = re.match(r"^([\w][\w_-]*)\s*:\s*(.*)$", line)
        if kv:
            key, val = kv.group(1), kv.group(2).strip()
            if val == "":
                fm[key] = []
            elif val.startswith("[") and val.endswith("]"):
                fm[key] = [v.strip().strip('"').strip("'")
                           for v in val[1:-1].split(",") if v.strip()]
            else:
                fm[key] = val.strip('"').strip("'")
    return fm, body


def live_notes():
    """(path, fm, body) de toda nota nos subdiretórios de tipo. _index/README ficam fora."""
    out = []
    for d in NOTE_DIRS:
        for p in sorted((DOCS / d).rglob("*.md")):
            fm, body = parse_note(p)
            out.append((p, fm, body))
    return out


def as_list(v):
    if v is None:
        return []
    return v if isinstance(v, list) else [v]


# --------------------------------------------------------------------------- #
# Resolução por AST (código = verdade)
# --------------------------------------------------------------------------- #
def _module_file(modpath):
    return ROOT / Path(*modpath.split(".")).with_suffix(".py")


def _anchor_target(anchor):
    """'meter_windows.py::_pick' -> (Path, 'reader'|'app', symbol|None)."""
    filerel, _, sym = anchor.partition("::")
    filerel, sym = filerel.strip(), (sym.strip() or None)
    if filerel.startswith("app/"):
        return REPO / filerel, "app", sym
    return ROOT / filerel, "reader", sym


def _tree(path):
    return ast.parse(path.read_text(encoding="utf-8"))


def _defines(tree, symbol):
    """symbol = 'Name' (def/class/assign em qualquer nível, inclui closures) ou 'Classe.attr'."""
    if "." in symbol:
        cls, attr = symbol.split(".", 1)
        for node in ast.walk(tree):
            if isinstance(node, ast.ClassDef) and node.name == cls:
                for sub in node.body:
                    if isinstance(sub, ast.FunctionDef) and sub.name == attr:
                        return True
                    targets = (sub.targets if isinstance(sub, ast.Assign)
                               else [sub.target] if isinstance(sub, ast.AnnAssign) else [])
                    if any(isinstance(t, ast.Name) and t.id == attr for t in targets):
                        return True
        return False
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and node.name == symbol:
            return True
        if isinstance(node, ast.Assign) and any(
                isinstance(t, ast.Name) and t.id == symbol for t in node.targets):
            return True
    return False


def _literal(modpath_symbol):
    """Valor literal de 'modulo.SIMBOLO' ou 'modulo.Classe.ATTR' via AST. _MISSING se não achar."""
    parts = modpath_symbol.split(".")
    for i in range(len(parts) - 1, 0, -1):
        f = _module_file(".".join(parts[:i]))
        if f.exists():
            symbol = ".".join(parts[i:])
            tree = _tree(f)
            if "." in symbol:
                cls, attr = symbol.split(".", 1)
                for node in ast.walk(tree):
                    if isinstance(node, ast.ClassDef) and node.name == cls:
                        for sub in node.body:
                            if isinstance(sub, ast.Assign) and any(
                                    isinstance(t, ast.Name) and t.id == attr for t in sub.targets):
                                try:
                                    return ast.literal_eval(sub.value)
                                except Exception:
                                    return _MISSING
            else:
                for node in tree.body:
                    if isinstance(node, ast.Assign) and any(
                            isinstance(t, ast.Name) and t.id == symbol for t in node.targets):
                        try:
                            return ast.literal_eval(node.value)
                        except Exception:
                            return _MISSING
            return _MISSING
    return _MISSING


def _parse_rhs(s):
    s = s.strip()
    try:
        return int(s, 0)
    except ValueError:
        pass
    try:
        return ast.literal_eval(s)
    except Exception:
        return s.strip('"').strip("'")


def _test_defined(test_anchor):
    """'tests/test_x.py::Klass::test_y' ou 'tests/test_x.py::test_y' -> existe e é coletável?"""
    filerel, _, path = test_anchor.partition("::")
    f = ROOT / filerel.strip()
    if not f.exists() or not path:
        return False
    name = path.split("::")[-1].strip()
    tree = _tree(f)
    return any(isinstance(n, ast.FunctionDef) and n.name == name for n in ast.walk(tree))


NOTES = live_notes()


def _rel(p):
    return str(p.relative_to(DOCS))


# --------------------------------------------------------------------------- #
# Checks
# --------------------------------------------------------------------------- #
def test_frontmatter_valid():
    errs = []
    for p, fm, _ in NOTES:
        if fm is None:
            errs.append(f"{_rel(p)}: sem frontmatter YAML")
            continue
        t = fm.get("type")
        if t not in VALID_TYPES:
            errs.append(f"{_rel(p)}: type inválido: {t!r}")
            continue
        for field in REQUIRED[t]:
            if not fm.get(field):
                errs.append(f"{_rel(p)}: campo obrigatório ausente p/ '{t}': {field}")
        d = fm.get("description")
        if isinstance(d, str) and len(d) < MIN_DESC:
            errs.append(f"{_rel(p)}: description curta ({len(d)} < {MIN_DESC})")
    assert not errs, "\n".join(errs)


def test_code_anchors_resolve():
    """Arquivo existe + (reader .py) símbolo achável por AST. archive isento; app = só arquivo."""
    errs = []
    for p, fm, _ in NOTES:
        if not fm or fm.get("type") == "archive":
            continue
        for anchor in as_list(fm.get("code_anchors")):
            target, kind, sym = _anchor_target(anchor)
            if kind == "app":
                continue  # cross-repo: tolerante a checkout reader-only (não falha se ausente)
            if not target.exists():
                errs.append(f"{_rel(p)}: code_anchor inexistente: {anchor}")
                continue
            if sym and not _defines(_tree(target), sym):
                errs.append(f"{_rel(p)}: símbolo não encontrado: {anchor}")
    assert not errs, "\n".join(errs)


def test_asserts_hold():
    """Cada 'modulo.SIMBOLO == valor' bate com o literal real no código."""
    errs = []
    for p, fm, _ in NOTES:
        if not fm or fm.get("type") == "archive":
            continue
        for a in as_list(fm.get("asserts")):
            m = ASSERT_RE.match(a)
            if not m:
                errs.append(f"{_rel(p)}: assert malformado (esperado 'lhs == rhs'): {a!r}")
                continue
            lhs, expected = m.group(1).strip(), _parse_rhs(m.group(2))
            actual = _literal(lhs)
            if actual is _MISSING:
                errs.append(f"{_rel(p)}: assert não resolve no código: {lhs}")
            elif actual != expected:
                errs.append(f"{_rel(p)}: assert FALHOU: {lhs} é {actual!r}, nota diz {expected!r}")
    assert not errs, "\n".join(errs)


def test_guarded_by_collectable():
    errs = []
    for p, fm, _ in NOTES:
        if not fm or fm.get("type") == "archive":
            continue
        for g in as_list(fm.get("guarded_by")):
            if not _test_defined(g):
                errs.append(f"{_rel(p)}: guarded_by não coletável: {g}")
    assert not errs, "\n".join(errs)


def test_invariants_have_symptoms():
    errs = []
    for p, fm, _ in NOTES:
        if fm and fm.get("type") == "invariant" and not as_list(fm.get("symptoms")):
            errs.append(f"{_rel(p)}: invariant sem 'symptoms' (a busca é lexical)")
    assert not errs, "\n".join(errs)


def test_no_line_numbers_in_body():
    """Número-de-linha rota; o agent é mandado pro código errado. Use code_anchors."""
    errs = []
    for p, fm, body in NOTES:
        if not fm or fm.get("type") == "archive":
            continue
        b = strip_comments(body)
        for m in LINE_REF_RE.finditer(b):
            errs.append(f"{_rel(p)}: ref de linha proibida (use code_anchors): {m.group(0)}")
        if MD_LINE_REF_RE.search(b):
            errs.append(f"{_rel(p)}: ref de linha .md proibida")
    assert not errs, "\n".join(errs)


def test_no_raw_offsets_in_reference():
    """reference cita o SÍMBOLO de offsets.py, nunca o literal @0x (que dessincroniza)."""
    errs = []
    for p, fm, body in NOTES:
        if fm and fm.get("type") == "reference" and RAW_OFFSET_RE.search(strip_comments(body)):
            errs.append(f"{_rel(p)}: @0x cru numa reference — cite o símbolo de offsets.py")
    assert not errs, "\n".join(errs)


def test_wikilinks_resolve():
    """Links em forma de caminho ([[invariants/foo]]) resolvem; [[OUTRA-COISA]] é texto literal."""
    existing = {str(p.relative_to(DOCS)).removesuffix(".md") for p, _, _ in NOTES}
    errs = []
    for p, _fm, body in NOTES:
        for tgt in WIKILINK_RE.findall(strip_comments(body)):
            tgt = tgt.strip()
            if "/" not in tgt:
                continue  # não é referência a nota (ex.: [[STATUS]] = marcador literal)
            if tgt.removesuffix(".md") not in existing:
                errs.append(f"{_rel(p)}: wikilink dangling: [[{tgt}]]")
    assert not errs, "\n".join(errs)


def test_index_coverage_bidirectional():
    idx = DOCS / "_index.md"
    if not idx.exists():
        return
    text = strip_comments(idx.read_text(encoding="utf-8"))
    linked = {t.strip().removesuffix(".md") for t in WIKILINK_RE.findall(text) if "/" in t}
    existing = {str(p.relative_to(DOCS)).removesuffix(".md") for p, _, _ in NOTES}
    errs = []
    for note in sorted(existing - linked):
        errs.append(f"_index.md não lista a nota: {note}")
    for dead in sorted(linked - existing):
        errs.append(f"_index.md aponta p/ nota inexistente: {dead}")
    assert not errs, "\n".join(errs)


def test_version_constants_unique():
    """SCHEMA_VERSION/GAME_VERSION em UM só módulo (sem segunda-fonte contraditória)."""
    defs = {"SCHEMA_VERSION": [], "GAME_VERSION": []}
    pat = re.compile(r"^(SCHEMA_VERSION|GAME_VERSION)\s*=", re.MULTILINE)
    for f in ROOT.rglob("*.py"):
        if "tests" in f.parts or "docs" in f.parts:
            continue
        for name in pat.findall(f.read_text(encoding="utf-8")):
            defs[name].append(str(f.relative_to(ROOT)))
    errs = [f"{name} definido em {len(files)} módulos: {files}"
            for name, files in defs.items() if len(files) > 1]
    assert not errs, "\n".join(errs)


def test_reverse_coverage_metrics_game():
    """Todo módulo de domínio (metrics/, game/) é code_anchor de >=1 nota viva — senão a base
    tem buraco invisível: um agent que abre o módulo não acha invariante e acha que "não há regra"."""
    anchored = set()
    for _p, fm, _b in NOTES:
        if not fm or fm.get("type") == "archive":
            continue
        for a in as_list(fm.get("code_anchors")):
            target, kind, _sym = _anchor_target(a)
            if kind == "reader" and target.exists():
                anchored.add(str(target.relative_to(ROOT)))
    orphans = []
    for sub in ("metrics", "game"):
        for f in sorted((ROOT / sub).glob("*.py")):
            if f.name == "__init__.py":
                continue
            # Módulo sem class/def top-level (re-export shim, ex.: game/enums.py reexporta os
            # enums de offsets.py) não tem lógica própria p/ ancorar — a verdade mora no
            # módulo reexportado, que é coberto por outra nota. Auto-exclui shims.
            tree = ast.parse(f.read_text(encoding="utf-8"))
            if not any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
                       for n in tree.body):
                continue
            rel = str(f.relative_to(ROOT))
            if rel not in anchored:
                orphans.append(rel)
    assert not orphans, f"módulos sem nota (cobertura-reversa): {orphans}"
