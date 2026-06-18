#!/usr/bin/env python3
"""diff_offsets_vs_dump.py — code↔GAME TRIPWIRE. Checks whether config/offsets.py (field
offsets + enums) and the seed (TypeDefIndex + idx_ut) still match a game build, given a FRESH
dump.cs from Il2CppDumper.

WHY: an update that recompiles GameAssembly.dll CAN shift field offsets / reorder enums /
reindex types. The reader is defensive (reads garbage or empty WITHOUT erroring) → the breakage
is SILENT. tests/test_docs_consistency.py guards docs↔code; THIS guards code↔GAME — it needs
the game binary, which does NOT live in the repo. It is the verification step of the
/tbh-game-update skill on every update; it mirrors the manual diff that cracked 1.00.10 (nothing
had changed, but we only knew because we diffed).

USAGE (with the game already dumped via Il2CppDumper — see docs/process/game-update):
    python scripts/diff_offsets_vs_dump.py --dump /path/out/dump.cs
    python scripts/diff_offsets_vs_dump.py --dump out/dump.cs --seed config/calib_seed.json

Imports config.offsets LIVE (single source — duplicates no offset). Exits != 0 if it finds a
confirmed SHIFT (offset of a NAMED class that vanished, or an enum value that changed) — it acts
as a gate. Obfuscated-name classes (drift every build: UnitHealthController/HeroRuntime/
StatsHolder/AggregateManager/StatModifier) cannot be found by name → reported as UNVERIFIABLE
(validate live in a run), NEVER failing on that.

FIELD NAME (not just presence): 'offset PRESENT but WRONG FIELD' breaks SILENTLY — it was the
1.00.12 class of bug (the bucket-box inserted fields into PlayerSaveData, shifted the lists +0x10,
and ANOTHER field landed on the old offset → the presence-only check went green and shipped). So,
for EVERY field the reader dereferences, this tripwire checks the field NAME in the dump, not just
that SOMETHING EXISTS at that offset. The expected name is DERIVED from the offsets.py ATTR
(normalized fuzzy match) so it doesn't become a list that rots; only the semantic aliases the
fuzzy match misses (e.g. HEROES↔heroSaveDatas) live in a small override (_NAME_OVERRIDE). Fields
whose dump name is OBFUSCATED (drifts per build: the *Log, LogManager, Unit.HEALTH_CONTROLLER)
CANNOT be checked by name — they come out as name-unverifiable (adjacency + the live gate cover
them), NEVER failing on that.
"""
import argparse
import json
import os
import re
import sys
from enum import Enum, IntEnum, IntFlag

# bootstrap: put the reader root (the one with meter_windows.py) on the path, from reader/ or reader/scripts/.
_here = os.path.dirname(os.path.abspath(__file__))
_reader = next((c for c in (os.path.dirname(_here), _here, os.path.join(_here, "reader"))
                if os.path.isfile(os.path.join(c, "meter_windows.py"))), None)
if _reader:
    sys.path.insert(0, _reader)
from config import offsets as O  # noqa: E402

# IL2CPP/Unity ABI (runtime layout, NOT game classes): they don't appear in dump.cs as a game
# class (String/Array/List/Dict are runtime types). They change only on a Unity upgrade
# (UnityPlayer.dll), not on a game patch — out of scope for this tripwire (validate via run).
ABI_RUNTIME = {"Obj", "String", "Array", "List", "Dict", "DictFloat", "Dict8B", "Class", "Singleton"}
SIZE_ATTRS = {"STRIDE"}   # struct size, not field offset (e.g. ItemEnchant.STRIDE)


def offsets_classes():
    """{GameClass: {ATTR: offset}} introspected from config.offsets (only game struct classes —
    excludes the ABI and the enums)."""
    out = {}
    for name, obj in vars(O).items():
        if (isinstance(obj, type) and not issubclass(obj, Enum)
                and name not in ABI_RUNTIME and name[:1].isupper()):
            fields = {a: v for a, v in vars(obj).items()
                      if isinstance(v, int) and not isinstance(v, bool)
                      and not a.startswith("_") and a not in SIZE_ATTRS}
            if fields:
                out[name] = fields
    return out


def offsets_enums():
    """{Enum: {MEMBER(upper): value}} from config.offsets (IntEnum AND IntFlag, e.g. EDamageType)."""
    return {name: {m.name.upper(): int(m.value) for m in obj}
            for name, obj in vars(O).items()
            if isinstance(obj, type) and issubclass(obj, Enum)
            and obj not in (Enum, IntEnum, IntFlag)}


def parse_dump(path):
    """Parse Il2CppDumper's dump.cs → (classes, enums, tdi, bases):
    classes = {name: {offset: field}}, enums = {NAME(upper): {MEMBER(upper): value}},
    tdi = {name: TypeDefIndex}, bases = {name: base-class} (1st after ':', C# convention).
    Takes the body with the MOST fields per name (ignores forward-decls)."""
    lines = open(path, encoding="utf-8", errors="replace").read().split("\n")
    classes, enums, tdi, bases = {}, {}, {}, {}
    decl = re.compile(r'\b(class|struct|enum)\s+(\w+)\b(.*?)(?://|$)')
    for i, line in enumerate(lines):
        m = decl.search(line)
        if not m:
            continue
        kind, name, rest = m.group(1), m.group(2), m.group(3)
        td = re.search(r'TypeDefIndex:\s*(\d+)', line)
        base = re.search(r':\s*(\w+)', rest)   # 1st after ':' = base (C# puts the base before the interfaces)
        body = {}
        j = i + 1
        while j < len(lines) and lines[j].strip() != "}":
            if kind == "enum":
                em = re.search(r'public const \w+ (\w+) = (-?\d+);', lines[j])
                if em:
                    body[em.group(1).upper()] = int(em.group(2))
            else:
                pre = lines[j].split("//")[0]
                # capture TYPE + name (anchored on the modifier) → (name, type); lenient fallback
                # (name only, type None) so we don't miss a field of unexpected shape.
                fm = re.search(r'(?:public|private|protected|internal)\s+(?:readonly\s+)?(.+?)\s+(\w+);\s*//\s*(0x[0-9A-Fa-f]+)', lines[j])
                if fm and "static" not in pre:
                    body.setdefault(int(fm.group(3), 16), (fm.group(2), fm.group(1).strip()))
                else:
                    fm = re.search(r'\b(\w+);\s*//\s*(0x[0-9A-Fa-f]+)', lines[j])
                    if fm and "static" not in pre:
                        body.setdefault(int(fm.group(2), 16), (fm.group(1), None))
            j += 1
            if j - i > 600:
                break
        if kind == "enum":
            if len(body) >= len(enums.get(name.upper(), {})):
                enums[name.upper()] = body
        else:
            if len(body) >= len(classes.get(name, {})):
                classes[name] = body
                if td:
                    tdi[name] = int(td.group(1))
                if base:
                    bases[name] = base.group(1)
    return classes, enums, tdi, bases


def _fname(v):
    """Dump field for printing — value became (name, type|None) during the parse."""
    if isinstance(v, tuple):
        return f"{v[1]} {v[0]}" if v[1] else v[0]
    return v


# Classes that offsets.py names differently from the dump (NOT obfuscated — just a divergent
# name). Without this they come out as "unverifiable" (false obfuscated) and the name-check/
# insert-check never even runs. E.g. offsets.py calls the enchant struct `ItemEnchant`, the dump
# `ItemEnchantSaveData` → without the alias the enchant iteration (STRIDE/TIER/VALUE) is COMPLETELY
# unguarded.
CLASS_ALIAS = {"ItemEnchant": "ItemEnchantSaveData"}

# Semantic aliases the fuzzy match does NOT connect (the offsets.py ATTR abbreviates the dump
# name). This is the RESIDUE of the old EXPECT_NAME: most names derive on their own (fuzzy), only
# these 8 pairs need to be stated by hand — a SMALL, semantically justified list, not the full
# list that used to rot. {Class: {ATTR: name_in_dump}}.
_NAME_OVERRIDE = {
    "PlayerSaveData": {
        "CURRENCIES": "currenySaveDatas", "HEROES": "heroSaveDatas",
        "INVENTORY_SLOTS": "inventorySaveDatas",
    },
    "MonsterSpawnManager": {
        "DEAD_MONSTER_LIST": "DeadMonsterUnit", "SUMMONED_LIST": "SummonedMonsterList",
    },
    "HeroSaveData": {"EQUIPPED_ITEMS": "equippedItemIds", "EQUIPPED_SKILLS": "equippedSKillKey"},
    "StageInfoData": {"WAVE_MOB_AMOUNT": "WaveMonsterAmount"},
}

# OBFUSCATED field in the dump: a 2–5 lowercase-letter name with no semantic structure (e.g. bfge,
# bffo, ph, bcqv) — IL2CPP stripped the name and it DRIFTS per build, exactly like the class names
# (ut→uu). Checking that name would break the tripwire on the next build with the correct offset.
# The reader reads these fields by OFFSET on purpose; what validates them is adjacency (below) +
# the live gate.
_OBF_FIELD = re.compile(r"[a-z]{2,5}$")


def _is_obf_field(name):
    return bool(name) and bool(_OBF_FIELD.fullmatch(name))


def _norm(s):
    """Normalize an identifier to compare an offsets.py ATTR with a dump field (case/_-insensitive)."""
    return re.sub(r"[^a-z0-9]", "", s.lower())


def _name_matches(attr, dump_field):
    """True if the field name in the dump matches the offsets.py ATTR — by normalized substring
    (HERO_KEY↔heroKey, STAGE_KEY↔StageKey, RUNES↔RuneSaveData…). Covers ~⅔ of the fields with no list."""
    a, d = _norm(attr), _norm(dump_field)
    return a == d or a in d or d in a


def _expected_field_name(cls_name, attr, dump_field):
    """Expected field name in the dump for (Class.ATTR), or None if it can't be verified by name.
    Derives fuzzily from the ATTR; falls back to the semantic override; skips obfuscated names (drift) → None."""
    ov = _NAME_OVERRIDE.get(cls_name, {}).get(attr)
    if ov is not None:
        return ov
    if _is_obf_field(dump_field):
        return None                      # obfuscated: not verifiable by name (live-gate covers it)
    return "" if _name_matches(attr, dump_field) else attr  # "" = OK by fuzzy; otherwise require the ATTR


def _near(dump_fields, off):
    return ", ".join(f"0x{o:X}={_fname(dump_fields[o])}" for o in sorted(dump_fields) if abs(o - off) <= 8) or "—"


def _insertion_report(own_fields, tracked_offsets):
    """List the dump fields that fall BELOW the highest tracked offset but that offsets.py does NOT
    track — the signal of an INSERTION (the bucket-box class of bug). Returns a sorted
    [(offset, field)]. Empty = nothing inserted in the middle of the tracked window."""
    if not tracked_offsets:
        return []
    hi = max(tracked_offsets)
    tracked = set(tracked_offsets)
    return [(o, _fname(own_fields[o])) for o in sorted(own_fields)
            if o <= hi and o not in tracked]


def main():
    ap = argparse.ArgumentParser(description="code↔game tripwire: offsets.py vs a dump.cs")
    ap.add_argument("--dump", required=True, help="path to the dump.cs (Il2CppDumper)")
    ap.add_argument("--seed", help="config/calib_seed.json — checks the build's TypeDefIndex + idx_ut")
    args = ap.parse_args()
    if not os.path.isfile(args.dump):
        print(f"[x] dump not found: {args.dump}")
        return 2
    dclasses, denums, dtdi, dbases = parse_dump(args.dump)
    dclass_ci = {k.lower(): k for k in dclasses}
    shifts, unver, ok = [], [], 0
    name_unver = []   # fields whose dump name is obfuscated (drift) — can't be checked by name

    # Inheritance: offsets.py groups SUBCLASS fields under the base (e.g. Hero.cache under `class Unit`,
    # because the reader reads from a Hero pointer). The dump separates them → an offset "missing" on the
    # base may be in a subclass. Build children-by-base and look for the offset on the class + descendants.
    children = {}
    for c, b in dbases.items():
        children.setdefault(b, []).append(c)

    def descend_fields(dname):
        seen, stack, merged = set(), [dname], {}
        while stack:
            c = stack.pop()
            if c in seen:
                continue
            seen.add(c)
            for o, f in (dclasses.get(c) or {}).items():
                merged.setdefault(o, f)
            stack.extend(children.get(c, []))
        return merged

    print("== FIELD OFFSETS (named game classes) ==")
    for name, fields in sorted(offsets_classes().items()):
        # name → class in the dump: the name itself, the curated alias, or case-insensitive (last resort).
        dname = (name if name in dclasses
                 else CLASS_ALIAS.get(name) if CLASS_ALIAS.get(name) in dclasses
                 else dclass_ci.get(name.lower()))
        if dname is None:
            unver.append(name)
            print(f"  ?  {name:22s} not found by name (obfuscated?) — validate live")
            continue
        own = dclasses[dname]
        merged = descend_fields(dname)
        bad, badname, via_sub, nver = [], [], 0, 0
        for a, o in fields.items():
            df = own.get(o)
            if df is None and o in merged:
                df, via_sub = merged.get(o), via_sub + 1   # inherited in a subclass (e.g. Hero.cache) — valid
            if df is None:
                bad.append((a, o))
                continue
            # Field NAME: catches 'offset PRESENT but WRONG FIELD' (an insert shifted the field and
            # ANOTHER landed on the old offset — the 1.00.12 bucket-box class of bug). Expected is DERIVED
            # from the ATTR (fuzzy) + semantic override; obfuscated name in the dump → unverifiable (None).
            got_n = df[0] if isinstance(df, tuple) else df
            exp_n = _expected_field_name(name, a, got_n)
            if exp_n is None:
                nver += 1
                name_unver.append(f"{name}.{a}")
            elif exp_n and got_n and not _name_matches(exp_n, got_n):
                badname.append((a, o, exp_n, got_n))
        if bad or badname:
            # Insertion: if any field shifted, show the ENTIRE class window (field@offset) so the
            # maintainer can see WHERE the new field came in (the bucket-box insertion was invisible in the diff).
            ins = _insertion_report(own, list(fields.values()))
            for a, o in bad:
                shifts.append(f"{name}.{a}@0x{o:X}")
                print(f"  ✗  {name}.{a} @ 0x{o:X} — NO FIELD (near: {_near(merged, o)})")
            for a, o, exp_n, got_n in badname:
                shifts.append(f"{name}.{a}@0x{o:X}(field)")
                print(f"  ✗  {name}.{a} @ 0x{o:X} — WRONG FIELD: expected `{exp_n}`, found `{got_n}`")
            if ins:
                print(f"      ↪ possible INSERTION in {name} (dump fields not tracked in the window): "
                      + ", ".join(f"0x{o:X}={f}" for o, f in ins))
        else:
            ok += 1
            extra = f"  (+{via_sub} via subclass)" if via_sub else ""
            extra += f"  ({nver} obfuscated name)" if nver else ""
            print(f"  ✓  {name:22s} {len(fields)} offsets OK{extra}")

    print("\n== ENUMS ==")
    for name, members in sorted(offsets_enums().items()):
        dm = denums.get(name.upper())
        if dm is None:
            unver.append(name)
            print(f"  ?  {name:22s} not found — validate live")
            continue
        dvals = set(dm.values())
        bad, namewarn = [], []
        for mem, val in members.items():
            if dm.get(mem) == val:
                continue
            elif mem not in dm and val in dvals:
                namewarn.append(mem)   # value present, only the NAME differs (e.g. the game's typo ENVIROUNMENT) — not drift
            else:
                bad.append((mem, val))
        if bad:
            for mem, val in bad:
                shifts.append(f"{name}.{mem}")
                print(f"  ✗  {name}.{mem} expected {val} -> dump {dm.get(mem)}")
        else:
            ok += 1
            extra = f"  ({len(namewarn)} name differs, value OK)" if namewarn else ""
            print(f"  ✓  {name:22s} {len(members)} members OK{extra}")

    if args.seed:
        print("\n== SEED (TypeDefIndex + idx_ut) ==")
        try:
            doc = json.load(open(args.seed, encoding="utf-8"))
            entry = next(iter(doc.get("calib", {}).values()))
        except Exception as e:
            entry = None
            print(f"  ?  seed unreadable ({e}) — skipped")
        if entry:
            idx_ok, idx_miss = 0, 0
            for cname, idx in sorted(entry.get("indices", {}).items()):
                got = dtdi.get(cname)
                if got == idx:
                    ok += 1
                    idx_ok += 1
                elif got is None:
                    idx_miss += 1
                    print(f"  ?  index {cname}={idx}: class not found in the dump by name")
                else:
                    shifts.append(f"indices.{cname}")
                    print(f"  ✗  index {cname}: seed={idx} -> dump TypeDefIndex={got}")
            tot = len(entry.get("indices", {}))
            extra = f"  ({idx_miss} class with no name in the dump)" if idx_miss else ""
            print(f"  ✓  {idx_ok}/{tot} of the seed's TypeDefIndex match the dump{extra}")
            # anchor_rva: it's an RVA (address in the module), NOT a field offset — can't be diffed
            # against dump.cs. But we confirm it exists and is non-trivial: a discover_anchor that
            # false-passed writes garbage here and is never re-validated (gap G). Surface the value.
            anchor = entry.get("anchor_rva")
            if isinstance(anchor, int) and anchor > 0:
                print(f"  i  anchor_rva={anchor} (0x{anchor:X}) — RVA, not diffable; validate live (calib/seed)")
            else:
                shifts.append("anchor_rva")
                print(f"  ✗  anchor_rva missing/invalid in the seed: {anchor!r}")
            # idx_ut: the class at this index must be the AggregateManager (EAggregateType dict).
            idx_ut = entry.get("idx_ut")
            by_idx = {v: k for k, v in dtdi.items()}
            gold_cls = by_idx.get(idx_ut)
            holds_gold = False
            if gold_cls:
                blk = "\n".join(open(args.dump, encoding="utf-8", errors="replace").read().split("\n"))
                holds_gold = bool(re.search(
                    r'\b(class|struct)\s+' + re.escape(gold_cls) + r'\b[\s\S]{0,2000}?Dictionary<EAggregateType', blk))
            if holds_gold:
                ok += 1
                print(f"  ✓  idx_ut={idx_ut} -> {gold_cls} (has Dictionary<EAggregateType,…>) — gold OK")
            else:
                shifts.append("idx_ut")
                print(f"  ✗  idx_ut={idx_ut} -> {gold_cls or '?'} does NOT have the gold dict — reindexed")

    skipped = sorted(n for n in (set(vars(O)) & ABI_RUNTIME))
    print(f"\n(Unity ABI {skipped} out of scope: changes only on an engine upgrade — validate via run)")
    if name_unver:
        print(f"(fields with an obfuscated name in the dump — checked by offset+adjacency, not by name: "
              f"{len(name_unver)}; validate live)")
    print(f"\n== SUMMARY ==  ok={ok}  shifted={len(shifts)}  "
          f"unverifiable-classes={len(unver)}  obfuscated-name-fields={len(name_unver)}")
    if shifts:
        print("DRIFT DETECTED — offsets.py/seed need updating for this build:")
        print("  " + ", ".join(shifts))
        return 1
    print("No offset/enum/index drift vs this dump.")
    print("(unverifiable = obfuscated name; confirm with a live run: gold + stage + xp.)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
