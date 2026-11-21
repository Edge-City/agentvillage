#!/usr/bin/env bash
# CLASS-DIFF of this overlay's shipped calls between the approval.md core the
# base pins and the core this tree pins (B-167 release gate, lead ruling
# CLAIMS L15681 (1); EDGEOS-BLOCK).
#
# One source of truth: the extractor and the check are approval.md's own
# (scripts/overlay-recipes-extract.mjs, scripts/overlay-recipes-check.mjs,
# approval-md#663 + the B-167 PR), checked out at a pinned commit and named by
# AV_APPROVAL_MD_TOOL_DIR. Nothing of them is copied here.
#
# The pin: APPROVAL_MD_PINNED in scripts/tests/fetch-url-shape.test.ts, the
# core the boxes run (the control plane's APPROVAL_MD_VERSION). The old pin is
# that constant at the base ref, the new pin is it in this tree, and each core
# is installed from npm (registry integrity, printed in the report). A PR that
# moves the pin shows every call whose class, decision or card style moves and
# fails when an existing call moves from auto, sampled or card to human-only
# or refused, unless scripts/approval-class-diff/allowlist.json names it with
# a reason. The same run is approval.md's corpus check at the new pin: a recipe
# (new or old) that resolves human-only there fails unless allowlisted.
#
# Every call runs through each core's REAL `approval hook hermes` in a box
# layout (approval.md's scripts/overlay-recipes-box.mjs, B-167 fold 1): recipes
# as terminal calls at $HERMES_HOME, $HOME and workspace, harness calls as Hermes
# tool envelopes. Besides the diff, any shipped recipe the hook denies in the box
# (human-only or refused) fails unless the allowlist lists it with Carter's
# acceptance, so a recipe EDIT into a denied shape fails too (ov#427 replayed).
#
# Usage: scripts/approval-class-diff.sh <base ref>
#   AV_APPROVAL_MD_TOOL_DIR  approval.md checkout holding the two scripts (required)
#   AV_CLASS_DIFF_OUT        report directory (default ./class-diff)
#   AV_CLASS_DIFF_HEAD_REF   classify this ref's tree instead of the working tree
#   AV_CLASS_DIFF_OLD_PIN / AV_CLASS_DIFF_NEW_PIN   override a pin (replays, tests)
#   AV_CLASS_DIFF_CORES      reuse npm core installs under this directory (tests)
#   AV_CLASS_DIFF_ALLOWLIST  another allowlist (tests)
#   AV_CLASS_DIFF_BOX_CONCURRENCY  hook runs at once per box (default 1; CI sets 4)
#   AV_CLASS_DIFF_HARNESS_ONLY     tests only: limit the harness envelopes to these tools
# Exit: 0 pass, 1 a blocking flip / held recipe / stale allowlist entry, 2 setup.
set -euo pipefail

repo=$(git rev-parse --show-toplevel)
base=${1:?usage: scripts/approval-class-diff.sh <base ref>}
tool=${AV_APPROVAL_MD_TOOL_DIR:?AV_APPROVAL_MD_TOOL_DIR must name an approval.md checkout}
out=${AV_CLASS_DIFF_OUT:-$repo/class-diff}
pin_file=scripts/tests/fetch-url-shape.test.ts
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

die() { echo "approval-class-diff: $*" >&2; exit 2; }
pin_of() { sed -n 's/^export const APPROVAL_MD_PINNED = "\([0-9][0-9A-Za-z.+-]*\)";$/\1/p'; }

for f in overlay-recipes-extract.mjs overlay-recipes-check.mjs overlay-recipes-box.mjs; do
  [ -f "$tool/scripts/$f" ] || die "no $tool/scripts/$f"
done

base_sha=$(git -C "$repo" rev-parse --verify "$base^{commit}") || die "no commit $base"
if [ -n "${AV_CLASS_DIFF_HEAD_REF:-}" ]; then
  head_sha=$(git -C "$repo" rev-parse --verify "$AV_CLASS_DIFF_HEAD_REF^{commit}") || die "no commit $AV_CLASS_DIFF_HEAD_REF"
  mkdir -p "$work/head"
  git -C "$repo" archive "$head_sha" skills workspace install | tar -x -C "$work/head"
  mkdir -p "$work/head/$(dirname "$pin_file")"
  git -C "$repo" show "$head_sha:$pin_file" > "$work/head/$pin_file" 2>/dev/null || true
  head_tree="$work/head"
else
  head_sha=$(git -C "$repo" rev-parse HEAD)
  head_tree="$repo"
fi
mkdir -p "$work/base"
git -C "$repo" archive "$base_sha" skills workspace install | tar -x -C "$work/base"

new_pin=${AV_CLASS_DIFF_NEW_PIN:-$(pin_of < "$head_tree/$pin_file")}
old_pin=${AV_CLASS_DIFF_OLD_PIN:-$(git -C "$repo" show "$base_sha:$pin_file" 2>/dev/null | pin_of || true)}
[ -n "$new_pin" ] || die "no APPROVAL_MD_PINNED in $pin_file"
# A base from before the pin existed compares against the new pin itself.
[ -n "$old_pin" ] || old_pin=$new_pin
echo "approval.md core: base pin $old_pin -> this pin $new_pin; overlay ${base_sha:0:12} -> ${head_sha:0:12}"

cores=${AV_CLASS_DIFF_CORES:-$work}
install_core() {
  local version=$1 dir="$cores/core-$1"
  if [ -f "$dir/node_modules/approval-md/package.json" ]; then return 0; fi
  mkdir -p "$dir"
  printf '{"name":"core-%s","private":true}\n' "$version" > "$dir/package.json"
  (cd "$dir" && npm install --no-audit --no-fund --ignore-scripts --loglevel=error "approval-md@$version") >&2 || die "npm install approval-md@$version failed"
  echo "approval-md@$version integrity $(node -p 'const p = require(process.argv[1]).packages; p[Object.keys(p).find((k) => k.endsWith("node_modules/approval-md"))].integrity' "$dir/package-lock.json")" >&2
}
install_core "$new_pin"
[ "$old_pin" = "$new_pin" ] || install_core "$old_pin"

bun "$tool/scripts/overlay-recipes-extract.mjs" --overlay "$head_tree" --sha "$head_sha" --out "$work/corpus-head.json" >&2
bun "$tool/scripts/overlay-recipes-extract.mjs" --overlay "$work/base" --sha "$base_sha" --out "$work/corpus-base.json" >&2

mkdir -p "$out"
# The boxes live outside /tmp on a runner: core treats /tmp as a scratch root,
# and a box there would be judged more loosely than /home/hermes is.
boxes="${RUNNER_TEMP:-$work}/class-diff-boxes"
mkdir -p "$boxes"
set +e
node "$tool/scripts/overlay-recipes-check.mjs" \
  --corpus "$work/corpus-head.json" \
  --core "$cores/core-$new_pin/node_modules/approval-md" \
  --allowlist "${AV_CLASS_DIFF_ALLOWLIST:-$repo/scripts/approval-class-diff/allowlist.json}" \
  --overlay-tree "$head_tree" --baseline-overlay-tree "$work/base" --box-root "$boxes" \
  --box-concurrency "${AV_CLASS_DIFF_BOX_CONCURRENCY:-1}" \
  ${AV_CLASS_DIFF_HARNESS_ONLY:+--harness-only "$AV_CLASS_DIFF_HARNESS_ONLY"} \
  --diff "$cores/core-$old_pin/node_modules/approval-md" \
  --baseline-corpus "$work/corpus-base.json" \
  --core-label "npm approval-md@$new_pin (this tree's pin)" \
  --baseline-label "npm approval-md@$old_pin (the base's pin)" \
  --md "$out/class-diff.md" --diff-json "$out/class-diff.json"
status=$?
set -e
exit "$status"
