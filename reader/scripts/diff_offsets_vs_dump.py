#!/usr/bin/env python3
"""diff_offsets_vs_dump.py — TRIPWIRE código↔JOGO. Confere se config/offsets.py (offsets de
campo + enums) e o seed (TypeDefIndex + idx_ut) ainda batem com um build do jogo, dado um
dump.cs FRESCO do Il2CppDumper.

POR QUÊ: um update que recompila o GameAssembly.dll PODE deslocar offsets de campo / reordenar
enums / reindexar tipos. O reader é defensivo (lê lixo ou vazio SEM erro) → a quebra é
SILENCIOSA. O tests/test_docs_consistency.py guarda docs↔código; ISTO guarda código↔JOGO —
precisa do binário do jogo, que NÃO vive no repo. É o passo de verificação da skill
/tbh-game-update a cada update; espelha o diff manual que crackeou o 1.00.10 (nada tinha
mudado, mas só soubemos por ter diffado).

USO (com o jogo já dumpado via Il2CppDumper — ver docs/process/game-update):
    python scripts/diff_offsets_vs_dump.py --dump /caminho/out/dump.cs
    python scripts/diff_offsets_vs_dump.py --dump out/dump.cs --seed config/calib_seed.json

Importa config.offsets AO VIVO (fonte única — não duplica nenhum offset). Sai != 0 se achar
DESLOCAMENTO confirmado (offset de classe NOMEADA que sumiu, ou valor de enum que mudou) — serve
de gate. Classes de nome ofuscado (drifta a cada build: UnitHealthController/HeroRuntime/
StatsHolder/AggregateManager/StatModifier) não dão pra achar por nome → reporta UNVERIFIABLE
(valide ao vivo num run), NUNCA falha por isso.

NOME DE CAMPO (não só presença): 'offset PRESENTE mas CAMPO ERRADO' quebra SILENCIOSO — foi a
classe de bug do 1.00.12 (o bucket-box inseriu campos no PlayerSaveData, deslocou as listas +0x10,
e OUTRO campo caiu no offset velho → o check de só-PRESENÇA passou verde e shipou). Por isso, p/
CADA campo que o reader desreferencia, este tripwire confere o NOME do campo no dump, não só que
EXISTE algo naquele offset. O nome esperado é DERIVADO do ATTR de offsets.py (match fuzzy
normalizado) p/ não virar uma lista que apodrece; só os apelidos semânticos que o fuzzy não
liga (ex.: HEROES↔heroSaveDatas) ficam num override pequeno (_NAME_OVERRIDE). Campos cujo nome
no dump é OFUSCADO (drifta por build: os *Log, LogManager, Unit.HEALTH_CONTROLLER) NÃO dão pra
checar por nome — saem como name-unverifiable (a adjacência + o gate ao vivo os cobrem), NUNCA
falham por isso.
"""
import argparse
import json
import os
import re
import sys
from enum import Enum, IntEnum, IntFlag

# bootstrap: poe a raiz do reader (a que tem meter_windows.py) no path, de reader/ ou reader/scripts/.
_here = os.path.dirname(os.path.abspath(__file__))
_reader = next((c for c in (os.path.dirname(_here), _here, os.path.join(_here, "reader"))
                if os.path.isfile(os.path.join(c, "meter_windows.py"))), None)
if _reader:
    sys.path.insert(0, _reader)
from config import offsets as O  # noqa: E402

# ABI do IL2CPP/Unity (layout de runtime, NÃO classes do jogo): não aparecem no dump.cs como
# classe do jogo (String/Array/List/Dict são tipos do runtime). Mudam só num upgrade de Unity
# (UnityPlayer.dll), não num patch do jogo — fora do escopo deste tripwire (valide via run).
ABI_RUNTIME = {"Obj", "String", "Array", "List", "Dict", "DictFloat", "Dict8B", "Class", "Singleton"}
SIZE_ATTRS = {"STRIDE"}   # tamanho de struct, não offset de campo (ex.: ItemEnchant.STRIDE)


def offsets_classes():
    """{ClasseDoJogo: {ATTR: offset}} introspectado de config.offsets (só classes de struct do
    jogo — exclui a ABI e os enums)."""
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
    """{Enum: {MEMBRO(upper): valor}} de config.offsets (IntEnum E IntFlag, ex.: EDamageType)."""
    return {name: {m.name.upper(): int(m.value) for m in obj}
            for name, obj in vars(O).items()
            if isinstance(obj, type) and issubclass(obj, Enum)
            and obj not in (Enum, IntEnum, IntFlag)}


def parse_dump(path):
    """Parseia o dump.cs do Il2CppDumper → (classes, enums, tdi, bases):
    classes = {nome: {offset: campo}}, enums = {NOME(upper): {MEMBRO(upper): valor}},
    tdi = {nome: TypeDefIndex}, bases = {nome: classe-base} (1ª após ':', convenção C#).
    Pega o corpo com MAIS campos por nome (ignora forward-decls)."""
    lines = open(path, encoding="utf-8", errors="replace").read().split("\n")
    classes, enums, tdi, bases = {}, {}, {}, {}
    decl = re.compile(r'\b(class|struct|enum)\s+(\w+)\b(.*?)(?://|$)')
    for i, line in enumerate(lines):
        m = decl.search(line)
        if not m:
            continue
        kind, name, rest = m.group(1), m.group(2), m.group(3)
        td = re.search(r'TypeDefIndex:\s*(\d+)', line)
        base = re.search(r':\s*(\w+)', rest)   # 1ª após ':' = base (C# poe a base antes das interfaces)
        body = {}
        j = i + 1
        while j < len(lines) and lines[j].strip() != "}":
            if kind == "enum":
                em = re.search(r'public const \w+ (\w+) = (-?\d+);', lines[j])
                if em:
                    body[em.group(1).upper()] = int(em.group(2))
            else:
                pre = lines[j].split("//")[0]
                # captura TIPO + nome (ancorado no modificador) → (nome, tipo); fallback lenient
                # (só nome, tipo None) pra não perder um campo de shape inesperado.
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
    """Campo do dump p/ print — value virou (nome, tipo|None) no parse."""
    if isinstance(v, tuple):
        return f"{v[1]} {v[0]}" if v[1] else v[0]
    return v


# Classes que offsets.py nomeia diferente do dump (NÃO ofuscadas — só nome divergente). Sem isto
# elas saem como "não-verificáveis" (falso ofuscado) e o name-check/insert-check nem roda. Ex.:
# offsets.py chama o struct de enchant de `ItemEnchant`, o dump de `ItemEnchantSaveData` → sem o
# alias a iteração de enchant (STRIDE/TIER/VALUE) fica TOTALMENTE desprotegida.
CLASS_ALIAS = {"ItemEnchant": "ItemEnchantSaveData"}

# Apelidos semânticos que o match fuzzy NÃO liga (o ATTR de offsets.py abrevia o nome do dump).
# Isto é o RESÍDUO do antigo EXPECT_NAME: a maioria dos nomes deriva sozinha (fuzzy), só estes 8
# pares precisam ser ditos à mão — uma lista PEQUENA e semanticamente justificada, não a lista
# cheia que apodrecia. {Classe: {ATTR: nome_no_dump}}.
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

# Campo OFUSCADO no dump: nome de 2–5 letras minúsculas sem estrutura semântica (ex.: bfge, bffo,
# ph, bcqv) — o IL2CPP stripou o nome e ele DRIFTA por build, exatamente como os nomes de classe
# (ut→uu). Checar esse nome quebraria o tripwire no próximo build com offset correto. O reader lê
# esses campos por OFFSET de propósito; quem os valida é a adjacência (abaixo) + o gate ao vivo.
_OBF_FIELD = re.compile(r"[a-z]{2,5}$")


def _is_obf_field(name):
    return bool(name) and bool(_OBF_FIELD.fullmatch(name))


def _norm(s):
    """Normaliza um identificador p/ comparar ATTR de offsets.py com campo do dump (case/_-insensitive)."""
    return re.sub(r"[^a-z0-9]", "", s.lower())


def _name_matches(attr, dump_field):
    """True se o nome do campo no dump bate com o ATTR de offsets.py — por substring normalizada
    (HERO_KEY↔heroKey, STAGE_KEY↔StageKey, RUNES↔RuneSaveData…). Cobre ~⅔ dos campos sem lista."""
    a, d = _norm(attr), _norm(dump_field)
    return a == d or a in d or d in a


def _expected_field_name(cls_name, attr, dump_field):
    """Nome esperado do campo no dump p/ (Classe.ATTR), ou None se não dá p/ verificar por nome.
    Deriva fuzzy do ATTR; cai no override semântico; pula nomes ofuscados (drift) → None."""
    ov = _NAME_OVERRIDE.get(cls_name, {}).get(attr)
    if ov is not None:
        return ov
    if _is_obf_field(dump_field):
        return None                      # ofuscado: não verificável por nome (live-gate cobre)
    return "" if _name_matches(attr, dump_field) else attr  # "" = OK por fuzzy; senão exige o ATTR


def _near(dump_fields, off):
    return ", ".join(f"0x{o:X}={_fname(dump_fields[o])}" for o in sorted(dump_fields) if abs(o - off) <= 8) or "—"


def _insertion_report(own_fields, tracked_offsets):
    """Lista os campos do dump que caem ABAIXO do maior offset rastreado mas que offsets.py NÃO
    rastreia — o sinal de uma INSERÇÃO (a classe de bug do bucket-box). Devolve [(offset, campo)]
    ordenado. Vazio = nada inserido no meio da janela rastreada."""
    if not tracked_offsets:
        return []
    hi = max(tracked_offsets)
    tracked = set(tracked_offsets)
    return [(o, _fname(own_fields[o])) for o in sorted(own_fields)
            if o <= hi and o not in tracked]


def main():
    ap = argparse.ArgumentParser(description="tripwire código↔jogo: offsets.py vs um dump.cs")
    ap.add_argument("--dump", required=True, help="caminho do dump.cs (Il2CppDumper)")
    ap.add_argument("--seed", help="config/calib_seed.json — checa TypeDefIndex + idx_ut do build")
    args = ap.parse_args()
    if not os.path.isfile(args.dump):
        print(f"[x] dump não encontrado: {args.dump}")
        return 2
    dclasses, denums, dtdi, dbases = parse_dump(args.dump)
    dclass_ci = {k.lower(): k for k in dclasses}
    shifts, unver, ok = [], [], 0
    name_unver = []   # campos cujo nome no dump é ofuscado (drift) — não dá p/ checar por nome

    # Herança: o offsets.py agrupa campos de SUBCLASSE sob a base (ex.: Hero.cache sob `class Unit`,
    # porque o reader lê de um ponteiro Hero). O dump separa → um offset "ausente" na base pode estar
    # numa subclasse. Monta filhos-por-base e procura o offset na classe + descendentes.
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

    print("== OFFSETS DE CAMPO (classes nomeadas do jogo) ==")
    for name, fields in sorted(offsets_classes().items()):
        # nome → classe no dump: o próprio nome, o alias curado, ou case-insensitive (último recurso).
        dname = (name if name in dclasses
                 else CLASS_ALIAS.get(name) if CLASS_ALIAS.get(name) in dclasses
                 else dclass_ci.get(name.lower()))
        if dname is None:
            unver.append(name)
            print(f"  ?  {name:22s} não achado por nome (ofuscado?) — valide ao vivo")
            continue
        own = dclasses[dname]
        merged = descend_fields(dname)
        bad, badname, via_sub, nver = [], [], 0, 0
        for a, o in fields.items():
            df = own.get(o)
            if df is None and o in merged:
                df, via_sub = merged.get(o), via_sub + 1   # herdado numa subclasse (ex.: Hero.cache) — válido
            if df is None:
                bad.append((a, o))
                continue
            # NOME do campo: pega 'offset PRESENTE mas CAMPO ERRADO' (um insert deslocou o campo e
            # OUTRO caiu no offset velho — a classe de bug do 1.00.12 bucket-box). Esperado DERIVADO
            # do ATTR (fuzzy) + override semântico; nome ofuscado no dump → não-verificável (None).
            got_n = df[0] if isinstance(df, tuple) else df
            exp_n = _expected_field_name(name, a, got_n)
            if exp_n is None:
                nver += 1
                name_unver.append(f"{name}.{a}")
            elif exp_n and got_n and not _name_matches(exp_n, got_n):
                badname.append((a, o, exp_n, got_n))
        if bad or badname:
            # Inserção: se algum campo deslocou, mostra a janela INTEIRA da classe (campo@offset) p/ o
            # mantenedor ver ONDE entrou o campo novo (a inserção do bucket-box ficava invisível no diff).
            ins = _insertion_report(own, list(fields.values()))
            for a, o in bad:
                shifts.append(f"{name}.{a}@0x{o:X}")
                print(f"  ✗  {name}.{a} @ 0x{o:X} — SEM CAMPO (perto: {_near(merged, o)})")
            for a, o, exp_n, got_n in badname:
                shifts.append(f"{name}.{a}@0x{o:X}(campo)")
                print(f"  ✗  {name}.{a} @ 0x{o:X} — CAMPO ERRADO: esperava `{exp_n}`, achou `{got_n}`")
            if ins:
                print(f"      ↪ possível INSERÇÃO em {name} (campos do dump não rastreados na janela): "
                      + ", ".join(f"0x{o:X}={f}" for o, f in ins))
        else:
            ok += 1
            extra = f"  (+{via_sub} via subclasse)" if via_sub else ""
            extra += f"  ({nver} nome ofuscado)" if nver else ""
            print(f"  ✓  {name:22s} {len(fields)} offsets OK{extra}")

    print("\n== ENUMS ==")
    for name, members in sorted(offsets_enums().items()):
        dm = denums.get(name.upper())
        if dm is None:
            unver.append(name)
            print(f"  ?  {name:22s} não achado — valide ao vivo")
            continue
        dvals = set(dm.values())
        bad, namewarn = [], []
        for mem, val in members.items():
            if dm.get(mem) == val:
                continue
            elif mem not in dm and val in dvals:
                namewarn.append(mem)   # valor presente, só o NOME difere (ex.: typo do jogo ENVIROUNMENT) — não é drift
            else:
                bad.append((mem, val))
        if bad:
            for mem, val in bad:
                shifts.append(f"{name}.{mem}")
                print(f"  ✗  {name}.{mem} esperado {val} -> dump {dm.get(mem)}")
        else:
            ok += 1
            extra = f"  ({len(namewarn)} nome difere, valor OK)" if namewarn else ""
            print(f"  ✓  {name:22s} {len(members)} membros OK{extra}")

    if args.seed:
        print("\n== SEED (TypeDefIndex + idx_ut) ==")
        try:
            doc = json.load(open(args.seed, encoding="utf-8"))
            entry = next(iter(doc.get("calib", {}).values()))
        except Exception as e:
            entry = None
            print(f"  ?  seed ilegível ({e}) — pulei")
        if entry:
            idx_ok, idx_miss = 0, 0
            for cname, idx in sorted(entry.get("indices", {}).items()):
                got = dtdi.get(cname)
                if got == idx:
                    ok += 1
                    idx_ok += 1
                elif got is None:
                    idx_miss += 1
                    print(f"  ?  índice {cname}={idx}: classe não achada no dump por nome")
                else:
                    shifts.append(f"indices.{cname}")
                    print(f"  ✗  índice {cname}: seed={idx} -> dump TypeDefIndex={got}")
            tot = len(entry.get("indices", {}))
            extra = f"  ({idx_miss} classe sem nome no dump)" if idx_miss else ""
            print(f"  ✓  {idx_ok}/{tot} TypeDefIndex do seed batem com o dump{extra}")
            # anchor_rva: é um RVA (endereço no módulo), NÃO um offset de campo — não dá p/ diffar
            # contra o dump.cs. Mas confirma-se que existe e é não-trivial: um discover_anchor que
            # deu false-pass grava lixo aqui e nunca é re-validado (gap G do plano). Surfaça o valor.
            anchor = entry.get("anchor_rva")
            if isinstance(anchor, int) and anchor > 0:
                print(f"  i  anchor_rva={anchor} (0x{anchor:X}) — RVA, não-diffável; valide ao vivo (calib/seed)")
            else:
                shifts.append("anchor_rva")
                print(f"  ✗  anchor_rva ausente/inválido no seed: {anchor!r}")
            # idx_ut: a classe nesse índice tem que ser o AggregateManager (dict EAggregateType).
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
                print(f"  ✓  idx_ut={idx_ut} -> {gold_cls} (tem Dictionary<EAggregateType,…>) — gold OK")
            else:
                shifts.append("idx_ut")
                print(f"  ✗  idx_ut={idx_ut} -> {gold_cls or '?'} NÃO tem o dict de gold — reindexou")

    skipped = sorted(n for n in (set(vars(O)) & ABI_RUNTIME))
    print(f"\n(ABI Unity {skipped} fora de escopo: mudam só em upgrade de engine — valide via run)")
    if name_unver:
        print(f"(campos com nome ofuscado no dump — checados por offset+adjacência, não por nome: "
              f"{len(name_unver)}; valide ao vivo)")
    print(f"\n== RESUMO ==  ok={ok}  deslocados={len(shifts)}  "
          f"classes-não-verificáveis={len(unver)}  campos-nome-ofuscado={len(name_unver)}")
    if shifts:
        print("DRIFT DETECTADO — offsets.py/seed precisam ser atualizados pra este build:")
        print("  " + ", ".join(shifts))
        return 1
    print("Sem drift de offset/enum/índice vs este dump.")
    print("(não-verificáveis = nome ofuscado; confirme com um run ao vivo: gold + stage + xp.)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
