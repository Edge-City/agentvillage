#!/bin/sh
# SPDX-License-Identifier: MIT
#
# VENDORED, 2026-10-01, from approval-md-hosted hermes-image/hermes-hook-shim.sh
# at commit debe4a6 (2026-09-25), under this overlay's MIT licence (LICENSE at
# the repository root), as approval-md-hosted docs/03 section 3.2 provides: the
# skill and its hook live in the public overlay and carry no Bountify logic.
#
# Changes from the origin, and nothing else (the gate logic is unchanged):
#   - this header;
#   - the by-hand defaults: the facade URL and the agent credential are read
#     from AV_APPROVAL_URL / AV_APPROVAL_TOKEN (still overridable through
#     APPROVAL_HOOK_URL_ENV / APPROVAL_HOOK_TOKEN_ENV, which
#     install/install_approval.ts also writes into $HERMES_HOME/.env), and the
#     log defaults to $HERMES_HOME/agent-hooks/approval-hook.log.
# The Agent Village sandbox has one unix user, so the shim runs "by hand"
# there (no /opt/approval/hook-home, no setuid launcher; skills/approval/
# README.md says why). install/install_approval.ts installs this file as
# $HERMES_HOME/agent-hooks/hermes-hook-shim.sh, mode 0700.
#
# approval.md hook shim for Hermes Agent (HOSTED-10, hardened in HOSTED-13).
#
# Hermes runs this as a `pre_tool_call` shell hook. It reads the Hermes
# envelope on stdin, POSTs it to the tenant's facade (`approval serve`,
# POST /hook/hermes), and replays the facade's answer: body.stdout to stdout,
# body.stderr to stderr, exit body.exit_code (core cli-reference, "The response
# contract"). The shim decides nothing; the facade runs the core decider.
#
# FAIL CLOSED. Any transport failure, non-200 status, or missing, unparseable
# or truncated body prints the native Hermes block directive and exits 2.
# The directive on STDOUT is load-bearing: hermes-agent 0.14.0 (the Maritime
# template, v2026.5.16) has no `fail_closed` and does not treat exit 2 as a
# block; it blocks only on a stdout directive. So the shim also refuses to
# pass through a non-zero exit whose stdout carries no block directive, or an
# exit-0 stdout that is not empty and not a JSON object.
#
# TWO WAYS TO RUN, chosen by whether the hook home exists:
#
#   /opt/approval/hook-home present (the gated Hermes image, hermes-image/):
#     the shim runs as its own user (`approvalhook`), started by the root-owned
#     launcher /opt/approval/hook-launcher with a fixed environment. HOME and
#     TMPDIR are the hook home (owned by this user, mode 0700), and the facade
#     URL and the agent credential come from hook-home/facade.env (owned by
#     this user, mode 0600), written by the image's supervisor. Nothing the
#     agent can write (its PATH, its HOME, its TMPDIR, its environment) reaches
#     this process. The home or the file with any other owner or mode blocks.
#
#   no hook home (a hook installed by hand on a harness machine, HOSTED-10):
#     the facade URL and the credential are read from the environment under
#     the names below. The process runs as the agent's own user there, which
#     no shim can defend against fully; the fixed PATH, the absolute tool
#     paths, `curl -q` and the scrubbed variables close what a shim can.
#
# Settings. In the image they come from facade.env (URL, TOKEN, ALLOW_HTTP,
# WAIT_S, MAX_TIME); by hand, from the environment:
#   APPROVAL_HOOK_URL_ENV    name of the variable holding the facade base URL
#                            (default AV_APPROVAL_URL)
#   APPROVAL_HOOK_TOKEN_ENV  name of the variable holding the AGENT credential
#                            (default AV_APPROVAL_TOKEN)
#   APPROVAL_HOOK_LOG        log file (default
#                            $HERMES_HOME/agent-hooks/approval-hook.log;
#                            in the image, hook-home/approval-hook.log)
#   APPROVAL_HOOK_MAX_TIME   curl --max-time seconds per request (default 25;
#                            keep it under Maritime's ~30 s public-proxy cut)
#   APPROVAL_HOOK_WAIT_S     total seconds to keep asking while the facade
#                            answers hook-timeout, or after the first post
#                            timed out (image default 280, at most 285; by
#                            hand default 0, one request only: set it only
#                            under an entry timeout above it, on a Hermes
#                            that honours fail_closed)
#   APPROVAL_FACADE_ALLOW_HTTP=1  accept an http:// facade URL (local fakes
#                            only); otherwise only https:// is accepted
#
# WAITING FOR A HUMAN. A facade reached through a public proxy must answer
# within the proxy's cut (about 30 s), far short of the time a human needs to
# see the question on a phone. So when the facade answers with a block naming
# `hook-timeout` (no decision yet; the question stays open and a retry of the
# same bytes adopts it), the shim waits 5 s and posts the same envelope again,
# until APPROVAL_HOOK_WAIT_S have passed since it started; then it replays the
# last block. An allow, or any other block, is replayed at once. With the
# image's 280 s the effective human window is about 280 s, inside Hermes's
# 300 s per-entry timeout.
#
# A FIRST POST THAT TIMED OUT (HOSTED-14). The facade's own hook wait must sit
# well under MAX_TIME (12 s for the 25 s default). When it does not, the first
# post can hit the ceiling (curl exit 28) after the facade has already opened
# the question, and a re-post of the same bytes adopts it. So a curl timeout
# on the FIRST post, after at least MAX_TIME, with WAIT_S above 0, enters the
# same loop a hook-timeout block does: re-post every 5 s until WAIT_S, then
# replay the facade's last block, or, when no facade answer ever arrived, block
# with the transport reason. Every other first-post failure (connection
# refused, TLS, DNS, non-200, an unparseable body) is final: nothing there
# says a question was opened. With WAIT_S=0 a first-post timeout is final too.
#
# The credential goes to curl through a config on stdin, never argv, so it
# does not appear in /proc/<pid>/cmdline. It travels as
# X-Approval-Authorization because Maritime's public proxy strips
# Authorization (image/README.md).
#
# The log carries a timestamp, the tool name, HTTP status, exit code, the
# curl exit code of a timed-out first post, elapsed ms, the attempt, the
# refusal code and a fixed reason only. Never an envelope, a body or a value.

PATH=/usr/local/bin:/usr/bin:/bin
export PATH
IFS=$(printf ' \t\n.')
IFS=${IFS%.}
# What a by-hand install inherits from the agent and curl or node would honour.
unset CDPATH ENV BASH_ENV NODE_OPTIONS NODE_PATH NODE_EXTRA_CA_CERTS LD_PRELOAD LD_LIBRARY_PATH \
  CURL_HOME CURL_CA_BUNDLE SSL_CERT_FILE SSL_CERT_DIR SSLKEYLOGFILE XDG_CONFIG_HOME \
  http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY all_proxy NO_PROXY no_proxy 2>/dev/null

# Every tool by absolute path, from root-owned directories only.
for t in curl date mktemp head tr cat rm sleep stat id node; do
  p=""
  for d in /usr/bin /bin /usr/local/bin; do
    if [ -x "$d/$t" ]; then p="$d/$t"; break; fi
  done
  eval "T_$t=\$p"
done

HOOK_HOME=/opt/approval/hook-home
FACADE_ENV=$HOOK_HOME/facade.env

now_ms() { "$T_date" +%s%3N 2>/dev/null || echo 0; }
ts() { "$T_date" -u +%Y-%m-%dT%H:%M:%S.%3NZ 2>/dev/null; }
T0=$(now_ms)
LOG=/dev/null
TMP=""

log() {
  # Best effort: a log that cannot be written must not change the verdict.
  printf '%s pid=%s %s elapsed_ms=%s\n' "$(ts)" "$$" "$1" "$(( $(now_ms) - T0 ))" >>"$LOG" 2>/dev/null || true
}

cleanup() { [ -n "$TMP" ] && "$T_rm" -rf "$TMP"; }
trap cleanup EXIT

block() {
  # $1: reason, plain text. JSON-escaped by node when available; a fixed
  # directive otherwise, so the stdout is a block even if node is gone.
  reason="approval facade unreachable: $1"
  out=""
  [ -n "$T_node" ] && out=$("$T_node" -e 'process.stdout.write(JSON.stringify({action:"block",message:process.argv[1]}))' "$reason" 2>/dev/null)
  [ -n "$out" ] || out='{"action":"block","message":"approval facade unreachable"}'
  printf '%s\n' "$out"
  printf 'approval hook shim: %s\n' "$reason" >&2
  log "outcome=block-shim reason=\"$1\""
  exit 2
}

for t in curl date mktemp head tr cat rm sleep stat id node; do
  eval "p=\$T_$t"
  [ -n "$p" ] || block "$t is not installed in /usr/bin, /bin or /usr/local/bin"
done

is_int() { case $1 in ''|*[!0-9]*) return 1 ;; esac; return 0; }

BASE=""
TOKEN=""
if [ -e "$HOOK_HOME" ] || [ -L "$HOOK_HOME" ]; then
  # The image: this process must be the hook home's owner, and the home and
  # the credential file must be exactly as the supervisor left them.
  me=$("$T_id" -u 2>/dev/null)
  [ -d "$HOOK_HOME" ] && [ ! -L "$HOOK_HOME" ] || block "the hook home is not a directory"
  [ "$("$T_stat" -c '%u %a' "$HOOK_HOME" 2>/dev/null)" = "$me 700" ] ||
    block "the hook home is not owned by this user with mode 0700 (is the hook running through /opt/approval/hook-launcher?)"
  HOME=$HOOK_HOME
  TMPDIR=$HOOK_HOME
  export HOME TMPDIR
  LOG=$HOOK_HOME/approval-hook.log
  [ -f "$FACADE_ENV" ] && [ ! -L "$FACADE_ENV" ] || block "facade.env is missing from the hook home"
  [ "$("$T_stat" -c '%u %a' "$FACADE_ENV" 2>/dev/null)" = "$me 600" ] || block "facade.env is not owned by this user with mode 0600"
  ALLOW_HTTP=0
  WAIT_S=280
  MAX_TIME=25
  while IFS= read -r line || [ -n "$line" ]; do
    case $line in
      URL=*) BASE=${line#URL=} ;;
      TOKEN=*) TOKEN=${line#TOKEN=} ;;
      ALLOW_HTTP=*) ALLOW_HTTP=${line#ALLOW_HTTP=} ;;
      WAIT_S=*) WAIT_S=${line#WAIT_S=} ;;
      MAX_TIME=*) MAX_TIME=${line#MAX_TIME=} ;;
    esac
  done <"$FACADE_ENV"
  [ -n "$BASE" ] || block "facade.env carries no URL"
  [ -n "$TOKEN" ] || block "facade.env carries no TOKEN"
else
  LOG=${APPROVAL_HOOK_LOG:-${HERMES_HOME:-/opt/data}/agent-hooks/approval-hook.log}
  TMPDIR=/tmp
  export TMPDIR
  ALLOW_HTTP=${APPROVAL_FACADE_ALLOW_HTTP:-0}
  # No re-asking unless asked for: on a by-hand install the harness's entry
  # timeout is whatever that install configured, and hermes-agent 0.14.0 (the
  # Maritime template) lets the call RUN when a hook outlives it.
  WAIT_S=${APPROVAL_HOOK_WAIT_S:-0}
  MAX_TIME=${APPROVAL_HOOK_MAX_TIME:-25}
  URL_ENV=${APPROVAL_HOOK_URL_ENV:-AV_APPROVAL_URL}
  TOKEN_ENV=${APPROVAL_HOOK_TOKEN_ENV:-AV_APPROVAL_TOKEN}
  valid_name() { case $1 in ''|*[!A-Za-z0-9_]*) return 1 ;; esac; return 0; }
  valid_name "$URL_ENV" || block "APPROVAL_HOOK_URL_ENV is not a variable name"
  valid_name "$TOKEN_ENV" || block "APPROVAL_HOOK_TOKEN_ENV is not a variable name"
  eval "BASE=\${$URL_ENV:-}"
  eval "TOKEN=\${$TOKEN_ENV:-}"
  [ -n "$BASE" ] || block "$URL_ENV is not set in the hook's environment"
  [ -n "$TOKEN" ] || block "$TOKEN_ENV is not set in the hook's environment"
fi

is_int "$WAIT_S" && [ "$WAIT_S" -le 285 ] || WAIT_S=0
is_int "$MAX_TIME" && [ "$MAX_TIME" -ge 1 ] && [ "$MAX_TIME" -le 60 ] || MAX_TIME=25

# The URL and the credential go into a curl config line: nothing that could
# end the quoted value or start another option.
case $BASE in
  *[[:space:]\"\\]* | *[![:print:]]*) block "the facade URL contains a character a URL cannot" ;;
esac
case $TOKEN in
  *[[:space:]\"\\]* | *[![:print:]]*) block "the facade credential contains a character a credential cannot" ;;
esac
case $BASE in
  https://?*) PROTO='=https' ;;
  http://?*)
    [ "$ALLOW_HTTP" = "1" ] || block "the facade URL is not https (set APPROVAL_FACADE_ALLOW_HTTP=1 only for a local fake)"
    PROTO='=http,https'
    ;;
  *) block "the facade URL is not an https URL" ;;
esac
BASE=${BASE%/}

TMP=$("$T_mktemp" -d 2>/dev/null) || TMP=""
[ -n "$TMP" ] || block "cannot create a temp directory"

"$T_cat" >"$TMP/envelope" || block "cannot read the envelope from stdin"
TOOL=$("$T_node" -e 'try{const e=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const t=e&&e.tool_name;process.stdout.write(typeof t==="string"&&/^[A-Za-z0-9_.:-]{1,64}$/.test(t)?t:"?")}catch{process.stdout.write("?")}' "$TMP/envelope" 2>/dev/null)
log "start tool=${TOOL:-?}"

# Replay. node writes body.stdout and body.stderr to files and prints
# "<exit> <allow|block|wait> <code>", or a reason prefixed with "BLOCK " when
# the body is not a contract-conforming answer. `wait` is a block naming
# hook-timeout whose question is still open (the facade says NOTHING WAS
# WITHDRAWN; a deny saying the question WAS WITHDRAWN is final).
VERDICT_JS='
const fs = require("fs");
const [bodyPath, outPath, errPath] = process.argv.slice(1);
const fail = (why) => { process.stdout.write("BLOCK " + why); process.exit(0); };
let b;
try { b = JSON.parse(fs.readFileSync(bodyPath, "utf8")); } catch { fail("unparseable body"); }
if (!b || typeof b !== "object" || Array.isArray(b)) fail("body is not an object");
if (!Number.isInteger(b.exit_code) || b.exit_code < 0 || b.exit_code > 255) fail("body has no exit_code");
if (b.stdout_truncated === true || b.stderr_truncated === true) fail("truncated body");
const out = typeof b.stdout === "string" ? b.stdout : "";
const err = typeof b.stderr === "string" ? b.stderr : "";
let directive = null;
const trimmed = out.trim();
if (trimmed !== "") {
  try { directive = JSON.parse(trimmed); } catch { fail("stdout is not JSON (exit " + b.exit_code + ")"); }
  if (!directive || typeof directive !== "object" || Array.isArray(directive)) fail("stdout is not a JSON object");
}
const isBlock = directive !== null && (directive.action === "block" || directive.decision === "block");
if (b.exit_code !== 0 && !isBlock) fail("exit " + b.exit_code + " without a block directive");
fs.writeFileSync(outPath, out);
fs.writeFileSync(errPath, err);
const message = isBlock && typeof directive.message === "string" ? directive.message : "";
const code = (err.match(/"code"\s*:\s*"([A-Za-z0-9_:.-]{1,80})"/) || [])[1]
  || (message.match(/^([A-Za-z0-9_.:-]{1,80}): /) || [])[1] || "";
const waiting = isBlock && code === "hook-timeout" && !/WAS WITHDRAWN/.test(message.replace(/NOTHING WAS WITHDRAWN/g, ""));
process.stdout.write(String(b.exit_code) + " " + (waiting ? "wait" : isBlock ? "block" : "allow") + " " + code);
'

# A re-post that fails (the window's last seconds cut a request short, or the
# facade went away mid-wait) ends the wait with the facade's own last block,
# which is already a refusal: nothing on this path can turn into an allow.
# After a first post that timed out, no facade block may exist yet; then the
# transport failure itself is the block.
HAVE_LAST=0
FIRST_TIMEOUT=""
retry_failed() {
  if [ "$HAVE_LAST" != 1 ]; then
    [ -n "$FIRST_TIMEOUT" ] && block "$1 (attempt $attempt; the first post timed out and no answer has come)"
    block "$1"
  fi
  "$T_cat" "$TMP/last.out"
  "$T_cat" "$TMP/last.err" >&2
  log "outcome=block http=200 exit=$LAST_EXIT code=${LAST_CODE:--} tool=${TOOL:-?} attempt=$attempt reason=\"re-post: $1\""
  exit "$LAST_EXIT"
}

DEADLINE=$((T0 + WAIT_S * 1000))
attempt=0
while :; do
  attempt=$((attempt + 1))
  mt=$MAX_TIME
  if [ "$attempt" -gt 1 ]; then
    left=$(( (DEADLINE - $(now_ms)) / 1000 ))
    [ "$left" -lt "$mt" ] && mt=$left
    [ "$mt" -ge 1 ] || mt=1
  fi
  "$T_rm" -f "$TMP/body" "$TMP/out" "$TMP/err" "$TMP/curl.err" || block "cannot clear the previous answer"
  P0=$(now_ms)
  CODE=$(printf 'header = "X-Approval-Authorization: Bearer %s"\n' "$TOKEN" | "$T_curl" -q --config - \
    --silent --show-error --max-time "$mt" --proto "$PROTO" --proto-redir "$PROTO" \
    --request POST --header 'Content-Type: application/json' \
    --data-binary @"$TMP/envelope" \
    --output "$TMP/body" --write-out '%{http_code}' \
    "$BASE/hook/hermes" 2>"$TMP/curl.err")
  RC=$?
  if [ $RC -ne 0 ]; then
    why=$("$T_head" -c 200 "$TMP/curl.err" 2>/dev/null | "$T_tr" -d '\n"')
    # The first post ran into the ceiling: the facade may well have opened the
    # question and still be waiting on it. Re-ask, as on a hook-timeout block.
    # A clock that cannot be read measures 0 ms here, which stays final.
    if [ "$attempt" -eq 1 ] && [ $RC -eq 28 ] && [ "$WAIT_S" -gt 0 ] &&
      [ $(( $(now_ms) - P0 )) -ge $((MAX_TIME * 1000)) ]; then
      FIRST_TIMEOUT="transport failure (curl exit $RC: $why)"
      [ $(( $(now_ms) + 5000 )) -lt "$DEADLINE" ] || block "$FIRST_TIMEOUT"
      log "outcome=wait http=000 curl=$RC tool=${TOOL:-?} attempt=$attempt reason=\"first post timed out; re-asking\""
      "$T_sleep" 5
      continue
    fi
    retry_failed "transport failure (curl exit $RC: $why)"
  fi
  if [ "$CODE" != "200" ]; then
    err=$("$T_node" -e 'try{const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const c=b&&b.error&&b.error.code;process.stdout.write(typeof c==="string"?" "+c.slice(0,80):"")}catch{}' "$TMP/body" 2>/dev/null)
    retry_failed "HTTP $CODE$err"
  fi
  VERDICT=$("$T_node" -e "$VERDICT_JS" "$TMP/body" "$TMP/out" "$TMP/err" 2>/dev/null)
  case $VERDICT in
    "") retry_failed "body could not be read" ;;
    "BLOCK "*) retry_failed "${VERDICT#BLOCK }" ;;
  esac
  EXIT=${VERDICT%% *}
  rest=${VERDICT#* }
  KIND=${rest%% *}
  RCODE=${rest#* }
  [ "$KIND" = "wait" ] || break
  "$T_cat" "$TMP/out" >"$TMP/last.out" && "$T_cat" "$TMP/err" >"$TMP/last.err" || block "cannot keep the facade's answer"
  HAVE_LAST=1
  LAST_EXIT=$EXIT
  LAST_CODE=$RCODE
  # Still open. Ask again in 5 s while the window allows another attempt.
  if [ $(( $(now_ms) + 5000 )) -ge "$DEADLINE" ]; then
    KIND=block
    break
  fi
  log "outcome=wait http=200 exit=$EXIT code=${RCODE:--} tool=${TOOL:-?} attempt=$attempt"
  "$T_sleep" 5
done
unset TOKEN
"$T_cat" "$TMP/out"
"$T_cat" "$TMP/err" >&2
log "outcome=$KIND http=200 exit=$EXIT code=${RCODE:--} tool=${TOOL:-?} attempt=$attempt"
exit "$EXIT"
