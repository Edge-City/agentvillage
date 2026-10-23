#!/usr/bin/env bash
# The previous release a commit is measured against (B-167 S-2; B-167N fold 1 S3 + N6,
# review-b's refute CLAIMS L18667, lead RULING L18671).
#
# A release is a tag that ONLY the Tag release button makes on an approved line:
# - its name is vX.Y.Z (no -rcN, no leading zeros, nothing after);
# - it is an annotated tag object (git tag -a, as tag-release.ts creates it) whose
#   own tag name is that name; a lightweight tag is never a release;
# - its commit is reachable from main (<main ref>, as fetched);
# - release/RC-MANIFEST.md on main (read from <main ref>, never from the commit
#   measured) has exactly one line for that version, and it names that commit.
# Of the releases below <rev>, the highest version wins (never "the nearest tag"),
# so a tag any writer pushes cannot re-baseline the check: it fails one of the
# above, and a manifest line lands on main only through a merged pull request.
#
# Usage: previous-release.sh <rev> [<main ref>, default origin/main]
# Prints "<tag> <commit>". Exit: 0 found, 1 none, 2 usage or a ref that does not resolve.
set -euo pipefail

rev=${1:-}
main=${2:-origin/main}
[ -n "$rev" ] || { echo "usage: previous-release.sh <rev> [<main ref>]" >&2; exit 2; }
rev_sha=$(git rev-parse --verify -q "$rev^{commit}") || { echo "previous-release: no commit $rev" >&2; exit 2; }
main_sha=$(git rev-parse --verify -q "$main^{commit}") || { echo "previous-release: no $main (check out with fetch-depth: 0)" >&2; exit 2; }

if ! manifest=$(git show "$main_sha:release/RC-MANIFEST.md" 2>/dev/null); then
  echo "previous-release: no release/RC-MANIFEST.md on $main" >&2
  exit 1
fi
# The approval lines: inside the one rc-manifest block, "<version> = <commit>" with an optional "# comment".
blocks=$(printf '%s\n' "$manifest" | grep -c '^```rc-manifest[[:space:]]*$' || true)
if [ "$blocks" != 1 ]; then
  echo "previous-release: release/RC-MANIFEST.md on $main has $blocks rc-manifest blocks, not one" >&2
  exit 1
fi
approved=$(printf '%s\n' "$manifest" | awk '
  /^```rc-manifest[[:space:]]*$/ { inside = 1; next }
  inside && /^```[[:space:]]*$/ { inside = 0; next }
  inside && $2 == "=" && length($3) == 40 && $3 ~ /^[0-9a-f]+$/ && (NF == 3 || $4 ~ /^#/) { print $1, $3 }
')

listed() { # <version> -> the one commit the manifest names for it, or nothing
  printf '%s\n' "$approved" | awk -v v="$1" '$1 == v { n++; c = $2 } END { if (n == 1) print c }'
}

best=""
best_sha=""
while read -r name type tagname peeledtype; do
  [ -n "$name" ] || continue
  if ! printf '%s' "$name" | grep -Eq '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'; then continue; fi
  # The commit the name resolves to, however it is tagged: the annotated-tag test
  # below is then the only thing that keeps a lightweight tag out.
  peeled=$(git rev-parse --verify -q "refs/tags/$name^{commit}") || continue
  if [ "$type" != tag ] || [ "${tagname:-}" != "$name" ] || [ "${peeledtype:-}" != commit ]; then
    echo "previous-release: skip $name (not an annotated tag of a commit)" >&2
    continue
  fi
  if ! git merge-base --is-ancestor "$peeled" "$main_sha"; then
    echo "previous-release: skip $name (not on $main)" >&2
    continue
  fi
  if [ "$(listed "$name")" != "$peeled" ]; then
    echo "previous-release: skip $name (release/RC-MANIFEST.md on $main does not name it once with ${peeled:0:12})" >&2
    continue
  fi
  if [ -z "$best" ] || [ "$(printf '%s\n%s\n' "$best" "$name" | sort -t. -k1.2,1n -k2,2n -k3,3n | tail -n 1)" = "$name" ]; then
    best=$name
    best_sha=$peeled
  fi
done < <(git for-each-ref --merged "$rev_sha" --format='%(refname:strip=2) %(objecttype) %(tag) %(*objecttype)' 'refs/tags/v*')

if [ -z "$best" ]; then
  echo "previous-release: no release below ${rev_sha:0:12} (an annotated vX.Y.Z tag on $main that release/RC-MANIFEST.md names with its commit)" >&2
  exit 1
fi
printf '%s %s\n' "$best" "$best_sha"
