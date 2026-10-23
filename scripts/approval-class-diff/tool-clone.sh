#!/usr/bin/env bash
# A fresh clone of approval.md at exactly the commit the class-diff job names, in a
# directory the overlay checkout does not contain (B-167N fold 2 M-D1; lead RULING L18781).
#
# Before this fold the tool was an actions/checkout inside the workspace, which the
# PR's own code could reach and rewrite (review-b: a root package.json postinstall
# overwrote the pinned expected.json; a bunfig.toml preload ran inside the gate).
# Here the job clones into $RUNNER_TEMP, nothing is installed in the clone (its gate
# scripts import only node: builtins and each other; the core comes from npm with
# --ignore-scripts), and tool-intact.sh proves it unchanged at the ref check and
# again right before the check.
#
# Usage: tool-clone.sh <full 40-hex sha> <new directory> [<approval.md repo url>]
# Exit: 0 cloned and intact, 2 usage, an existing directory, or a fetch that failed.
set -euo pipefail

ref=${1:-}
dir=${2:-}
url=${3:-https://github.com/approval-md/approval.md.git}
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
[[ "$ref" =~ ^[0-9a-f]{40}$ ]] && [ -n "$dir" ] || { echo "usage: tool-clone.sh <full 40-hex sha> <new directory> [<approval.md repo url>]" >&2; exit 2; }
[ ! -e "$dir" ] || { echo "tool-clone: $dir already exists; the tool is always a fresh clone" >&2; exit 2; }
mkdir -p "$dir"
git -C "$dir" init -q
if ! git -C "$dir" fetch -q --depth=1 --no-tags "$url" "$ref" 2>"$dir/.git/fetch.err"; then
  echo "tool-clone: could not fetch $ref from $url: $(head -c 400 "$dir/.git/fetch.err")" >&2
  exit 2
fi
git -C "$dir" -c advice.detachedHead=false checkout -q --detach FETCH_HEAD
bash "$here/tool-intact.sh" "$dir" "$ref" || exit 2
