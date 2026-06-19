#!/bin/sh
# PreToolUse[Bash] guard: deny git force-pushes (repo policy — a force-push here once
# overwrote a teammate's "Update branch" merge). stdin: the tool-call JSON.
# Prints a deny decision (JSON) on match, nothing to allow. Wired in .claude/settings.json.
# Deliberately conservative: substring-matches the whole command (prose like
# `echo "git push --force"` is denied too) and only strips -m bodies, not --message=.
command -v jq >/dev/null 2>&1 || {
  # Fail to "ask", never open: without jq we cannot parse the call, so escalate to the human.
  printf '%s' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"guard-force-push.sh: jq not found - cannot inspect the command; review it manually."}}'
  exit 0
}
exec jq -c '
  (.tool_input.command // "") as $raw
  # Strip -m "…" / -m '\''…'\'' bodies so commit MESSAGES mentioning --force do not trip the guard.
  | ($raw | gsub("-m\\s+\"[^\"]*\""; "") | gsub("-m\\s+'\''[^'\'']*'\''"; "")) as $c
  | if (($c | test("git[[:space:]]+([^;&|]*[[:space:]]+)?push([[:space:]]+[^;&|]*)?[[:space:]]+(--force(-with-lease|-if-includes)?([^[:alnum:]-]|$)|-f([^[:alnum:]-]|$))"))
      or ($c | test("git[[:space:]]+([^;&|]*[[:space:]]+)?push([[:space:]]+[^;&|]*)?[[:space:]]+\\+[^[:space:]]")))
    then {hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:"Blocked by repo policy (.claude/hooks/guard-force-push.sh): git force-push is disabled. A force-push here once overwrote a teammate Update-branch merge. Use a plain `git push`; to fix a conflict with base, merge base into the branch (what GitHub Update-branch does). If a force-push is genuinely required, ask the user to run it themselves."}}
    else empty end'
