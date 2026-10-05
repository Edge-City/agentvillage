#!/usr/bin/env bash
# Agent Village proactive job trigger (DATA-314 brief-lite).
# install/install_index.ts copies this one file into $HERMES_HOME/scripts/ under six names,
# agentvillage_proactive_<action>.sh, because Hermes runs a cron pre-run script from there only,
# through bash, with no arguments. The action is read from the file name; this runs
# skills/index-network/scripts/proactive.ts <action> from $HERMES_HOME (this file's parent's parent).
# Agent jobs (every action but prefetch) always exit 0 with the wake line last: a failing pre-run
# script makes Hermes ask the model to report the failure to the resident. The prefetch is the one
# no_agent job: its exit status is the trigger's (a failure notice goes to the failure target, local).
NAME="$(basename "$0" .sh)"
ACTION="${NAME#agentvillage_proactive_}"
HOME_DIR="$(cd "$(dirname "$0")/.." 2>/dev/null && pwd)"
silent() {
  echo "{\"wakeAgent\": false, \"reason\": \"$1\"}"
  if [ -n "$HOME_DIR" ] && mkdir -p "$HOME_DIR/av-events/proactive" 2>/dev/null; then
    printf '{"v":1,"ts":"%s","source":"shim","action":"%s","decision":"silent","reason":"%s"}\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$ACTION" "$1" >> "$HOME_DIR/av-events/proactive/triggers.jsonl" 2>/dev/null
  fi
}
case "$ACTION" in
  prefetch|brief|drop-midday|drop-evening|negotiation|evening) ;;
  *) ACTION="unknown"; silent unknown-action; exit 0 ;;
esac
if [ -z "$HOME_DIR" ] || ! cd "$HOME_DIR"; then silent no-home; exit 0; fi
export HERMES_HOME="$HOME_DIR"
# Hermes may run scripts with HOME=$HERMES_HOME/home, so look past $HOME for bun:
# PATH, the real home, the account that owns HERMES_HOME (/home/hermes/.hermes -> /home/hermes).
BUN=""
for candidate in "$(command -v bun 2>/dev/null)" "${HERMES_REAL_HOME:+$HERMES_REAL_HOME/.bun/bin/bun}" \
  "${HOME:+$HOME/.bun/bin/bun}" "$HOME_DIR/../.bun/bin/bun" "/home/hermes/.bun/bin/bun" "/usr/local/bin/bun"; do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then BUN="$candidate"; break; fi
done
if [ -z "$BUN" ]; then silent no-bun; exit 0; fi
TRIGGER="skills/index-network/scripts/proactive.ts"
if [ ! -f "$TRIGGER" ]; then silent no-trigger; exit 0; fi
"$BUN" "$TRIGGER" "$ACTION"
STATUS=$?
if [ "$ACTION" = "prefetch" ]; then exit "$STATUS"; fi
if [ "$STATUS" -ne 0 ]; then silent "trigger-exit-$STATUS"; fi
exit 0
