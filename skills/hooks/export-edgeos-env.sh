#!/bin/bash
[ -z "$CLAUDE_ENV_FILE" ] && exit 0

[ -n "$CLAUDE_PLUGIN_OPTION_edgeosApiKey" ] && \
  printf 'export EDGEOS_API_KEY=%q\n' "$CLAUDE_PLUGIN_OPTION_edgeosApiKey" >> "$CLAUDE_ENV_FILE"

[ -n "$CLAUDE_PLUGIN_OPTION_edgeosToken" ] && \
  printf 'export EDGEOS_BEARER_TOKEN=%q\n' "$CLAUDE_PLUGIN_OPTION_edgeosToken" >> "$CLAUDE_ENV_FILE"

[ -n "$CLAUDE_PLUGIN_OPTION_indexApiKey" ] && \
  printf 'export INDEX_API_KEY=%q\n' "$CLAUDE_PLUGIN_OPTION_indexApiKey" >> "$CLAUDE_ENV_FILE"

printf 'export INDEX_API_URL=%q\n' "${INDEX_API_URL:-https://protocol.index.network}" >> "$CLAUDE_ENV_FILE"

exit 0
