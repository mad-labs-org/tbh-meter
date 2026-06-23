#!/usr/bin/env bash
# Seed ~/tbh-meter so the Electron app renders a believable live run + blue-chest
# cooldown + a few completed runs on macOS (no reader/game needed). For capturing
# real screenshots of the overlay (LiveApp) and the main window (ListApp).
set -euo pipefail
DIR="$HOME/tbh-meter"
SUP="$HOME/Library/Application Support/tbh-meter"
mkdir -p "$DIR/logs" "$SUP"
NOW=$(( $(date +%s) * 1000 ))
DROP=$(( NOW - 240000 ))   # blue chest dropped 4 min ago → ~8 min remaining

# live overlay: active run on 3-9 Hell, blue (stage-boss) chest in drops[1]
cat > "$DIR/live.json" <<EOF
{"raw_schema_version":1,"run":7,"stageKey":30901,"act":3,"stageNo":9,"difficulty":2,"mobs":68,"total_mobs":120,"damage_now":2830000,"elapsed":34,"gold_now":98500,"xp_now":1830000,"party":[101,201,301],"drops":[2,1,0]}
EOF

# settings: two active blue-chest cooldowns so the overlay shows the chest cards
cat > "$SUP/settings.json" <<EOF
{"outputDir":null,"opacity":1,"alwaysOnTop":true,"liveBounds":null,"listBounds":null,"hideSignInPrompt":true,"liveExpanded":true,"runColumns":[],"anonymousUpload":true,"hideNonCounted":true,"minDurationSec":null,"cooldownTrackerEnabled":true,"chestCooldowns":[{"stageKey":30901,"stage":"3-9","mode":"Hell","dropAt":$DROP},{"stageKey":20901,"stage":"2-9","mode":"Hell","dropAt":$(( NOW - 600000 ))}],"chestDropLog":[{"stageKey":30901,"stage":"3-9","mode":"Hell","dropAt":$DROP}]}
EOF

# a few completed runs for the list / sessions view
for r in 5 6 7; do
cat > "$DIR/logs/1717799000-12345:$r.json" <<EOF
{"id":"1717799000-12345:$r","ts":$(( NOW - (8 - r) * 60000 )),"sessionId":"1717799000-12345","schemaVersion":1,"structuredSchemaVersion":1,"gameVersion":"1.00.10","run":$r,"status":"success","quality":"counted","stage":"3-9","act":3,"stageNo":9,"stageKey":30901,"mode":"Hell","mobs":118,"totalMobs":120,"totalDamage":4500000,"dps":118700,"clearTime":90,"duration":92,"goldGained":1960000,"goldSource":"live","xpGained":3400000,"xpSource":"live","xpPerSec":37777,"goldPerSec":21777,"partial":false,"drops":[{"boxKey":1,"monsterType":2}],"deaths":0,"revives":0,"issues":{},"heroes":[{"heroKey":101,"class":"0x1","classId":1,"level":80,"exp":1234567,"items":[],"skills":[],"stats":{},"deaths":0,"revives":0}]}
EOF
done
echo "seeded: $DIR/live.json + 3 logs + settings (2 blue-chest cooldowns)"
