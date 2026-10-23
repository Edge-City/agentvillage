#!/usr/bin/env bash
# Installer-owned Hermes pre-run script. The polling module emits an ID-only
# Script Output and Hermes's wakeAgent line; all errors stay silent.
set -u
HERMES_HOME="$(cd "$(dirname "$0")/.." 2>/dev/null && pwd)"
if [ -z "$HERMES_HOME" ]; then echo '{"wakeAgent":false,"reason":"no-home"}'; exit 0; fi
export HERMES_HOME
POLL="$HERMES_HOME/plugins/village-bridge/_zzz_managed.py"
if [ ! -f "$POLL" ]; then echo '{"wakeAgent":false,"reason":"no-plugin"}'; exit 0; fi
python3 "$POLL" 2>/dev/null || echo '{"wakeAgent":false,"reason":"poll-error"}'
exit 0
