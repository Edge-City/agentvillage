#!/usr/bin/env bash
# The approval.md tool clone is exactly the commit the job names, and nothing in it
# has changed (B-167N fold 2 M-D1; review-b's DELTA, CLAIMS L18777; lead RULING L18781).
#
# The check reads the pinned expected.json, and runs its own code, from this clone.
# tool-ref-on-main.sh proves the COMMIT is one approval.md main pointed at; this
# proves the FILES are that commit's: HEAD is the named sha, `git status` shows
# nothing (tracked edits, untracked and ignored files: a planted node_modules or
# module counts), and every tracked file's bytes hash to its blob in HEAD (git
# status trusts its stat cache, so a rewrite that keeps the size and the mtime
# passes it; the hash does not). approval-class-diff.sh runs it at its start and
# again right before the check, after the extractor ran overlay code.
#
# Usage: tool-intact.sh <tool checkout dir> <full sha it must be at>
# Exit: 0 intact, 1 moved or changed, 2 usage or not a checkout of its own.
set -euo pipefail

dir=${1:-}
want=${2:-}
[ -n "$dir" ] && [[ "$want" =~ ^[0-9a-f]{40}$ ]] || { echo "usage: tool-intact.sh <tool checkout dir> <full 40-hex sha>" >&2; exit 2; }
[ -d "$dir" ] || { echo "tool-intact: no directory $dir" >&2; exit 2; }
top=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null) || { echo "tool-intact: $dir is no git checkout" >&2; exit 2; }
# Its own checkout, never a directory inside another repo (the overlay's).
[ "$(cd "$top" && pwd -P)" = "$(cd "$dir" && pwd -P)" ] || { echo "tool-intact: $dir is not the top of its own checkout ($top)" >&2; exit 2; }
head=$(git -C "$dir" rev-parse --verify -q 'HEAD^{commit}') || { echo "tool-intact: $dir has no HEAD commit" >&2; exit 2; }
if [ "$head" != "$want" ]; then
  echo "::error::the approval.md tool clone moved: HEAD is $head, the job names $want (B-167N fold 2 M-D1)"
  exit 1
fi
dirty=$(git -C "$dir" status --porcelain=v1 --untracked-files=all --ignored=matching) || { echo "tool-intact: git status failed in $dir" >&2; exit 2; }
if [ -n "$dirty" ]; then
  echo "::error::the approval.md tool clone at ${want:0:12} is not clean (B-167N fold 2 M-D1): $(printf '%s' "$dirty" | head -n 5 | tr '\n' ';' | head -c 400)"
  exit 1
fi
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
git -C "$dir" ls-tree -r -z --full-tree --format='%(objectmode) %(objectname) %(path)' HEAD > "$work/tree"
tr '\0' '\n' < "$work/tree" > "$work/lines"
# Regular files only: a symlink or a submodule in the tool tree is not verified, so it fails closed.
# (grep reads a file, not a pipe: under pipefail an early grep -q exit would SIGPIPE the writer.)
if grep -Eqv '^(100644|100755) ' "$work/lines"; then
  echo "tool-intact: the tool tree holds an entry that is not a regular file; not verified" >&2
  exit 2
fi
# A path with a newline cannot go through --stdin-paths: fail closed.
if [ "$(tr -cd '\0' < "$work/tree" | wc -c)" -ne "$(wc -l < "$work/lines")" ]; then
  echo "tool-intact: a tool path holds a newline; not verified" >&2
  exit 2
fi
cut -d ' ' -f 2 "$work/lines" > "$work/want"
cut -d ' ' -f 3- "$work/lines" > "$work/paths"
(cd "$dir" && git hash-object --no-filters --stdin-paths < "$work/paths") > "$work/got" || { echo "tool-intact: hashing the tool files failed" >&2; exit 2; }
if ! cmp -s "$work/want" "$work/got"; then
  first=$(paste -d ' ' "$work/want" "$work/got" "$work/paths" | awk '$1 != $2 { $1 = ""; $2 = ""; sub(/^  /, ""); print; exit }') || true
  echo "::error::a file in the approval.md tool clone at ${want:0:12} differs from its commit (B-167N fold 2 M-D1): ${first:-?}"
  exit 1
fi
echo "tool-intact: approval.md tool clone is ${want:0:12}, clean, $(wc -l < "$work/paths" | tr -d ' ') files match their blobs"
