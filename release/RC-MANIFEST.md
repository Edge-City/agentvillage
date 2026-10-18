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
v2.0.0-rc36 = 93b77aaf24a5edcec8ba82e85135d750ba9b7adb # rc35 + ov#310 + ov#299 + ov#311; checks 1-5 by release 13 Oct
v2.0.0-rc37 = c941c9b07b50da7b8b14761523f09a64370803ee # owner-only mini-app canary; ov#312
v2.0.0-rc38 = c48353be287948cf64b4415f2e2e92ffb5f516da # rc36 + ov#321 + ov#320 + ov#322 + ov#317 + ov#314 (+ ov#316/#318 tooling, refs sync); checks by release 14 Oct
v2.0.0-rc39 = 5bd9c0537a997b10bfdd9832d04faa737d4d06eb # rc38 + ov#325 (DATA-454 directory, fail-soft until the server side is live); checks by release 14 Oct
v2.0.0-rc40 = 396f9f4dd3c3b3bf76bf9fb905e8caad1e25579b # rc39 + ov#324 (AGENTS.md trim; ships at 18,086 chars, not the 17,945 its title says) + ov#327 + ov#331 + ov#330 (SEC-6 slash access) + ov#329 (SEC-3 inventory, report mode); checks by release 14 Oct
v2.0.0-rc41 = 0ade804d450dfd0975fb6b53a15240ead6ed7972 # rc40 + ov#333 + ov#328 + ov#334 + ov#336 + ov#339 (av-approval 0.5.0 model observer) + ov#340 + ov#342 (DATA-454b) + ov#341 (dark pray + ask_village) + ov#343 (mini-apps re-cut, village-bridge 1.2.0) + ov#347 (EVENTS-NOW) + ov#346 (EdgeOS curl guard) + ov#348 (CLOCK-1 Now line) + ov#337 (PROMPT-FIT) + ov#350 (BRIDGE-RESTORE); workspace/AGENTS.md 18,885 chars; checks by release 14 Oct
v2.0.0-rc42 = 49ec127a426b0719f7d480101c48d9a3b58ab761 # rc41 + ov#345 (rc41 line) + ov#351 (SKYLIGHT LOOKUP) + ov#353 (ask_village findable) + ov#354 (F1 prompt refresh) + ov#352 (compression 0.75) + ov#357 (code exec on, 35/551d13e3) + ov#355 (rolodex.person, 9-op gold-stars) + ov#358 (av-vote 0.1.1) + ov#356 (directory fallback, av-display 0.3.0) + ov#359 (village-memory, dark); workspace/AGENTS.md 19,785 chars; checks by float 15 Oct
v2.0.0-rc43 = 88e7b57886217947ca9752ccf5e0979643ebc93b # rc42 + ov#362 (rc42 line) + ov#361 (search_village) + ov#363 (query_village, read-only SQL) + ov#360 (code-exec stopgaps: shim digest, gate.unverified@1 event, approval skill line) + ov#364 (agent + plugin links -> /intents-v2) + ov#365 (MoralMod pin -> fbf4b832, moralmod-a7515c6); workspace/AGENTS.md 19,861 B; checks by release 16 Oct
v2.0.0-rc44 = c9970dcd327d246164413eea9f807880889753ca # rc43 + ov#366 (rc43 line) + ov#367 (rolodex skill: add X = met) + ov#368 (Turkish I) + ov#369 (NEW-03 bridge ops) + ov#370 (HOT-01 bridge star_approval_required) + ov#372 (OV-GATE-RECOVERED) + ov#373 (Index links -> V2 / /intro alias) + ov#374 (RESIDENT-UX: /village, memory_notifications off, av-display 0.4.0) + ov#376 (MoralMod loader startup catch names its error) + ov#377 (Resident UX follow-up: first-contact range pin, AV_DISPLAY_DEFAULTS=0); workspace/AGENTS.md 19,936 B; checks by release 17 Oct (re-cut)
v2.1.0 = e1891a8bf6a38819bf54c621b9f112f3d42c0de7 # rc44 content (ov#366..ov#377, never tagged or rolled) + ov#375 (rc44 line) + ov#380 (R-DEON: village tools always visible to tool_search; AGENTS.md ask_village line) + ov#381 (MoralMod pin -> ce0d6a9e, release moralmod-175573a-ce0d6a9e35f4) ; workspace/AGENTS.md 19,962 chars ; first plain tag (RM-VERSION, Carter L10169) ; checks by release 17 Oct
v2.1.1 = 1104602821bc8f772a34cec8e9b96412546c46af # v2.1.0 (e1891a8b) + ov#385 (B-49 AGENTS.md trim) + ov#387 (B-120 ask_village withheld wording) + ov#386 (MoralMod pin -> ce30a04f, release moralmod-0586c2f-ce30a04f937b, source 0586c2f4) + ov#388 (B-133 Gold Stars member class marketplace.app.action.gold-stars.send, autonomous template row; cp#303 live first) ; workspace/AGENTS.md 18,645 chars (18,681 bytes), headroom 1,341 under the 19,986 hard limit ; checks by release 18 Oct
```
