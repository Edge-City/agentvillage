# Release manifest: the tags the Tag release button may create

The **Tag release** workflow (`.github/workflows/tag-release.yml`) creates a
tag only when this file, as it stands on `main` at the moment of the run, has
a line naming that exact version and that exact full commit id. It reads the
file from `main`, never from the commit being tagged. A dry run creates nothing
and only reports whether this file approves the plan. Ruled by Carter on
13 Oct 2026 after `v2.0.0-rc34` was cut on ungated `main` (REL-1).

**How to approve a tag.** The release seat opens a pull request that adds one
line inside the block below, for example `v2.0.0-rc35 = ` followed by the full
40-character commit id. Carter merges it after the gate. Then run Tag release
with `ref` set to that commit id and `version` set to that version (dry run
first). The commit that merges this file is not the one to tag: tag the commit
the line names, and give its full id as `ref` (not `main`, which the merge
moved).

Until `main` has branch protection and a CODEOWNERS entry for this file
(Carter's repo-admin settings), "Carter merges it" is a procedure, not
something GitHub enforces: anyone with write access could add a line.

**The form.** Inside the one `rc-manifest` block, each line is blank, a
comment starting with `#`, or `<version> = <full commit id>` with an optional
trailing ` # comment`. The version is `vX.Y.Z` or `vX.Y.Z-rcN` with no leading
zeros; the commit id is all 40 lowercase hexadecimal characters. Anything else
(no block, two blocks, an unclosed block, a short id, an unknown line, the same
version with two different commits, or an approval line outside the block,
whether plain, bulleted, numbered or a table row) makes every real run refuse
until it is fixed. The `bun test` suite checks that this file parses, so a
broken line turns the test check red on the pull request that adds it.

The hand fallback in `docs/deployment.md` ("Roll"), `git tag -a` and
`git push`, does not read this file. It is for Carter only.

```rc-manifest
# Approved tags, one per line. Keep old lines: they are the record.
```
