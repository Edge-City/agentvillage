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
#   - DATA-234 (2026-10-02), the co-located daemon and the shim's own fatal
#     paths; the gate logic (what a facade answer means) is unchanged:
#       * by hand, the agent credential is read from the file
#         AV_APPROVAL_TOKEN_FILE names (default $HERMES_HOME/approval/agent-token
#         when that file exists), owned by this user, mode 0600, before the
#         environment variable; the value is never printed or logged;
#       * the facade URL may be `unix:<absolute socket path>` (curl
#         --unix-socket) or `http://127.0.0.1:<port>` (loopback, no
#         APPROVAL_FACADE_ALLOW_HTTP needed); before every POST to a loopback
#         URL the listener must belong to the approval daemon's uid
#         (AV_APPROVAL_DAEMON_UID, default 10001), read from /proc/net/tcp{,6},
#         and a unix socket and its directory must be that uid's; anything
#         else blocks with `facade_listener_foreign`;
#       * a variable name may not start with a digit (`${1ABC:-}` is a fatal
#         "bad substitution" that would end the shell before any directive),
#         and a clock that does not print digits reads as 0 (an arithmetic
#         error is fatal too); a clock that reads 0 at start turns re-asking
#         off.
#   - 2026-10-04, the credential's header for a LOCAL facade (unix socket or
#     loopback): `Authorization`, because there the shim talks to `approval
#     serve` itself, which reads only `Authorization` (approval-md core 0.4.0,
#     src/serve/server.ts) and answered every co-located call 401
#     serve-unauthorized; no hosted supervisor stands in between to move
#     X-Approval-Authorization across. Every other facade keeps
#     X-Approval-Authorization, as before.
#   - DATA-377 (2026-10-07), the clock: the hosted image's `date` is uutils
#     coreutils 0.8.0 on the old-checkpoint boxes, whose `%3N` drops the
#     leading zeros of the nanoseconds (a width under nine strips the padding;
#     `+%s%3N` was 16 to 19 digits, and a digit-count rule read the short
#     ones as 0, round 2 = DATA-397). now_ms() reads `+%s.%N` (`%N` is padded
#     on every build measured: GNU, uutils 0.8.0 and 0.10.0), left-pads the
#     fraction to nine digits as a defence and keeps three; ts() likewise.
#   - DATA-379 (2026-10-09), a log label and nothing else: with
#     APPROVAL_HOOK_SOURCE=prewarm (exactly that word; any other value is
#     ignored) every log line of the run carries ` source=prewarm`, so the
#     installer's pre-warm is told apart from a resident's call. It changes
#     no request, no verdict and no exit code.
#   - DATA-380 (2026-10-07), no node process on the allow and block paths
#     (node cost 32 ms warm, 135-236 ms cold, once or twice per call); what a
#     facade answer means is unchanged, byte for byte:
#       * the verdict body is read in sh when it is EXACTLY the shape the core
#         prints (approval-md src/serve/server.ts streamsBody: exit_code,
#         stdout, stderr, both *_truncated false), its strings printable ASCII
#         or the em dash with only the escapes \" \\ \n, its stdout empty,
#         {} or {"action":"block","message":"..."}, and its size the bytes
#         curl received. Every other body goes to the node parse below,
#         unchanged (VERDICT_JS), so the sh reading can only ever agree with it;
#       * the tool name for the log is read from the envelope's first bytes
#         when Hermes's own layout puts it there and "tool_name" occurs once
#         and no \u escape anywhere (grep), else by node as before;
#       * a block's message is JSON-escaped in sh when it is printable ASCII,
#         else by node as before;
#       * every outcome line in the log ends with path=fast (no node process
#         in this call) or path=node.
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
#                            only); otherwise only https://, the loopback
#                            http://127.0.0.1:<port> and unix:<path> are accepted
#   AV_APPROVAL_TOKEN_FILE   by hand: a file holding the agent credential
#                            (default $HERMES_HOME/approval/agent-token when it
#                            exists); read before the environment variable
#   AV_APPROVAL_DAEMON_UID   the uid that must own a loopback listener or a
#                            unix socket facade (default 10001, the co-located
#                            daemon's)
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
# Authorization (image/README.md); the hosted supervisor moves it back to
# Authorization on its loopback hop. A local facade (unix socket or loopback)
# is `approval serve` with no supervisor in front, which reads Authorization
# only, so there it travels as Authorization.
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
for t in curl date mktemp head tr cat rm sleep stat id node grep; do
  p=""
  for d in /usr/bin /bin /usr/local/bin; do
    if [ -x "$d/$t" ]; then p="$d/$t"; break; fi
  done
  eval "T_$t=\$p"
done

HOOK_HOME=/opt/approval/hook-home
FACADE_ENV=$HOOK_HOME/facade.env
# Where the listener table is read. Fixed here, never taken from the
# environment; the test suite substitutes this one line.
AV_PROC_ROOT=/proc

# The clock is read as SECONDS.FRACTION (`+%s.%N`), never as one run of digits
# (DATA-377 round 2 = DATA-397, b4's read of 2026-10-07): the hosted image's
# date is uutils coreutils 0.8.0 on the boxes provisioned from the old
# checkpoints, and there `%3N` drops the leading zeros of the nanoseconds (a
# width under nine strips the padding, format_modifiers.rs), so a fraction of
# 0.005567380 s came out as 7 digits and the digit-count rule that read
# `+%s%3N` (19 = ns, 16 = us, 13 = ms, 10 = s) saw an unknown length about
# 9 % of the time and answered 0. A 0 at start
# turns re-asking off (the T0 guard below), so the first wait verdict became a
# block; a 0 mid-call logged elapsed_ms as an epoch or a negative epoch. The
# separator makes the split exact on every build. Plain `%N` is padded to nine
# digits on every build measured (GNU, uutils 0.8.0 and 0.10.0; the refuter
# ran the 0.8.0 binary 1000 times); the fraction is still left-padded to nine
# as a defence against a build that trims it, and its first three digits are
# the milliseconds. The seconds
# must be digits with no leading zero (`$(( 0001791357719 - T0 ))` is an
# invalid octal constant, fatal before any directive; no real clock prints
# one) and at most 12 of them. A clock whose fraction is not one to nine
# digits (BSD date prints `%N` as the letter N) reads as 0, as before; one
# that prints seconds and no fraction at all reads as whole seconds. `$(( ))`
# never sees the raw value: every cut is on the string.
now_ms() {
  v=$("$T_date" +%s.%N 2>/dev/null) || v=0
  case $v in
    *.*) s=${v%%.*} f=${v#*.} ;;
    *) s=$v f=000000000 ;;
  esac
  case $s in '' | 0* | *[!0-9]* | ?????????????*) s="" ;; esac
  case $f in '' | *[!0-9]* | ??????????*) f="" ;; esac
  if [ -n "$s" ] && [ -n "$f" ]; then
    f=000000000$f
    f=${f#"${f%?????????}"}
    v=$s${f%??????}
  else
    v=0
  fi
  printf '%s\n' "$v"
}
# The log's timestamp: the same `%N` read, left-padded to nine digits and cut
# to its first three, so a trimmed fraction would keep its place value; a fraction that is not one to nine digits (BSD's literal N) is printed
# as the clock gave it.
ts() {
  t=$("$T_date" -u +%Y-%m-%dT%H:%M:%S.%N 2>/dev/null) && [ -n "$t" ] || return 0
  f=${t##*.}
  case $f in
    '' | *[!0-9]* | ??????????*) ;;
    *) p=000000000$f; p=${p#"${p%?????????}"}; t=${t%"$f"}${p%??????} ;;
  esac
  printf '%sZ\n' "$t"
}
T0=$(now_ms)
LOG=/dev/null
TMP=""
# path=node on the outcome line once any node process ran in this call (DATA-380).
VP=fast
# DATA-379: a label for the log lines only, from a fixed word list (never the
# raw value, so nothing an environment carries reaches the log).
case ${APPROVAL_HOOK_SOURCE:-} in
  prewarm) SRC=" source=prewarm" ;;
  *) SRC="" ;;
esac

log() {
  # Best effort: a log that cannot be written must not change the verdict.
  printf '%s pid=%s %s%s elapsed_ms=%s\n' "$(ts)" "$$" "$1" "$SRC" "$(( $(now_ms) - T0 ))" >>"$LOG" 2>/dev/null || true
}

cleanup() { [ -n "$TMP" ] && "$T_rm" -rf "$TMP"; }
trap cleanup EXIT

# JSON.stringify({action:"block",message:$1}), in sh (DATA-380), for a
# message of printable ASCII only (bytes 0x20-0x7E): there JSON.stringify
# escapes `"` and `\` and nothing else. Anything else (a control character,
# DEL, any byte above 0x7E, which node would read as UTF-8 or as U+FFFD)
# prints nothing, and the caller asks node as before. Run in a subshell:
# LC_ALL=C makes the range a byte range in bash, and the variables stay there.
block_json() {
  LC_ALL=C
  s=$1
  o=""
  case $s in *[!\ -~]*) return 1 ;; esac
  while :; do
    case $s in *[\"\\]*) ;; *) break ;; esac
    p=${s%%[\"\\]*}
    s=${s#"$p"}
    case $s in
      \"*) o=$o$p\\\" ;;
      *) o=$o$p\\\\ ;;
    esac
    s=${s#?}
  done
  printf '{"action":"block","message":"%s%s"}' "$o" "$s"
}

block() {
  # $1: reason, plain text. JSON-escaped in sh, or by node when the reason is
  # not printable ASCII; a fixed directive when node is not there, so the
  # stdout is a block even if node is gone.
  reason="approval facade unreachable: $1"
  out=""
  if [ -n "$T_node" ]; then
    out=$(block_json "$reason")
    if [ -z "$out" ]; then
      VP=node
      out=$("$T_node" -e 'process.stdout.write(JSON.stringify({action:"block",message:process.argv[1]}))' "$reason" 2>/dev/null)
    fi
  fi
  [ -n "$out" ] || out='{"action":"block","message":"approval facade unreachable"}'
  printf '%s\n' "$out"
  printf 'approval hook shim: %s\n' "$reason" >&2
  log "outcome=block-shim reason=\"$1\" path=$VP"
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
  # A leading digit is refused too: `eval "BASE=\${1ABC:-}"` is a fatal "bad
  # substitution" that ends the shell with an empty stdout.
  valid_name() { case $1 in '' | [!A-Za-z_]* | *[!A-Za-z0-9_]*) return 1 ;; esac; return 0; }
  valid_name "$URL_ENV" || block "APPROVAL_HOOK_URL_ENV is not a variable name"
  valid_name "$TOKEN_ENV" || block "APPROVAL_HOOK_TOKEN_ENV is not a variable name"
  eval "BASE=\${$URL_ENV:-}"
  [ -n "$BASE" ] || block "$URL_ENV is not set in the hook's environment"
  # The agent credential: from the file AV_APPROVAL_TOKEN_FILE names, or from
  # $HERMES_HOME/approval/agent-token when that exists (the co-located daemon's
  # control plane writes it there, hermes 0700/0600), else from $TOKEN_ENV (the
  # hosted dogfood). A named file that is missing blocks; it never falls back.
  TOKEN_FILE=${AV_APPROVAL_TOKEN_FILE:-}
  if [ -z "$TOKEN_FILE" ] && [ -n "${HERMES_HOME:-}" ] &&
    { [ -e "$HERMES_HOME/approval/agent-token" ] || [ -L "$HERMES_HOME/approval/agent-token" ]; }; then
    TOKEN_FILE=$HERMES_HOME/approval/agent-token
  fi
  if [ -n "$TOKEN_FILE" ]; then
    case $TOKEN_FILE in /*) ;; *) block "AV_APPROVAL_TOKEN_FILE is not an absolute path" ;; esac
    [ -f "$TOKEN_FILE" ] && [ ! -L "$TOKEN_FILE" ] || block "the agent token file is missing or not a regular file"
    me=$("$T_id" -u 2>/dev/null)
    [ "$("$T_stat" -c '%u %a' "$TOKEN_FILE" 2>/dev/null)" = "$me 600" ] ||
      block "the agent token file is not owned by this user with mode 0600"
    TOKEN=""
    IFS= read -r TOKEN <"$TOKEN_FILE" || [ -n "$TOKEN" ] || block "the agent token file cannot be read"
    [ -n "$TOKEN" ] || block "the agent token file is empty"
  else
    eval "TOKEN=\${$TOKEN_ENV:-}"
    [ -n "$TOKEN" ] || block "$TOKEN_ENV is not set in the hook's environment"
  fi
fi

is_int "$WAIT_S" && [ "$WAIT_S" -le 285 ] || WAIT_S=0
# No clock, no window: re-asking measures time against it.
[ "$T0" -gt 0 ] || WAIT_S=0
is_int "$MAX_TIME" && [ "$MAX_TIME" -ge 1 ] && [ "$MAX_TIME" -le 60 ] || MAX_TIME=25

# The URL and the credential go into a curl config line: nothing that could
# end the quoted value or start another option.
case $BASE in
  *[[:space:]\"\\]* | *[![:print:]]*) block "the facade URL contains a character a URL cannot" ;;
esac
case $TOKEN in
  *[[:space:]\"\\]* | *[![:print:]]*) block "the facade credential contains a character a credential cannot" ;;
esac
# Where the facade listens. A unix socket (`unix:<absolute path>`, the
# co-located daemon under APPROVALD_LISTEN=unix) is dialled with curl
# --unix-socket and a fixed http://localhost request URL. A loopback URL
# (host 127.0.0.1 or localhost) is checked before every POST: the listener
# must be the daemon's uid, since any local process can bind the port while
# the daemon is down and would receive the agent credential.
SOCK=""
LOOP_PORT=""
case $BASE in
  unix:/?*)
    SOCK=${BASE#unix:}
    SOCK=${SOCK%/}
    PROTO='=http'
    BASE=http://localhost
    ;;
  https://?*) PROTO='=https' ;;
  http://127.0.0.1:[0-9]*) PROTO='=http' ;;
  http://?*)
    [ "$ALLOW_HTTP" = "1" ] || block "the facade URL is not https (set APPROVAL_FACADE_ALLOW_HTTP=1 only for a local fake)"
    PROTO='=http,https'
    ;;
  *) block "the facade URL is not an https URL" ;;
esac
BASE=${BASE%/}
if [ -z "$SOCK" ]; then
  hostport=${BASE#*://}
  hostport=${hostport%%/*}
  case $hostport in
    127.0.0.1 | localhost) LOOP_PORT=dflt ;;
    127.0.0.1:* | localhost:*) LOOP_PORT=${hostport#*:} ;;
  esac
  if [ "$LOOP_PORT" = dflt ]; then
    case $BASE in https://*) LOOP_PORT=443 ;; *) LOOP_PORT=80 ;; esac
  fi
  # A decimal port with no leading zero: printf '%04X' would read `010` as
  # octal 8 while curl dials 10, and the listener check would look at the
  # wrong port. Refuse rather than normalise.
  case $LOOP_PORT in
    '' ) ;;
    0* | *[!0-9]* ) block "the facade URL's port is not a plain decimal port" ;;
  esac
  if [ -n "$LOOP_PORT" ]; then
    is_int "$LOOP_PORT" && [ "$LOOP_PORT" -ge 1 ] && [ "$LOOP_PORT" -le 65535 ] ||
      block "the facade URL's loopback port is not a port"
  fi
fi
AUTH_HEADER=X-Approval-Authorization
if [ -n "$SOCK$LOOP_PORT" ]; then
  DAEMON_UID=${AV_APPROVAL_DAEMON_UID:-10001}
  is_int "$DAEMON_UID" || block "AV_APPROVAL_DAEMON_UID is not a uid"
  # A local facade is `approval serve` itself, which reads Authorization only.
  AUTH_HEADER=Authorization
fi

# The listener on 127.0.0.1:$LOOP_PORT, from /proc/net/tcp and tcp6 (world
# readable; the uid column is the kernel's). Every LISTEN socket on the port
# at an address a dial of the loopback reaches (127/8, ::1, ::ffff:127/8, and
# the wildcards) must be the daemon's, and there must be one.
listener_check() {
  want=$(printf '%04X' "$LOOP_PORT")
  seen=0
  readable=0
  foreign=""
  for f in "$AV_PROC_ROOT/net/tcp" "$AV_PROC_ROOT/net/tcp6"; do
    [ -r "$f" ] || continue
    readable=1
    while read -r _sl la _ra st _q _tm _rt uid _rest; do
      [ "$st" = 0A ] || continue
      [ "${la##*:}" = "$want" ] || continue
      case ${la%:*} in
        00000000 | 7F000001 | ??????7F) ;;
        00000000000000000000000000000000 | 00000000000000000000000001000000 | 0000000000000000FFFF0000??????7F) ;;
        *) continue ;;
      esac
      seen=1
      [ "$uid" = "$DAEMON_UID" ] || foreign=$uid
    done <"$f"
  done
  [ "$readable" = 1 ] || block "facade_listener_foreign: the listener table ($AV_PROC_ROOT/net/tcp) cannot be read"
  [ "$seen" = 1 ] || block "facade_listener_foreign: nothing listens on loopback port $LOOP_PORT"
  [ -z "$foreign" ] || block "facade_listener_foreign: loopback port $LOOP_PORT is held by uid $foreign, not the approval daemon (uid $DAEMON_UID)"
}

# A unix socket facade: the socket and its directory must be the daemon's
# (the directory not writable by anyone else), so no other user can have
# replaced it.
socket_check() {
  [ -S "$SOCK" ] && [ ! -L "$SOCK" ] || block "facade_listener_foreign: the facade socket is missing or not a socket"
  [ "$("$T_stat" -c %u "$SOCK" 2>/dev/null)" = "$DAEMON_UID" ] ||
    block "facade_listener_foreign: the facade socket is not owned by the approval daemon (uid $DAEMON_UID)"
  sdir=${SOCK%/*}
  [ -n "$sdir" ] || sdir=/
  [ -d "$sdir" ] && [ ! -L "$sdir" ] || block "facade_listener_foreign: the facade socket's directory is not a directory"
  sd=$("$T_stat" -c '%u %a' "$sdir" 2>/dev/null)
  case $sd in
    "$DAEMON_UID "*[2367]? | "$DAEMON_UID "*[2367]) block "facade_listener_foreign: the facade socket's directory is writable by others" ;;
    "$DAEMON_UID "[0-7]*) ;;
    *) block "facade_listener_foreign: the facade socket's directory is not owned by the approval daemon (uid $DAEMON_UID)" ;;
  esac
}

TMP=$("$T_mktemp" -d 2>/dev/null) || TMP=""
[ -n "$TMP" ] || block "cannot create a temp directory"

"$T_cat" >"$TMP/envelope" || block "cannot read the envelope from stdin"

# The tool name, for the log only: the facade reads the envelope itself, and
# nothing here decides on it. Read in sh (DATA-380) where Hermes's own layout
# puts it: its payload is json.dumps({"hook_event_name": event, "tool_name":
# ..., ...}) (agent/shell_hooks.py _serialize_payload, key order is wire
# order), so the envelope OPENS with those two keys, Python's separators or
# compact ones. The name must already be what node's rule
# /^[A-Za-z0-9_.:-]{1,64}$/ accepts, with no escape in it. Node's JSON.parse
# keeps the LAST of duplicate keys, so the bytes "tool_name" must occur on one
# line, once, and no \u escape may occur anywhere (the one way to spell a key
# without its bytes); grep runs with LC_ALL=C so `.` crosses any byte. Every
# other envelope prints nothing here, and node reads the name as before.
# Where they can still differ: an envelope that is not JSON at all after that
# opening, where node logs `?` and this logs the opening's name; the facade
# refuses such an envelope, and the verdict never reads this name.
tool_name_sh() {
  LC_ALL=C
  export LC_ALL
  [ -n "$T_grep" ] || return 1
  h=$("$T_head" -c 160 "$TMP/envelope" 2>/dev/null) || return 1
  case $h in
    '{"hook_event_name":"'*) sp="" ;;
    '{"hook_event_name": "'*) sp=" " ;;
    *) return 1 ;;
  esac
  h=${h#'{"hook_event_name":'"$sp"'"'}
  ev=${h%%[!abcdefghijklmnopqrstuvwxyz_]*}
  [ -n "$ev" ] && [ "${#ev}" -le 32 ] || return 1
  h=${h#"$ev"}
  case $h in
    "\",$sp\"tool_name\":$sp\""*) h=${h#"\",$sp\"tool_name\":$sp\""} ;;
    *) return 1 ;;
  esac
  n=${h%%[!ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.:-]*}
  [ -n "$n" ] && [ "${#n}" -le 64 ] || return 1
  case ${h#"$n"} in '",'* | '"}'*) ;; *) return 1 ;; esac
  c=$("$T_grep" -c '"tool_name"' "$TMP/envelope" 2>/dev/null)
  [ "$c" = 1 ] || return 1
  "$T_grep" -q -e '"tool_name".*"tool_name"' -e '\\u' "$TMP/envelope" 2>/dev/null
  [ $? -eq 1 ] || return 1
  printf '%s' "$n"
}
TOOL=$(tool_name_sh)
if [ -z "$TOOL" ]; then
  VP=node
  TOOL=$("$T_node" -e 'try{const e=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const t=e&&e.tool_name;process.stdout.write(typeof t==="string"&&/^[A-Za-z0-9_.:-]{1,64}$/.test(t)?t:"?")}catch{process.stdout.write("?")}' "$TMP/envelope" 2>/dev/null)
fi
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

# The same reading in sh (DATA-380), for the one body shape the core prints
# (approval-md src/serve/server.ts streamsBody; JSON.stringify, so one line,
# keys in this order, no space):
#   {"exit_code":N,"stdout":"S","stderr":"E"[,"stdout_truncated":false,"stderr_truncated":false]}
# with S decoding to "", "{}" or {"action":"block","message":"M"}, each
# optionally followed by one newline (`approval hook hermes` prints `{}\n`
# or the block and `\n`). It prints what VERDICT_JS prints and writes the
# same two files, or prints NOTHING and writes nothing, and then node reads
# the body exactly as before. So it may decline any body, and it declines
# every body it cannot read to the byte: a size other than the bytes curl
# received (a NUL or a newline the shell would drop), a byte outside
# printable ASCII other than the em dash's three (any other non-ASCII, which
# node would decode or replace with U+FFFD), an escape other than \" \\ \n,
# a key out of order, an extra or duplicate key, a truncated stream, any
# other stdout, a non-zero exit without a block directive (node's own
# "BLOCK ..." reason then), more than 8192 bytes, or more than 512 escapes
# in a string, 64 em dashes in a string, 16 "code" or NOTHING WAS WITHDRAWN
# in the text it scans (each loop is bounded). Its string scan is
# strict JSON: a string ends at the first quote no backslash escapes, so a
# string that decodes cleanly ends exactly where the shape says, and no
# key, value or directive can hide inside it.
# Run in a subshell: LC_ALL=C makes ${#B} a byte count and the bracket ranges
# byte ranges in bash; nothing it sets leaks.
NL='
'
EM=""
# jdec <JSON string content>: sets JD to the decoded text; 1 if it is not
# within the alphabet above or holds a quote no backslash escapes.
jdec() {
  s=$1
  JD=""
  case $s in
    *[!\ -~]*)
      [ -n "$EM" ] || EM=$(printf '\342\200\224')
      t=$s
      u=""
      k=0
      while :; do
        case $t in *"$EM"*) ;; *) break ;; esac
        k=$((k + 1))
        [ "$k" -le 64 ] || return 1
        p=${t%%"$EM"*}
        u=$u$p
        t=${t#"$p"}
        t=${t#"$EM"}
      done
      case $u$t in *[!\ -~]*) return 1 ;; esac
      ;;
  esac
  k=0
  while :; do
    case $s in *\\*) ;; *) break ;; esac
    k=$((k + 1))
    [ "$k" -le 512 ] || return 1
    p=${s%%\\*}
    case $p in *\"*) return 1 ;; esac
    s=${s#"$p"}
    s=${s#?}
    case $s in
      \"*) JD=$JD$p\" ;;
      \\*) JD=$JD$p\\ ;;
      n*) JD=$JD$p$NL ;;
      *) return 1 ;;
    esac
    s=${s#?}
  done
  case $s in *\"*) return 1 ;; esac
  JD=$JD$s
}
verdict_sh() {
  LC_ALL=C
  case $SIZE in '' | *[!0-9]*) return 1 ;; esac
  [ "$SIZE" -ge 1 ] && [ "$SIZE" -le 8192 ] || return 1
  B=""
  # A newline means more than one line: not the shape (read returns 0).
  IFS= read -r B <"$TMP/body" && return 1
  [ "${#B}" -eq "$SIZE" ] || return 1
  case $B in '{"exit_code":'*) ;; *) return 1 ;; esac
  r=${B#'{"exit_code":'}
  X=${r%%[!0-9]*}
  case $X in 0 | [1-9] | [1-9][0-9] | [1-9][0-9][0-9]) ;; *) return 1 ;; esac
  [ "$X" -le 255 ] || return 1
  r=${r#"$X"}
  case $r in ',"stdout":"'*) r=${r#',"stdout":"'} ;; *) return 1 ;; esac
  S=${r%%'","stderr":"'*}
  [ "$S" != "$r" ] || return 1
  r=${r#"$S"}
  r=${r#'","stderr":"'}
  case $r in
    *'","stdout_truncated":false,"stderr_truncated":false}') E=${r%'","stdout_truncated":false,"stderr_truncated":false}'} ;;
    *'"}') E=${r%'"}'} ;;
    *) return 1 ;;
  esac
  jdec "$S" || return 1
  D=$JD
  jdec "$E" || return 1
  E=$JD
  # The directive, as JSON.parse(stdout.trim()) reads it, for three spellings.
  M=""
  BLK=0
  d=${D%"$NL"}
  case $d in
    '' | '{}') ;;
    '{"action":"block","message":"'*'"}')
      d=${d#'{"action":"block","message":"'}
      d=${d%'"}'}
      jdec "$d" || return 1
      M=$JD
      BLK=1
      ;;
    *) return 1 ;;
  esac
  [ "$X" -eq 0 ] || [ "$BLK" = 1 ] || return 1
  # code: the first `"code"\s*:\s*"<1-80 of [A-Za-z0-9_:.-]>"` in stderr
  # (\s here is a space or a newline, the only blanks in this alphabet; the
  # run of class characters after the quote is the capture, so it must be
  # 1-80 long and end at a quote), else the message's leading
  # `<1-80 of [A-Za-z0-9_.:-]>: ` (the class holds `:`, so the run up to the
  # first other character must end in `:` and be followed by a space).
  W=" $NL"
  C=""
  x=$E
  k=0
  while :; do
    case $x in *'"code"'*) ;; *) break ;; esac
    k=$((k + 1))
    [ "$k" -le 16 ] || return 1
    p=${x%%'"code"'*}
    x=${x#"$p"}
    x=${x#'"code'}
    y=${x#?}
    y=${y#"${y%%[!$W]*}"}
    case $y in :*) y=${y#:} ;; *) continue ;; esac
    y=${y#"${y%%[!$W]*}"}
    case $y in '"'*) y=${y#?} ;; *) continue ;; esac
    c=${y%%[!A-Za-z0-9_:.-]*}
    [ -n "$c" ] && [ "${#c}" -le 80 ] || continue
    case ${y#"$c"} in '"'*) C=$c; break ;; esac
  done
  if [ -z "$C" ]; then
    c=${M%%[!A-Za-z0-9_.:-]*}
    case $c in
      ?*:)
        case ${M#"$c"} in ' '*) [ "${#c}" -gt 81 ] || C=${c%:} ;; esac
        ;;
    esac
  fi
  K=allow
  if [ "$BLK" = 1 ]; then
    K=block
    if [ "$C" = hook-timeout ]; then
      # /WAS WITHDRAWN/ on the message with every NOTHING WAS WITHDRAWN cut
      # out, left to right, as String.replace with /g does.
      x=$M
      o=""
      k=0
      while :; do
        case $x in *'NOTHING WAS WITHDRAWN'*) ;; *) break ;; esac
        k=$((k + 1))
        [ "$k" -le 16 ] || return 1
        p=${x%%'NOTHING WAS WITHDRAWN'*}
        o=$o$p
        x=${x#"$p"}
        x=${x#'NOTHING WAS WITHDRAWN'}
      done
      case $o$x in *'WAS WITHDRAWN'*) ;; *) K=wait ;; esac
    fi
  fi
  printf '%s' "$D" >"$TMP/out" && printf '%s' "$E" >"$TMP/err" || return 1
  printf '%s %s %s' "$X" "$K" "$C"
}

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
  log "outcome=block http=200 exit=$LAST_EXIT code=${LAST_CODE:--} tool=${TOOL:-?} attempt=$attempt reason=\"re-post: $1\" path=$VP"
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
  # Every POST, re-asks included: the daemon may have restarted in between.
  if [ -n "$SOCK" ]; then
    socket_check
    set -- --unix-socket "$SOCK"
  else
    [ -z "$LOOP_PORT" ] || listener_check
    set --
  fi
  P0=$(now_ms)
  # `%{size_download}` is the bytes curl wrote to the body file: the sh
  # reading of the verdict compares it with what the shell read (DATA-380),
  # so it must stay the bytes IN THE FILE: never add --compressed (or any
  # option that makes curl decode what it writes) to this call; the NUL and
  # newline checks in verdict_sh stand on that equality (refuter NOTE 1).
  CODE=$(printf 'header = "%s: Bearer %s"\n' "$AUTH_HEADER" "$TOKEN" | "$T_curl" -q --config - \
    --silent --show-error --max-time "$mt" --proto "$PROTO" --proto-redir "$PROTO" "$@" \
    --request POST --header 'Content-Type: application/json' \
    --data-binary @"$TMP/envelope" \
    --output "$TMP/body" --write-out '%{http_code} %{size_download}' \
    "$BASE/hook/hermes" 2>"$TMP/curl.err")
  RC=$?
  SIZE=""
  case $CODE in
    *' '*)
      SIZE=${CODE#* }
      CODE=${CODE%% *}
      ;;
  esac
  if [ $RC -ne 0 ]; then
    why=$("$T_head" -c 200 "$TMP/curl.err" 2>/dev/null | "$T_tr" -d '\n"')
    # The first post ran into the ceiling: the facade may well have opened the
    # question and still be waiting on it. Re-ask, as on a hook-timeout block.
    # A clock that cannot be read measures 0 ms here, which stays final.
    if [ "$attempt" -eq 1 ] && [ $RC -eq 28 ] && [ "$WAIT_S" -gt 0 ] &&
      [ $(( $(now_ms) - P0 )) -ge $((MAX_TIME * 1000)) ]; then
      FIRST_TIMEOUT="transport failure (curl exit $RC: $why)"
      [ $(( $(now_ms) + 5000 )) -lt "$DEADLINE" ] || block "$FIRST_TIMEOUT"
      log "outcome=wait http=000 curl=$RC tool=${TOOL:-?} attempt=$attempt reason=\"first post timed out; re-asking\" path=$VP"
      "$T_sleep" 5
      continue
    fi
    retry_failed "transport failure (curl exit $RC: $why)"
  fi
  if [ "$CODE" != "200" ]; then
    VP=node
    err=$("$T_node" -e 'try{const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const c=b&&b.error&&b.error.code;process.stdout.write(typeof c==="string"?" "+c.slice(0,80):"")}catch{}' "$TMP/body" 2>/dev/null)
    retry_failed "HTTP $CODE$err"
  fi
  VERDICT=$(verdict_sh 2>/dev/null)
  if [ -z "$VERDICT" ]; then
    VP=node
    VERDICT=$("$T_node" -e "$VERDICT_JS" "$TMP/body" "$TMP/out" "$TMP/err" 2>/dev/null)
  fi
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
  log "outcome=wait http=200 exit=$EXIT code=${RCODE:--} tool=${TOOL:-?} attempt=$attempt path=$VP"
  "$T_sleep" 5
done
unset TOKEN
"$T_cat" "$TMP/out"
"$T_cat" "$TMP/err" >&2
log "outcome=$KIND http=200 exit=$EXIT code=${RCODE:--} tool=${TOOL:-?} attempt=$attempt path=$VP"
exit "$EXIT"
