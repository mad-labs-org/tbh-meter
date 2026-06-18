"""
test_docs_consistency.py — the anti-drift GUARD for the knowledge base (docs/).

The reader's KB is a skill-graph: an index (docs/_index.md) → small notes
(docs/<type>/*.md) → the code (the executable truth). A note is only worth keeping if it
stays TRUE as the reader changes every PR. This test is what stops the KB from rotting
in silence (the `ficha.py`→`build.py` case: the module was renamed and 5 docs were left
lying). But symbol existence is NOT enough — the worst drift is text that went false with
the symbol intact. So here we validate VALUE and BEHAVIOR, not just "the symbol exists":

  • valid frontmatter (type in the taxonomy, description, required fields per type)
  • code_anchors RESOLVE via AST (Class.attr / def / class), not via substring
    (substring would give a false-green on a comment)
  • `asserts:` ("module.SYMBOL == value") match the real literal in the code
  • `guarded_by:` names a behavior test that EXISTS and is collectable
  • `symptoms:` non-empty on invariants (recovery is lexical → the symptom the
    agent greps for has to be written down)
  • FORBIDDEN line numbers (file.py:NN) in the body — they rot; use code_anchors
  • FORBIDDEN raw @0x in `reference` notes — cite the SYMBOL from offsets.py, not the literal
  • path-form wikilinks ([[invariants/foo]]) resolve (dangling in the namespace = failure)
  • _index lists every note and every _index link resolves (bidirectional)
  • SCHEMA_VERSION/GAME_VERSION defined in ONE module only (no contradictory second source)

`archive/` notes are SNAPSHOTS: exempt from the code checks (frontmatter only), because
they describe a past state. Stdlib-only + pytest (runs on Mac, never touches game memory).
"""
import ast
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent          # tbh-meter/reader/
DOCS = ROOT / "docs"
REPO = ROOT.parent                                       # tbh-meter/  (app/ is a sibling of reader/)
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
    """Content inside <!-- --> is non-rendered scaffolding (e.g. examples in a template);
    the body checks only apply to the live content."""
    return HTML_COMMENT_RE.sub("", text)


# --------------------------------------------------------------------------- #
# Note parsing (simple YAML frontmatter: scalars + lists)
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
    """(path, fm, body) for every note in the type subdirectories. _index/README excluded."""
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
# AST resolution (code = truth)
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
    """symbol = 'Name' (def/class/assign at any level, includes closures) or 'Class.attr'."""
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
    """Literal value of 'module.SYMBOL' or 'module.Class.ATTR' via AST. _MISSING if not found."""
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
    """'tests/test_x.py::Klass::test_y' or 'tests/test_x.py::test_y' -> exists and collectable?"""
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
            errs.append(f"{_rel(p)}: no YAML frontmatter")
            continue
        t = fm.get("type")
        if t not in VALID_TYPES:
            errs.append(f"{_rel(p)}: invalid type: {t!r}")
            continue
        for field in REQUIRED[t]:
            if not fm.get(field):
                errs.append(f"{_rel(p)}: required field missing for '{t}': {field}")
        d = fm.get("description")
        if isinstance(d, str) and len(d) < MIN_DESC:
            errs.append(f"{_rel(p)}: description too short ({len(d)} < {MIN_DESC})")
    assert not errs, "\n".join(errs)


def test_code_anchors_resolve():
    """File exists + (reader .py) symbol findable via AST. archive exempt; app = file only."""
    errs = []
    for p, fm, _ in NOTES:
        if not fm or fm.get("type") == "archive":
            continue
        for anchor in as_list(fm.get("code_anchors")):
            target, kind, sym = _anchor_target(anchor)
            if kind == "app":
                continue  # cross-repo: tolerant of a reader-only checkout (no failure if absent)
            if not target.exists():
                errs.append(f"{_rel(p)}: code_anchor does not exist: {anchor}")
                continue
            if sym and not _defines(_tree(target), sym):
                errs.append(f"{_rel(p)}: symbol not found: {anchor}")
    assert not errs, "\n".join(errs)


def test_asserts_hold():
    """Each 'module.SYMBOL == value' matches the real literal in the code."""
    errs = []
    for p, fm, _ in NOTES:
        if not fm or fm.get("type") == "archive":
            continue
        for a in as_list(fm.get("asserts")):
            m = ASSERT_RE.match(a)
            if not m:
                errs.append(f"{_rel(p)}: malformed assert (expected 'lhs == rhs'): {a!r}")
                continue
            lhs, expected = m.group(1).strip(), _parse_rhs(m.group(2))
            actual = _literal(lhs)
            if actual is _MISSING:
                errs.append(f"{_rel(p)}: assert does not resolve in the code: {lhs}")
            elif actual != expected:
                errs.append(f"{_rel(p)}: assert FAILED: {lhs} is {actual!r}, note says {expected!r}")
    assert not errs, "\n".join(errs)


def test_guarded_by_collectable():
    errs = []
    for p, fm, _ in NOTES:
        if not fm or fm.get("type") == "archive":
            continue
        for g in as_list(fm.get("guarded_by")):
            if not _test_defined(g):
                errs.append(f"{_rel(p)}: guarded_by not collectable: {g}")
    assert not errs, "\n".join(errs)


def test_invariants_have_symptoms():
    errs = []
    for p, fm, _ in NOTES:
        if fm and fm.get("type") == "invariant" and not as_list(fm.get("symptoms")):
            errs.append(f"{_rel(p)}: invariant without 'symptoms' (the search is lexical)")
    assert not errs, "\n".join(errs)


def test_no_line_numbers_in_body():
    """Line numbers rot; the agent gets sent to the wrong code. Use code_anchors."""
    errs = []
    for p, fm, body in NOTES:
        if not fm or fm.get("type") == "archive":
            continue
        b = strip_comments(body)
        for m in LINE_REF_RE.finditer(b):
            errs.append(f"{_rel(p)}: forbidden line ref (use code_anchors): {m.group(0)}")
        if MD_LINE_REF_RE.search(b):
            errs.append(f"{_rel(p)}: forbidden .md line ref")
    assert not errs, "\n".join(errs)


def test_no_raw_offsets_in_reference():
    """reference cites the SYMBOL from offsets.py, never the literal @0x (which desyncs)."""
    errs = []
    for p, fm, body in NOTES:
        if fm and fm.get("type") == "reference" and RAW_OFFSET_RE.search(strip_comments(body)):
            errs.append(f"{_rel(p)}: raw @0x in a reference — cite the symbol from offsets.py")
    assert not errs, "\n".join(errs)


def test_wikilinks_resolve():
    """Path-form links ([[invariants/foo]]) resolve; [[SOMETHING-ELSE]] is literal text."""
    existing = {str(p.relative_to(DOCS)).removesuffix(".md") for p, _, _ in NOTES}
    errs = []
    for p, _fm, body in NOTES:
        for tgt in WIKILINK_RE.findall(strip_comments(body)):
            tgt = tgt.strip()
            if "/" not in tgt:
                continue  # not a note reference (e.g. [[STATUS]] = literal marker)
            if tgt.removesuffix(".md") not in existing:
                errs.append(f"{_rel(p)}: dangling wikilink: [[{tgt}]]")
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
        errs.append(f"_index.md does not list the note: {note}")
    for dead in sorted(linked - existing):
        errs.append(f"_index.md points to a non-existent note: {dead}")
    assert not errs, "\n".join(errs)


def test_version_constants_unique():
    """SCHEMA_VERSION/GAME_VERSION in ONE module only (no contradictory second source)."""
    defs = {"SCHEMA_VERSION": [], "GAME_VERSION": []}
    pat = re.compile(r"^(SCHEMA_VERSION|GAME_VERSION)\s*=", re.MULTILINE)
    for f in ROOT.rglob("*.py"):
        if "tests" in f.parts or "docs" in f.parts:
            continue
        for name in pat.findall(f.read_text(encoding="utf-8")):
            defs[name].append(str(f.relative_to(ROOT)))
    errs = [f"{name} defined in {len(files)} modules: {files}"
            for name, files in defs.items() if len(files) > 1]
    assert not errs, "\n".join(errs)


def test_reverse_coverage_metrics_game():
    """Every domain module (metrics/, game/) is a code_anchor of >=1 live note — otherwise the KB
    has an invisible hole: an agent that opens the module finds no invariant and assumes "no rule"."""
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
            # A module with no top-level class/def (re-export shim, e.g. game/enums.py re-exports
            # the enums from offsets.py) has no logic of its own to anchor — the truth lives in
            # the re-exported module, which is covered by another note. Auto-excludes shims.
            tree = ast.parse(f.read_text(encoding="utf-8"))
            if not any(isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
                       for n in tree.body):
                continue
            rel = str(f.relative_to(ROOT))
            if rel not in anchored:
                orphans.append(rel)
    assert not orphans, f"modules without a note (reverse coverage): {orphans}"
