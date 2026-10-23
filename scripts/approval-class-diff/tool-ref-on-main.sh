#!/usr/bin/env bash
# The approval.md tool ref must be a commit approval.md main pointed at, at or above the
# floor, and the clone must be exactly that commit (B-167N fold 1 M4, review-b's refute
# CLAIMS L18667, lead RULING L18671; fold 2 S-D1 + M-D1, review-b's DELTA L18777, lead
# RULING L18781).
#
# The check compares the overlay's expected.json with the copy approval.md pins
# (scripts/overlay-recipes/expected.json, PIN_EXPECTED in its ci.yml), read from the
# tool clone. That clone's commit is chosen in this repo's test.yml, so without this
# step an overlay PR could point it at any approval.md commit carrying matching bytes.
#
# - First-parent of main (fold 2 S-D1): approval.md's merge queue merges with merge
#   commits, so every commit pushed to a PR branch that later merged is an ANCESTOR of
#   main (1828 of 2519 on 2026-10-21; review-b's 34741830 passed fold 1). Only main's
#   first-parent line is the states main itself held: a merge result the queue built
#   and tested, never an intermediate branch commit whose bytes no reviewer saw as a
#   whole. (A queue group of several PRs also puts its in-between merge results on
#   that line; each is main plus reviewed PRs, built by the queue.)
# - The floor (fold 2 S-D1): an older main commit carries an older pinned copy and an
#   older check. floor_default is approval.md v0.4.7's commit (release 0.4.7, #667),
#   main's head when this was written; move it to the commit that merges #668 when the
#   ref moves there.
# - Intact (fold 2 M-D1): tool-intact.sh, so a clone whose files were changed after
#   checkout (review-b: a dirty tree on a main commit passed fold 1) fails here.
#
# Ancestry is read with git over the fixed https URL, not the GitHub compare API: the
# API answers ancestry only (which the first-parent test implies) and cannot tell a
# queue-branch commit from a main state.
#
# Usage: tool-ref-on-main.sh <tool clone dir> [<approval.md repo url> <floor sha>]
#   (the URL and the floor are for this repo's tests; the job passes the dir alone)
# Exit: 0 on main's first-parent line at or above the floor, 1 not (or the clone was
#   changed), 2 usage, a floor that is no main state, or a fetch that failed.
set -euo pipefail

floor_default=eaa762237b6d8303ca791f70dcf9d6831dece5aa
dir=${1:-}
url=${2:-https://github.com/approval-md/approval.md.git}
floor=${3:-$floor_default}
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
[ -n "$dir" ] || { echo "usage: tool-ref-on-main.sh <tool clone dir> [<approval.md repo url> <floor sha>]" >&2; exit 2; }
ref=$(git -C "$dir" rev-parse --verify -q 'HEAD^{commit}') || { echo "tool-ref-on-main: $dir is no git checkout" >&2; exit 2; }
bash "$here/tool-intact.sh" "$dir" "$ref"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
git -C "$work" init -q
# Commits only (no trees, no blobs): enough to walk main's history.
if ! git -C "$work" fetch -q --no-tags --filter=tree:0 "$url" +refs/heads/main:refs/remotes/approval-md/main 2>"$work/fetch.err"; then
  echo "tool-ref-on-main: could not fetch approval.md main from $url: $(head -c 400 "$work/fetch.err")" >&2
  exit 2
fi
main_sha=$(git -C "$work" rev-parse refs/remotes/approval-md/main)
# Into a file, then grep: under pipefail an early grep -q exit would SIGPIPE rev-list.
git -C "$work" rev-list --first-parent refs/remotes/approval-md/main > "$work/first-parent"
grep -qx "$floor" "$work/first-parent" || { echo "tool-ref-on-main: the floor $floor is not a commit approval.md main pointed at (${main_sha:0:12})" >&2; exit 2; }
if ! grep -qx "$ref" "$work/first-parent"; then
  echo "::error::the approval.md tool ref $ref is not on approval.md main's first-parent line (${main_sha:0:12}): it must be a state main held (a merge result), never an unmerged or merge-queue branch commit. Move the ref in test.yml to such a commit (B-167N fold 2 S-D1)."
  exit 1
fi
if ! git -C "$work" merge-base --is-ancestor "$floor" "$ref" 2>/dev/null; then
  echo "::error::the approval.md tool ref $ref is older than the floor ${floor:0:12} (scripts/approval-class-diff/tool-ref-on-main.sh floor_default): an older main state carries an older pinned copy and check (B-167N fold 2 S-D1)."
  exit 1
fi
echo "tool-ref-on-main: approval.md tool ref $ref is on approval.md main's first-parent line (${main_sha:0:12}), at or above the floor ${floor:0:12}"
