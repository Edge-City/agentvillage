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
# B-167N NEW-CALLS (Carter L17349, L17375; spec approval L17350; folds P1-P7):
# every call that is NEW or CHANGED against the previous release (shell recipes,
# and the harness-tool envelopes the extractor derives from the mini-app
# manifests and the gated plugin tools) needs its outcome declared in
# scripts/approval-class-diff/expected.json, and the same hook, under the village
# default template and in each settings cell, must give exactly it. An undeclared
# new call, a class or decision other than declared, a technical card, a stale
# or duplicate entry, or a limiting entry without Carter's acceptance fails.
#
# Usage: scripts/approval-class-diff.sh <base ref>
#   AV_APPROVAL_MD_TOOL_DIR  approval.md checkout holding the two scripts (required)
#   AV_APPROVAL_MD_TOOL_REF  the full sha that checkout must be at (required; B-167N fold 2 M-D1).
#                            The script proves the checkout is that commit, clean and byte-identical
#                            (scripts/approval-class-diff/tool-intact.sh) at its start and again right
#                            before the check. `unverified` skips that, for fixture copies and local runs only.
#   AV_CLASS_DIFF_OUT        report directory (default ./class-diff)
#   AV_CLASS_DIFF_HEAD_REF   classify this ref's tree instead of the working tree
#   AV_CLASS_DIFF_OLD_PIN / AV_CLASS_DIFF_NEW_PIN   override a pin (replays, tests)
#   AV_CLASS_DIFF_CORES      reuse npm core installs under this directory (tests)
#   AV_CLASS_DIFF_ALLOWLIST  another allowlist (tests)
#   AV_CLASS_DIFF_BOX_CONCURRENCY  hook runs at once per box (default 1; CI sets 4)
#   AV_CLASS_DIFF_HARNESS_ONLY     tests only: limit the harness envelopes to these tools
#   AV_CLASS_DIFF_EXPECTED   another expected.json (tests)
#   AV_NEW_CALLS_BASE_REF    the previous release the new-calls check measures against (P3;
#                            the class-diff job passes the previous release, found by
#                            scripts/approval-class-diff/previous-release.sh; default: <base ref>)
#   AV_NEW_CALLS_PENDING_ACCEPTANCE  fail (default) or warn. warn (test.yml sets it on every event but
#                            a pull request) passes a run whose ONLY findings are an undated
#                            acceptance on calls unchanged since the previous release, with a
#                            warning (B-167N fold 1 S2; scripts/approval-class-diff/pending-acceptance.ts)
#
# B-167N fold 2 M-D1 (review-b's DELTA L18777; lead RULING L18781): no overlay config
# reaches the tool. bun runs only through tbun: from the tool clone's directory (bun
# reads bunfig.toml, .env and tsconfig.json from its cwd, so an overlay bunfig.toml
# preload ran inside every extractor call before), with an empty config, an empty
# tsconfig and no .env, and no BUN_OPTIONS / BUN_CONFIG_* / NODE_OPTIONS from the
# environment. The overlay code the extractor imports on purpose
# (install/install_index.ts and its imports) is code-owned instead (.github/CODEOWNERS).
# Exit: 0 pass, 1 a blocking flip / held recipe / stale allowlist entry, 2 setup.
set -euo pipefail
unset BUN_OPTIONS NODE_OPTIONS
while IFS= read -r v; do unset "$v"; done < <(compgen -e | grep '^BUN_CONFIG_' || true)

repo=$(git rev-parse --show-toplevel)
base=${1:?usage: scripts/approval-class-diff.sh <base ref>}
tool=${AV_APPROVAL_MD_TOOL_DIR:?AV_APPROVAL_MD_TOOL_DIR must name an approval.md checkout}
tool_ref=${AV_APPROVAL_MD_TOOL_REF:?AV_APPROVAL_MD_TOOL_REF must name the full sha of that checkout (or unverified, for fixture copies)}
out=${AV_CLASS_DIFF_OUT:-$repo/class-diff}
pin_file=scripts/tests/fetch-url-shape.test.ts
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

die() { echo "approval-class-diff: $*" >&2; exit 2; }
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
pending=${AV_NEW_CALLS_PENDING_ACCEPTANCE:-fail}
case "$pending" in fail | warn) ;; *) die "AV_NEW_CALLS_PENDING_ACCEPTANCE must be fail or warn, not $pending" ;; esac
# The trees the extractor reads: recipes (skills, workspace, install) and, for the
# new-calls envelopes, the mini-app manifests and the plugins (mini-apps is absent
# before Mini-apps v1; plugins is always there).
trees() { local t; for t in skills workspace install mini-apps plugins; do git -C "$repo" cat-file -e "$1:$t" 2>/dev/null && printf '%s\n' "$t"; done; return 0; }
pin_of() { sed -n 's/^export const APPROVAL_MD_PINNED = "\([0-9][0-9A-Za-z.+-]*\)";$/\1/p'; }

for f in overlay-recipes-extract.mjs overlay-recipes-check.mjs overlay-recipes-box.mjs overlay-recipes-newcalls.mjs; do
  [ -f "$tool/scripts/$f" ] || die "no $tool/scripts/$f"
done
tool=$(cd "$tool" && pwd -P)
verify_tool() {
  if [ "$tool_ref" = unverified ]; then
    echo "approval-class-diff: tool checkout NOT verified ($1): AV_APPROVAL_MD_TOOL_REF=unverified (fixtures and local runs only)" >&2
    return 0
  fi
  bash "$here/approval-class-diff/tool-intact.sh" "$tool" "$tool_ref" >&2 || die "the approval.md tool checkout is not ${tool_ref:0:12} as cloned ($1); nothing it says is trusted (B-167N fold 2 M-D1)"
}
verify_tool "at the start"
mkdir -p "$work/empty"
: > "$work/empty/bunfig.toml"
echo '{}' > "$work/empty/tsconfig.json"
tbun() { (cd "$tool" && exec bun --config="$work/empty/bunfig.toml" --tsconfig-override="$work/empty/tsconfig.json" --no-env-file "$@"); }

base_sha=$(git -C "$repo" rev-parse --verify "$base^{commit}") || die "no commit $base"
if [ -n "${AV_CLASS_DIFF_HEAD_REF:-}" ]; then
  head_sha=$(git -C "$repo" rev-parse --verify "$AV_CLASS_DIFF_HEAD_REF^{commit}") || die "no commit $AV_CLASS_DIFF_HEAD_REF"
  mkdir -p "$work/head"
  git -C "$repo" archive "$head_sha" $(trees "$head_sha") | tar -x -C "$work/head"
  mkdir -p "$work/head/$(dirname "$pin_file")"
  git -C "$repo" show "$head_sha:$pin_file" > "$work/head/$pin_file" 2>/dev/null || true
  mkdir -p "$work/head/scripts/approval-class-diff"
  git -C "$repo" show "$head_sha:scripts/approval-class-diff/expected.json" > "$work/head/scripts/approval-class-diff/expected.json" 2>/dev/null || rm -f "$work/head/scripts/approval-class-diff/expected.json"
  head_tree="$work/head"
else
  head_sha=$(git -C "$repo" rev-parse HEAD)
  head_tree="$repo"
fi
mkdir -p "$work/base"
git -C "$repo" archive "$base_sha" $(trees "$base_sha") | tar -x -C "$work/base"
tag_ref=${AV_NEW_CALLS_BASE_REF:-$base}
tag_sha=$(git -C "$repo" rev-parse --verify "$tag_ref^{commit}") || die "no commit $tag_ref (AV_NEW_CALLS_BASE_REF)"
if [ "$tag_sha" != "$base_sha" ]; then
  mkdir -p "$work/tag"
  git -C "$repo" archive "$tag_sha" $(trees "$tag_sha") | tar -x -C "$work/tag"
fi

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

tbun "$tool/scripts/overlay-recipes-extract.mjs" --overlay "$head_tree" --sha "$head_sha" --out "$work/corpus-head.json" --with-envelopes >&2
tbun "$tool/scripts/overlay-recipes-extract.mjs" --overlay "$work/base" --sha "$base_sha" --out "$work/corpus-base.json" --with-envelopes >&2
if [ "$tag_sha" = "$base_sha" ]; then
  cp "$work/corpus-base.json" "$work/corpus-tag.json"
else
  tbun "$tool/scripts/overlay-recipes-extract.mjs" --overlay "$work/tag" --sha "$tag_sha" --out "$work/corpus-tag.json" --with-envelopes >&2
fi
expected=${AV_CLASS_DIFF_EXPECTED:-$head_tree/scripts/approval-class-diff/expected.json}
[ -f "$expected" ] || die "no $expected (B-167N: every new call's declared outcome)"
echo "new-calls: measured against $tag_ref (${tag_sha:0:12}); expectations $(basename "$(dirname "$expected")")/$(basename "$expected")"

mkdir -p "$out"
# The boxes live outside /tmp on a runner: core treats /tmp as a scratch root,
# and a box there would be judged more loosely than /home/hermes is.
boxes="${RUNNER_TEMP:-$work}/class-diff-boxes"
mkdir -p "$boxes"
# The extractor ran overlay code (install/install_index.ts): prove the tool unchanged
# immediately before the check reads its pinned expected.json and runs its own code.
verify_tool "right before the check"
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
  --expected "$expected" --tag-corpus "$work/corpus-tag.json" --tag-label "$tag_ref (${tag_sha:0:12})" \
  --md "$out/class-diff.md" --diff-json "$out/class-diff.json" 2>"$work/check.err"
status=$?
cat "$work/check.err" >&2
set -e
# B-167N fold 1 S2: on main's push run and a Tag release call, an undated acceptance on a
# call unchanged since the previous release warns instead of halting every release; any
# other finding, or a pending acceptance on a NEW or CHANGED call, still fails.
if [ "$status" = 1 ] && [ "$pending" = warn ]; then
  if tbun "$here/approval-class-diff/pending-acceptance.ts" --json "$out/class-diff.json" --stderr "$work/check.err" >"$work/pending.txt"; then
    cat "$work/pending.txt"
    { echo; sed 's/^::warning:://' "$work/pending.txt"; } >>"$out/class-diff.md"
    status=0
  else
    cat "$work/pending.txt" >&2
  fi
fi
exit "$status"
