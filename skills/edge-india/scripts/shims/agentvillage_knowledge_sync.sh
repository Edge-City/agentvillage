#!/usr/bin/env bash
# Edge India knowledge sync trigger. install/install_index.ts copies this file to
# $HERMES_HOME/scripts/agentvillage_knowledge_sync.sh, because Hermes runs a cron script from there
# only, through bash, with no arguments (a .ts there would be run with Python). It runs
# skills/edge-india/scripts/knowledge-sync.ts from $HERMES_HOME (this file's parent's parent).
# The job is no_agent and has no delivery target: stdout is the wake line {"wakeAgent": false},
# so Hermes delivers nothing; a non-zero exit is a failure Hermes records and sends to the
# failure target, local. Never the resident's chat.
HOME_DIR="$(cd "$(dirname "$0")/.." 2>/dev/null && pwd)"
fail() {
  echo "{\"wakeAgent\": false, \"reason\": \"knowledge-failed-$1\"}"
  if [ -n "$HOME_DIR" ] && mkdir -p "$HOME_DIR/av-events/knowledge" 2>/dev/null; then
    printf '{"v":1,"event":"knowledge_sync","status":"failed","reason":"%s","files":0,"bytes":0,"sha256":null,"fetched_at":"%s"}\n' \
      "$1" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$HOME_DIR/av-events/knowledge/sync.jsonl" 2>/dev/null
  fi
  exit 1
}
if [ -z "$HOME_DIR" ] || ! cd "$HOME_DIR"; then fail no-home; fi
export HERMES_HOME="$HOME_DIR"
# Hermes may run scripts with HOME=$HERMES_HOME/home, so look past $HOME for bun (as the proactive shim does).
BUN=""
for candidate in "$(command -v bun 2>/dev/null)" "${HERMES_REAL_HOME:+$HERMES_REAL_HOME/.bun/bin/bun}" \
  "${HOME:+$HOME/.bun/bin/bun}" "$HOME_DIR/../.bun/bin/bun" "/home/hermes/.bun/bin/bun" "/usr/local/bin/bun"; do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then BUN="$candidate"; break; fi
done
if [ -z "$BUN" ]; then fail no-bun; fi
SYNC="skills/edge-india/scripts/knowledge-sync.ts"
if [ ! -f "$SYNC" ]; then fail no-script; fi
exec "$BUN" "$SYNC"
