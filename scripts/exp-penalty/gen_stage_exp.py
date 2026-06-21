"""Generate stage_exp.json (stageKey -> {stageLevel, expPerClear, name, ...}) from the committed
game-data snapshot (data/json). The live probe (tbh-meter-dev/exp_penalty_probe.py) bundles this so
it can look up a stage's level + base EXP/clear by the live stageKey. Re-run after a game-data refresh,
then copy stage_exp.json next to the probe in the tbh-meter-dev share.

    python gen_stage_exp.py        # writes ./stage_exp.json
"""
import json
import os

from exp_model import by_key, stage_clear_exp

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "..", "data", "json")


def main() -> None:
    stages = json.load(open(os.path.join(DATA, "stages.json"), encoding="utf-8"))
    monsters = json.load(open(os.path.join(DATA, "monsters.json"), encoding="utf-8"))
    mbk = by_key(monsters)
    out = {}
    for s in stages:
        out[str(s["key"])] = {
            "stageLevel": s.get("stageLevel"),
            "expPerClear": round(stage_clear_exp(s, mbk), 3),
            "name": s["name"],
            "diff": s.get("difficulty"),
            "waves": [s.get("waveAmount"), s.get("waveMonsterAmount")],
            "act": s.get("act"),
            "stageNo": s.get("stageNo"),
        }
    dest = os.path.join(HERE, "stage_exp.json")
    with open(dest, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False)
    print(f"wrote {dest}: {len(out)} stages")


if __name__ == "__main__":
    main()
