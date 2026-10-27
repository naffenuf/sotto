#!/usr/bin/env bash
# Check that the Mac has everything the Ralph loop needs, then (optionally) start it.
# Usage: ralph/preflight.sh [max_iterations]   (omit to only check)
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
CHATTERBOX_PY="$HOME/Developer/Chatterbox/venv/bin/python"
fail=0
check() { if eval "$2" &>/dev/null; then echo "  ok       $1"; else echo "  MISSING  $1  ->  $3"; fail=1; fi; }

echo "Tools:"
check "claude (auto mode)"  "claude --help | grep -q '\"auto\"'"          "update Claude Code"
check "node 22+"            "node -e 'process.exit(+process.versions.node.split(\".\")[0] >= 22 ? 0 : 1)'" "nvm install 22"
check "npm"                 "command -v npm"                               "brew install node"
check "jq"                  "command -v jq"                                "brew install jq"
check "ffmpeg"              "command -v ffmpeg"                            "brew install ffmpeg"
check "Chatterbox TTS"      "'$CHATTERBOX_PY' -c 'import chatterbox'"      "set up ~/Developer/Chatterbox/venv (fixture stories need it)"

echo "Repo:"
check "git repo"            "git -C '$PROJECT_DIR' rev-parse HEAD"         "git init and make an initial commit"
check ".env has MODEL_API_KEY" "grep -qE '^MODEL_API_KEY=.+' '$PROJECT_DIR/.env'" "cp .env.example .env and add the Meta Model API key"
if [[ -n "$(git -C "$PROJECT_DIR" status --porcelain)" ]]; then echo "  note     uncommitted changes present; the next iteration will salvage or discard them"; fi
if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then echo "  WARN     ANTHROPIC_API_KEY is set in this shell; ralph.sh strips it before calling claude"; fi

echo "Auth:"
out=$(cd "$PROJECT_DIR" && env -u ANTHROPIC_API_KEY claude -p --permission-mode auto "Reply with exactly: AUTH_OK" 2>&1 || true)
if echo "$out" | grep -q AUTH_OK; then echo "  ok       claude -p --permission-mode auto"; else echo "  FAIL     claude auto mode: $(echo "$out" | tail -2)"; fail=1; fi

[[ $fail -eq 0 ]] || { echo; echo "Fix the items above, then rerun."; exit 1; }
echo; echo "All checks passed. Stories remaining: $(jq '[.userStories[] | select(.passes==false)] | length' "$SCRIPT_DIR/prd.json")"
if [[ -n "${1:-}" ]]; then
  read -p "Start the Ralph loop for up to $1 iterations? [y/N] " c
  [[ "$c" == "y" || "$c" == "Y" ]] && cd "$PROJECT_DIR" && exec "$SCRIPT_DIR/ralph.sh" "$1"
fi
