#!/bin/sh
# Self-test for the PreToolUse guard hooks. Run from the repo root:
#   sh .claude/hooks/test-guards.sh        (exit 0 = all green)
# Each case feeds a simulated tool-call JSON to a guard and asserts deny/allow.
cd "$(dirname "$0")/../.." || exit 1
H=.claude/hooks
export CLAUDE_PROJECT_DIR="$(pwd)"
pass=0; fail=0

t() { # t <name> <expect:deny|allow> <script> <payload-json>
  out=$(printf '%s' "$4" | "$H/$3")
  if [ "$2" = deny ]; then
    if printf '%s' "$out" | grep -q '"permissionDecision":"deny"'; then pass=$((pass+1))
    else fail=$((fail+1)); echo "FAIL($1): expected deny, got: ${out:-<empty>}"; fi
  else
    if [ -z "$out" ]; then pass=$((pass+1))
    else fail=$((fail+1)); echo "FAIL($1): expected allow, got: $out"; fi
  fi
}

# --- force-push guard ---
t fp1 deny  guard-force-push.sh '{"tool_input":{"command":"git push --force"}}'
t fp2 deny  guard-force-push.sh '{"tool_input":{"command":"git push -f origin mybranch"}}'
t fp3 deny  guard-force-push.sh '{"tool_input":{"command":"git push origin +main"}}'
t fp4 deny  guard-force-push.sh '{"tool_input":{"command":"cd app && git push --force-with-lease"}}'
t fp5 deny  guard-force-push.sh '{"tool_input":{"command":"git push --force-if-includes origin x"}}'
t fp6 allow guard-force-push.sh '{"tool_input":{"command":"git push"}}'
t fp7 allow guard-force-push.sh '{"tool_input":{"command":"git push origin feature-branch"}}'
t fp8 allow guard-force-push.sh '{"tool_input":{"command":"git commit -m \"never use --force here\""}}'
t fp9 allow guard-force-push.sh '{"tool_input":{"command":"echo force push is bad"}}'
t fp10 allow guard-force-push.sh '{"tool_input":{"command":"git push origin HEAD:refs/heads/x"}}'

# --- generated-files guard ---
t gf1 deny  guard-generated-files.sh "{\"tool_input\":{\"file_path\":\"$CLAUDE_PROJECT_DIR/app/src/shared/data/items-min.json\"}}"
t gf2 deny  guard-generated-files.sh "{\"tool_input\":{\"file_path\":\"$CLAUDE_PROJECT_DIR/app/src/renderer/public/sprites/0001.png\"}}"
t gf3 deny  guard-generated-files.sh "{\"tool_input\":{\"file_path\":\"$CLAUDE_PROJECT_DIR/app/src/renderer/public/heroes/hero.webp\"}}"
t gf4 allow guard-generated-files.sh "{\"tool_input\":{\"file_path\":\"$CLAUDE_PROJECT_DIR/app/src/main/ipc.ts\"}}"
t gf5 allow guard-generated-files.sh "{\"tool_input\":{\"file_path\":\"$CLAUDE_PROJECT_DIR/app/scripts/sync-data.mjs\"}}"
t gf6 allow guard-generated-files.sh "{\"tool_input\":{\"file_path\":\"$CLAUDE_PROJECT_DIR/reader/src/reader.py\"}}"
t gf7 allow guard-generated-files.sh '{"tool_input":{"command":"git status"}}'
t gf8 allow guard-generated-files.sh "{\"tool_input\":{\"file_path\":\"$CLAUDE_PROJECT_DIR/app/src/shared/dataTypes.ts\"}}"

echo "guards self-test: $pass passed, $fail failed"
[ "$fail" = 0 ]
