#!/bin/bash
# Ralph loop for Sotto (adapted from PlannyMcPlanFace's ralph.sh).
# Usage: ralph/ralph.sh [max_iterations]
# Runs Claude Code headless in auto mode (RALPH_PERMISSION_MODE to override).
# Step mode (default on, RALPH_STEP=0 to disable): pauses after every story and asks
# whether to continue, so you can check your usage before spending more.
# With step mode off, a usage limit sleeps RALPH_LIMIT_SLEEP seconds (default 1800) and retries.

set -e

MAX_ITERATIONS=10
if [[ "${1:-}" =~ ^[0-9]+$ ]]; then MAX_ITERATIONS="$1"; fi

PERMISSION_MODE="${RALPH_PERMISSION_MODE:-auto}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PRD_FILE="$SCRIPT_DIR/prd.json"
PROMPT_FILE="$SCRIPT_DIR/ITERATION.md"
LOG_FILE="$SCRIPT_DIR/loop.log"
ITER_DIR="$SCRIPT_DIR/iterations"
mkdir -p "$ITER_DIR"
LIMIT_SLEEP="${RALPH_LIMIT_SLEEP:-1800}"
STEP="${RALPH_STEP:-1}"
LIMIT_PATTERN="usage limit|rate limit|limit reached|hit your limit|limit will reset|resets at|resets [0-9]|try again later|out of extra usage"

cd "$PROJECT_DIR"

remaining() {
  jq '[.userStories[] | select(.passes == false)] | length' "$PRD_FILE"
}

echo "Starting Ralph - Mode: $PERMISSION_MODE - Max iterations: $MAX_ITERATIONS - Remaining: $(remaining)"

for i in $(seq 1 "$MAX_ITERATIONS"); do
  if [ "$(remaining)" -eq 0 ]; then
    echo "All stories pass."
    exit 0
  fi
  NEXT=$(jq -r '[.userStories[] | select(.passes == false)] | sort_by(.priority) | .[0].id' "$PRD_FILE")
  # Human checkpoint: a story with a "checkpoint" file waits until a human has written that file
  CHECKPOINT=$(jq -r '[.userStories[] | select(.passes == false)] | sort_by(.priority) | .[0].checkpoint // empty' "$PRD_FILE")
  if [ -n "$CHECKPOINT" ] && [ ! -f "$PROJECT_DIR/$CHECKPOINT" ]; then
    echo "Next story $NEXT is a human checkpoint: waiting for $CHECKPOINT. Stopping."
    echo "[$(date '+%Y-%m-%d %H:%M')] stopped at checkpoint $NEXT (waiting for $CHECKPOINT)" >> "$LOG_FILE"
    exit 0
  fi
  echo ""
  echo "==============================================================="
  echo "  Ralph Iteration $i of $MAX_ITERATIONS ($PERMISSION_MODE) - next: $NEXT"
  echo "==============================================================="
  echo "[$(date '+%Y-%m-%d %H:%M')] iteration $i start (next $NEXT)" >> "$LOG_FILE"

  HEAD_BEFORE=$(git rev-parse HEAD 2>/dev/null || echo none)
  STARTED=$(date +%s)
  OUTPUT=$(env -u ANTHROPIC_API_KEY -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT claude --permission-mode "$PERMISSION_MODE" --print < "$PROMPT_FILE" 2>&1 | tee /dev/stderr) || true
  ELAPSED=$(( $(date +%s) - STARTED ))
  # Keep each iteration's final report (stdout); progress.txt has the details, this has the summary
  printf "%s\n" "$OUTPUT" > "$ITER_DIR/$(date +%Y%m%d-%H%M)-iter$i-$NEXT.md"
  HEAD_AFTER=$(git rev-parse HEAD 2>/dev/null || echo none)

  echo "[$(date '+%Y-%m-%d %H:%M')] iteration $i end (${ELAPSED}s)" >> "$LOG_FILE"

  if echo "$OUTPUT" | grep -q "<promise>COMPLETE</promise>"; then
    echo ""
    echo "Ralph completed all stories at iteration $i."
    exit 0
  fi

  LIMITED=0
  if echo "$OUTPUT" | grep -qiE "$LIMIT_PATTERN"; then LIMITED=1; fi
  # A very short iteration with no new commit almost always means the model refused to run
  if [ "$ELAPSED" -lt 90 ] && [ "$HEAD_BEFORE" == "$HEAD_AFTER" ]; then LIMITED=1; fi

  PASSED=$(jq '[.userStories[] | select(.passes)] | length' "$PRD_FILE")
  TOTAL=$(jq '.userStories | length' "$PRD_FILE")
  NEXT=$(jq -r '[.userStories[] | select(.passes == false)] | sort_by(.priority) | .[0] | .id + " - " + .title' "$PRD_FILE")
  DIRTY=$(git status --porcelain | wc -l | tr -d ' ')
  echo ""
  echo "---------------------------------------------------------------"
  echo "  Iteration $i done in $((ELAPSED / 60))m $((ELAPSED % 60))s. Stories passing: $PASSED / $TOTAL"
  [ "$HEAD_BEFORE" != "$HEAD_AFTER" ] && git log --oneline "$HEAD_BEFORE..$HEAD_AFTER" | sed 's/^/  commit: /'
  [ "$DIRTY" -gt 0 ] && echo "  Uncommitted files: $DIRTY (the next iteration will pick them up)"
  [ "$LIMITED" -eq 1 ] && echo "  Looks like a usage limit or a failed start."
  echo "  Next: $NEXT"
  echo "---------------------------------------------------------------"

  if [ "$STEP" == "1" ]; then
    read -r -p "Continue with the next story? [Enter = yes, n = stop] " answer < /dev/tty || answer="n"
    if [[ "$answer" == "n" || "$answer" == "N" ]]; then
      echo "Stopped. Restart with: caffeinate -i ralph/preflight.sh 60"
      exit 0
    fi
  elif [ "$LIMITED" -eq 1 ]; then
    echo "Sleeping ${LIMIT_SLEEP}s before retrying" | tee -a "$LOG_FILE"
    sleep "$LIMIT_SLEEP"
  else
    sleep 2
  fi
done

echo ""
echo "Ralph reached max iterations ($MAX_ITERATIONS). Remaining stories: $(remaining)"
