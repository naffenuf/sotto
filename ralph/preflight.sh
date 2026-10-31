#!/usr/bin/env bash
# Check that the Mac has everything the Ralph loop needs, then (optionally) start it.
# Usage: ralph/preflight.sh [max_iterations]   (omit to only check)
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
fail=0
check() { if eval "$2" &>/dev/null; then echo "  ok       $1"; else echo "  MISSING  $1  ->  $3"; fail=1; fi; }

echo "Tools:"
check "claude (auto mode)"  "claude --help | grep -q '\"auto\"'"          "update Claude Code"
check "node 22+"            "node -e 'process.exit(+process.versions.node.split(\".\")[0] >= 22 ? 0 : 1)'" "nvm install 22"
check "npm"                 "command -v npm"                               "brew install node"
check "jq"                  "command -v jq"                                "brew install jq"
check "ffmpeg"              "command -v ffmpeg"                            "brew install ffmpeg"

echo "Repo:"
check "git repo"            "git -C '$PROJECT_DIR' rev-parse HEAD"         "git init and make an initial commit"
check ".env has MODEL_API_KEY" "grep -qE '^MODEL_API_KEY=.+' '$PROJECT_DIR/.env'" "cp .env.example .env and add the Meta Model API key"
check ".env has ELEVENLABS_API_KEY" "grep -qE '^ELEVENLABS_API_KEY=.+' '$PROJECT_DIR/.env'" "add the ElevenLabs API key to .env"
# Glimmer is a warning, not a failure: voice stories come first, and V2-010 marks itself blocked without it
GLIMMER_URL=$(grep -E '^GLIMMER_BASE_URL=' "$PROJECT_DIR/.env" 2>/dev/null | cut -d= -f2- || true)
if [[ -z "$GLIMMER_URL" ]]; then
  echo "  WARN     GLIMMER_BASE_URL not set in .env (needed from V2-010; see tasks/prd-sotto-v2.md Prerequisites)"
elif curl -sf --max-time 5 "$GLIMMER_URL/models" >/dev/null; then
  echo "  ok       Glimmer endpoint $GLIMMER_URL"
else
  echo "  WARN     Glimmer endpoint $GLIMMER_URL not answering (needed from V2-010)"
fi
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
