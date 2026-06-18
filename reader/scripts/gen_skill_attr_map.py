#!/usr/bin/env python3
"""gen_skill_attr_map.py — gera config/skill_attr_map.json + config/passive_skill_keys.json
a partir do datamining.

O save guarda o nível de uma skill na ÁRVORE de atributos (AttributeSaveData{Key,Level}),
indexado pela `attributeKey` do node. São DUAS pontes (active vs passive):

  • ATIVAS: a skill EQUIPADA (HeroSaveData.equippedSKillKey) é uma `skillKey` que NÃO é a
    attributeKey. skill_attr_map.json = {skillKey(refKey): attributeKey} dos nodes ACTIVESKILL
    (cada um tem refKey == skillKey e um attributeKey próprio). O reader equipada->nível via map.

  • PASSIVAS: não são equipadas (não aparecem em equippedSKillKey); existem só na árvore. Pra
    um node PASSIVESKILL, refKey == attributeKey (cravado: 0/96 diferem) → a própria chave do
    attr É a identidade da skill. passive_skill_keys.json = lista GLOBAL das attributeKeys
    PASSIVESKILL; o reader inclui as que o herói investiu (interseção com attr_levels).

Fonte: web/src/data/heroes.json (datamining; mesma fonte que o app sincroniza). Rode de novo
quando os dados do jogo mudarem:  python reader/scripts/gen_skill_attr_map.py

Garantias checadas aqui (falha se quebrar): (1) cada refKey ativo mapeia p/ EXATAMENTE um
attributeKey (mapa global não-ambíguo); (2) nenhum attributeKey passivo colide com um
attributeKey de skill ativa (senão a interseção contaria a ativa também como passiva)."""

import json
import os
import sys


def repo_root(start):
    """Sobe a árvore até achar web/src/data/heroes.json. None se não achar."""
    d = os.path.abspath(start)
    while True:
        if os.path.isfile(os.path.join(d, "web", "src", "data", "heroes.json")):
            return d
        parent = os.path.dirname(d)
        if parent == d:
            return None
        d = parent


def build_active_map(heroes):
    """{skillKey(refKey): attributeKey} dos nodes ACTIVESKILL. Levanta em ambiguidade."""
    out = {}
    for h in heroes:
        for n in h.get("skillTree", []):
            if n.get("type") != "ACTIVESKILL":
                continue
            rk, ak = n.get("refKey"), n.get("attributeKey")
            if rk is None or ak is None:
                continue
            if rk in out and out[rk] != ak:
                raise SystemExit(
                    f"ambiguous: skillKey {rk} maps to both {out[rk]} and {ak} "
                    f"(hero {h.get('key')}). Global map unsafe — needs per-hero keying."
                )
            out[rk] = ak
    return out


def passive_keys(heroes):
    """Set GLOBAL das attributeKeys (== refKey nas passivas) de TODOS os nodes PASSIVESKILL."""
    out = set()
    for h in heroes:
        for n in h.get("skillTree", []):
            if n.get("type") == "PASSIVESKILL" and n.get("attributeKey") is not None:
                out.add(n["attributeKey"])
    return out


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    root = repo_root(here)
    if not root:
        raise SystemExit("could not locate web/src/data/heroes.json from " + here)
    with open(os.path.join(root, "web", "src", "data", "heroes.json"), encoding="utf-8") as f:
        heroes = json.load(f)

    active = build_active_map(heroes)
    passive = passive_keys(heroes)
    # As passivas entram no reader por interseção (attr_levels ∩ passive). Se um attributeKey
    # passivo for igual a um attributeKey de skill ATIVA, a ativa apareceria 2× (como passiva
    # também). Cravado hoje: 0 colisões — mas falha alto se algum build do jogo introduzir uma.
    clash = set(active.values()) & passive
    if clash:
        raise SystemExit(f"active/passive attributeKey clash: {sorted(clash)[:10]} — "
                         "intersection would double-count. Needs disambiguation.")

    cfg = os.path.join(os.path.dirname(here), "config")
    with open(os.path.join(cfg, "skill_attr_map.json"), "w", encoding="utf-8") as f:
        json.dump({str(k): active[k] for k in sorted(active)}, f,
                  ensure_ascii=False, indent=1, sort_keys=True)
        f.write("\n")
    with open(os.path.join(cfg, "passive_skill_keys.json"), "w", encoding="utf-8") as f:
        json.dump(sorted(passive), f, ensure_ascii=False, indent=1)
        f.write("\n")
    print(f"wrote skill_attr_map.json ({len(active)} active skills) + "
          f"passive_skill_keys.json ({len(passive)} passive skills)", file=sys.stderr)


if __name__ == "__main__":
    main()
