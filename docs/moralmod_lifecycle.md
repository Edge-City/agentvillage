# MoralMod managed Index lifecycle (connected internal MVP)

This installer path runs the shared Decision Studio bundle **inside the existing per-resident Hermes sidecar**. Index credentials remain in Village. Hermes supplies the model bridge; Decision Service receives signed opaque requests and owns scientific execution and durable continuation. It runs for **MoralMod ON residents only** (`AV_MORALMOD_ARM=on`, read from `$HERMES_HOME/.env` first), and only for the release pinned in this repo (see [The release pin](#the-release-pin)).

Supply `MORALMOD_RELEASE_DIR` (reviewed `build:village` output) and `MORALMOD_RESIDENT_CONFIG` (a local 0600 JSON file) to the existing installer. The configuration has:

```json
{
  "DECISION_SERVICE_URL": "https://decision-service.example",
  "DECISION_EXPERIMENT_ID": "<experiment UUID>",
  "DECISION_INPUT_KIND": "synthetic",
  "DECISION_RUNTIME_REVISION": "<service-approved release identifier>",
  "VILLAGE_CONTROL_PLANE_URL": "https://control-plane.example",
  "VILLAGE_SUBJECT_REF": "mm_<opaque 32 hex subject>",
  "VILLAGE_INSTALLATION_CREDENTIAL": "<resident-scoped credential>"
}
```

## Arms

For a resident whose arm is off, unset, blank or anything but `on`, these files change nothing (OV-249 post-hoc M1). Whether they are in the installer environment or an earlier ON run left `index/moralmod/active.json`, the installer takes the ordinary OFF path:

- the `index-network` plugin is not in `plugins.enabled`;
- its `Index morning` cron job and launcher are removed;
- no `index/negotiator.ts` is written;
- no release is installed under `index/moralmod/`;
- every managed asset an earlier ON run left is removed (ov#277 refute S2, ov#284 refute M1), in this order:
  1. `index/moralmod/resident.json`, which holds the resident credential;
  2. the managed loader over the plugin's `runtime/dist/negotiator.js`: the plugin's own file is put back from its checkout at the pinned revision, or, without that checkout, the loader is deleted;
  3. `index/negotiator.ts`, when it is exactly the managed marker;
  4. the plugin's `morning.py`, when it is exactly the managed rewrite: the plugin's own file is put back from its checkout at the pinned revision;
  5. `index/moralmod/active.json`;
  6. each installed release directory `index/moralmod/<64 hex>/` that holds only release files: the bundle files, then `release.json`, then the empty directory.

Each step is decided on that file's own bytes or name, never on the loader's hash, so a step still runs when an earlier one already happened: an interrupted OFF run, or the control plane's `clean`, is finished by the next OFF run, and a second OFF run changes nothing. A release directory with any other file in it is left whole. `fallback.sqlite`, journals and queued evidence, staging directories, the control plane's `sources/` and `provisioned.json`, a resident config outside `index/moralmod/`, and the resident's own files stay.

The run prints `→ index-network plugin: off (AV_MORALMOD_ARM is not on); MoralMod release or resident config present, not activated: the managed negotiator runs only for ON`, followed by `; managed loader removed` (or `replaced by the plugin's own negotiator.js`) when it took one out and `; MoralMod files cleaned up: <names>` when it removed or put back others. `av-events/install-status.json` gets `index_plugin_note: "moralmod_arm_not_on"` and `index_plugin_failed: null`, or `moralmod_cleanup` when a managed file could not be removed (a warning line names it).

This holds from the first install after an ON-to-OFF flip. A flip through the control plane's arm PATCH only rewrites `.env` and restarts the gateway; until the next install runs, the box keeps what the last install left. A later ON run re-activates from the `MORALMOD_*` it is handed.

Use `live` only for the explicitly authorized live experiment. The installer does not allocate an arm. The CP must already have an enrollment, saved assignment, registered installation/agent/epoch and a resident credential. Decision Service must trust its issuer/JWKS/client and allow the resident scopes `negotiations:manage_self`, `runs:create_self`, `runs:read_authorized`, and `contexts:write_self` for the approved experiment. Permissions still control each operation; OFF residents do not run this runtime.

The release pins Index source, Hermes plugin `04d833b840541fedabe78cbdad306c18853d784a` and Bun 1.4.2. It verifies every bundle digest, refuses resident custom hooks or modified managed files, and atomically writes the scoped config and runtime entrypoint. Once `active.json` exists, the plugin's `runtime/dist/negotiator.js` counts as unmodified when it is the loader `active.json` records or the plugin's own file at the pinned revision; a Hermes reinstall (a plugin bump, any `--force`) and an OFF run put the plugin's own file back, so the next ON install activates over it rather than withholding the plugin (ov#282 M1). Any other content is refused and left as it is. An existing plugin on another revision requires an explicit migration; there is no floating update in this path. Repeated installation verifies the same release and supports rotating the scoped resident credential.

Activation can be retried after an interruption between its atomic replacements (`resident.json`, the loader, `index/negotiator.ts`, `active.json`). If the loader was replaced before `active.json` was committed, the retry also accepts the exact loader generated from the verified release it is handed, and completes the remaining writes. The same rule covers an interrupted release upgrade, where `active.json` still records the older release's loader (ov#282). A managed marker alone does not authorize modified content: a customized loader is refused with or without `active.json`, and left as it is. A loader for a release other than the one being activated is not recognized here; the pin check below takes an unpinned managed loader out first.

The plugin's original Python sidecar retains its per-home lock, process supervisor, `INDEX_BRIDGE_URL`/token and Index credential setup. Its existing `runtime/dist/negotiator.js` executable becomes a managed thin loader for the shared pinned runtime. This replaces the full lifecycle, **not only the original post-brief hook**. The process prints the sidecar's `{ready,port}` handshake only after service authority and selected-agent checks succeed. Private `/health` and POST `/shutdown` use the existing bridge token. Raw participant context and credentials are not logged.

`index/moralmod/active.json` records installation only: `selected: "unverified", ready: false`. Installation is not proof of Index seat ownership; current signed evidence checks the selected agent and executor fence before each decision effect. No automatic selection or real resident activation is performed by the installer.

Morning discovery uses the existing Hermes scheduling callback and signed per-intent wake authority. The managed runtime records safe exception details before saving an unknown outcome; it adds no timer and does not automatically retry uncertain work. OFF residents do not run this runtime. Hosted Index and fresh scientific acceptance remain separate live gates.

## The release pin

The installer activates only the release whose `release.json` has the sha256 in `MORALMOD_RELEASE_SHA256`. The constant is in `install/moralmod_release.ts`, beside `INDEX_PLUGIN_REVISION`, and `install_index_plugin.ts` re-exports it beside `INDEX_PLUGIN_REF`. `release.json` lists the sha256 of every bundle file, so this one digest pins the whole bundle. (OV-249 post-hoc M2.)

A `release.json` with any other sha256 is refused before it is parsed, however consistent its own file hashes are. The refusal works like a plugin revision mismatch:

- the plugin is not enabled;
- its morning job is removed;
- nothing under the plugin is replaced, other than a managed loader taken out with the marker and the managed `morning.py` (below), and nothing is written under `index/moralmod/`;
- the install reports `index_plugin_failed=release_unpinned`.

The constant pins the prepared lean continuation bundle `moralmod-856bab3-8c8b44e578b6`: `release.json` sha256 `8c8b44e578b6347f7e6dcc877c15a52773005079256bbdd2b584453385dca077`, built with Bun 1.4.2 from Decision Studio source `856bab3a79d2c22d9af8c5bacfe3f2e45c579493` for the unchanged plugin `04d833b8`. The installed files are exactly `release.json`, `negotiator-core.js`, `negotiator-runtime.js` and `INDEX-LICENSE`. A value that is not a sha256 matches no `release.json`, so under it no bundle activates on any resident. The Control Plane must supply this matching release URL, manifest digest and source commit before residents are rewired. Installer rollback requires restoring the previous reviewed installer pin and matching profile together; the new installer does not accept the old release.

The exact four assets are published as an inactive [prerelease](https://github.com/Edge-City/agentvillage/releases/tag/moralmod-856bab3-8c8b44e578b6) for CI and coordinated review. Publication does not deploy or activate this candidate. The current C4 packet records qualification, public-asset hashes and CI separately. Before shipping, coordinate CP `release_url`/`release_sha256`/`source_commit`/`runtime_revision` with the service's experiment runtime revision and each resident's configuration. This release selection needs matching CP configuration, not a CP source change. Installed-revision readback and a connected resident canary remain separate rollout gates.

Historical service-transition procedure (already separate from this runtime-only candidate): the coordinated service requires schema `a021_help_me_decide_views`. The current candidate has no service, migration or admission-pause step. For the original a019→a021 transition, deploy the explicitly qualified schema bridge before the additive a019→a021 migration; then deploy and verify the final service before changing CP or resident runtime. Keep admission closed and work settled throughout the schema transition. The ordinary rollout command cannot cross this schema boundary by itself. Do not deploy the new bundle against the old service: its strict command parser rejects the new lookup field.

Rollback before reopening admission may use only the qualified bridge/recovery set at retained a021. After new profile jobs are admitted, preserve final compatible workers, close admission, disable HMD and restore the previous matched installer/CP profile as specified in the coordinated C4 packet. Do not downgrade the database, rewrite saved assessments or replay uncertain effects. A complete installed rollback remains a separate rollout check.

The pin holds on every ON run, not only a keyed run handed a release (ov#277 refute S1). A `--skip-index` run, a run with no Index key, and a keyed run with no `MORALMOD_*` and no `active.json` never install a release, but a loader an earlier run wrote may still be in the plugin's `runtime/dist/negotiator.js`. Each of them keeps that loader only when it is exactly the loader for the pinned release and `index/moralmod/<pin>/` still holds that release (its `release.json` hashes to the pin, every file to its listed digest). Otherwise the loader is taken out as on OFF, together with the marker in `index/negotiator.ts` and the managed `morning.py` (the plugin's own negotiator.js cannot load the marker), the plugin is not enabled, its morning job is removed and the install reports `index_plugin_failed=release_unpinned`. A keyed run handed a release takes the loader out the same way, then holds that release to the pin as above. So moving the pin, or setting it to a value that is not a sha256, stops an activated release on the next install of any kind.

Retirement takes out any loader that is not the pinned release's exact loader, whoever changed it: ov#284's take-it-out rule, which the lead's ruling of 11 Oct (14:55Z) keeps (ov#288 refute M2). The changed bytes never run, an OFF box keeps no MoralMod loader, and the next handed run writes a fresh loader. So a later change to the loader template, or a marker or `MORALMOD_HOOK_VERSION` bump, does not strand an activated box. A keyed run handed a release stops with `sidecar` when retirement could not remove or put back a managed file; it never proceeds to a forced plugin reinstall over it.

Before a managed ON run forces a reinstall of an existing plugin, it checks all three plugin files the overlay manages: `runtime/dist/negotiator.js`, `morning.py` and `sidecar.py`. Each must be a regular file holding the checkout's own upstream bytes (`git show HEAD:<file>`, at whatever revision the tree is) or that file's complete managed replacement (the exact loader for a release directory of this home, the managed `morning.py`, the current sidecar patch or a supported earlier one), or be missing. Comparing with the tree's own `HEAD` rather than the new pin is what lets a plugin bump through: until the reinstall runs, every box is still at the old revision (ov#288 refute M1). A missing file has nothing to protect and is reinstalled; retirement itself deletes the loader when the checkout is not at the pin. The runtime is checked even when no managed marker remains. Missing Hermes installation metadata or `active.json` does not permit replacing unknown content. Customized files, symlinks, directories and files that cannot be verified (no checkout) are preserved and the plugin is withheld with `sidecar`; fresh installs, verified reinstalls and bumps still proceed. The resident's `index/negotiator.ts` hook is outside the replaced directory and is checked separately before installation.

The withhold is not only on the first run (ov#284 refute S1): while `index/moralmod/active.json` names a release other than the pin, every ON run that is not handed a release (`--skip-index`, keyless, keyed without `MORALMOD_*`) is withheld as `release_unpinned`. `active.json` stays for that; `resident.json` and the release stay too, for an ON resident. An OFF run removes all of them.

A marker in `index/negotiator.ts` with no pinned loader beside it (a Hermes reinstall or the control plane's `clean` took the loader, or a run before this rule) is taken out with the managed `morning.py` by the next ON run that does not activate; that run seeds the hook and says so on its line (`managed index/negotiator.ts without its loader`). When it cannot, the plugin is withheld (`sidecar`). The plugin is never enabled with its own negotiator.js beside the marker (ov#284 refute M2).

To pin a release (or move the pin):

1. NYU supplies the exact release directory to ship, the source commit it was built from, and how it was built (`bun run build:village`).
2. Take the digest of that exact file: `shasum -a 256 <release dir>/release.json` (or `sha256sum`). Use the 64 lowercase hex characters.
3. Open a PR to this repo whose only code change sets `MORALMOD_RELEASE_SHA256` to that digest. The PR names the release, its source commit and the review the bundle went through. It goes through the village review like a bump of `INDEX_PLUGIN_REF`; the bundle's code is part of what is reviewed.
4. Ship that same directory as `MORALMOD_RELEASE_DIR`.

Any rebuild that changes a byte of `release.json` or of a file it lists needs a new PR. Tests pass their own pin through the `releasePin` / `pin` parameters, computed from a fixture; the installer passes none.

Verification: `bun test install/tests/moralmod_release.test.ts install/tests/moralmod_host.test.ts install/tests/moralmod_arm_pin.test.ts install/tests/moralmod_activation.test.ts`. The activation fault tests use the pinned plugin checkout from `AV_INDEX_PLUGIN_TEST_DIR` and synthetic verified releases, and are skipped without it. The connected installer test consumes the sibling pinned `index-hermes-plugin` checkout and the sibling `decision-studio/custom-negotiator/dist/village` release (build with `bun run build:village`). It is explicitly skipped when those integration prerequisites are absent; it is not a substitute for installed-host acceptance. The Decision Studio `test_village_lifecycle.py` proof starts the installed executable against real local signing, HTTP and PostgreSQL boundaries with controlled Index/model fixtures.

## Current evidence queue-deadline candidate — 20 October 2026 IST

Candidate `moralmod-856bab3-8c8b44e578b6` is built from Decision Studio `856bab3a79d2c22d9af8c5bacfe3f2e45c579493`. Manifest `8c8b44e578b6347f7e6dcc877c15a52773005079256bbdd2b584453385dca077`; core `ddc99f8a75e0a1dbc706c58785bbf8b363725f698b05c19049b4dc462cc5a9f8`; executable `2f3891e97a4600dab39d429c840158ae8e96a543af12864662ee31362916822d`. It retains the combined HMD, continuation recovery, N1, C3 and C2 work, and adds lazy acknowledged sibling progress, removes overwritten turn-claim evidence reads, and qualifies every influencing context after assessment preparation and before each private model call (including briefing/turn corrections), as well as before validated tool publication. Index, CP and native MoralMod source are unchanged. The final service profile must explicitly configure `village_modeled_counterpart: true` with `participant-decision-v6`; attaching UI metadata does not select scientific construction policy.

| Setting | Value |
|---|---|
| CP runtime revision; box `DECISION_RUNTIME_REVISION`; DS experiment runtime revision | `moralmod-856bab3-8c8b44e578b6` |
| CP `release_url` (published; inactive) | `https://github.com/Edge-City/agentvillage/releases/download/moralmod-856bab3-8c8b44e578b6/` |
| CP `release_sha256` | `8c8b44e578b6347f7e6dcc877c15a52773005079256bbdd2b584453385dca077` |
| CP `source_commit` | `856bab3a79d2c22d9af8c5bacfe3f2e45c579493` |

[Original lean evidence](../../../../docs/Redesign/implementation-20261019T175527Z/assessment.md) describes the original slice; the [prior C4 packet](../../../../docs/Triage/2026-10-20-lean-c4-authority-repair/assessment.md) remains evidence for its original bytes. The [queue-deadline follow-up packet](../../../../docs/Redesign/scale_readiness/evidence/2026-10-20-task3-release/assessment.md) owns this replacement candidate and its exact identities. Unchanged scientific/provider/service-image evidence is carried forward by source parity, not relabelled as a fresh run. Assets are published for CI but not activated. Keep existing credentials/identity/input-kind settings. Actual installed Hermes acknowledgement/use/research receipt and five-box stability remain separate gates.

The intended experiment configuration explicitly supplies `assessment_budget_seconds=400` under the existing Decision Service `index_runtime.assessment` policy. The box consumes the service-owned absolute deadline; there is no new resident environment variable or independently restarted timer. Existing claims retain their original deadlines. This configuration is prepared for review, not applied by the pin change. See Decision Studio `docs/runbooks/lean-continuation-budget.md` for service-first readback and rollback.

Before activation, capture the actual installed installer pin and matching service/CP configuration as the rollback set; do not assume an earlier prerelease was activated. Restore that verified set together if rollback is required. Do not rewrite outstanding deadlines or replay uncertain sends. The prior installer must be restored too; the new installer intentionally rejects old bytes under its new pin.

## Historical N1 candidate: bounded Haiku continuation recovery and attribution

The following sections record the earlier N1 candidate and are historical evidence. Their old pins and schema instructions must not be used for this coordinated release.



Decision Studio source `c85b5918834b9aa5725d9a3a0c812cada1a1f7e2` improves initial brief instructions and returns actionable shortening feedback within Index's existing two-call brief budget. The 400-character contract remains. An otherwise valid aligned scientific choice with a non-null reason receives correction feedback; invalid scientific choices still refuse before any tool executes. Canonical unresolved choices stay held.

Evidence HTTP is shared per installation: four active requests and eighty bounded waiting callers, two attempts and at most45seconds including queue/delay/command, further clamped to the original assessed-use deadline. Exact503evidence_busy retries after at least2seconds plus jitter; only otherwise-valid expired signed proof receives refresh. Generic401/409, network failures and unknown external effects are not blindly retried. Proven acknowledged own progress preserves the original science admission/deadline; substantive changes still refuse.

Sanitized model/evidence diagnostics and pre-evidence continuation counts are always on. No new environment variable, debug flag, CP source change or native MoralMod release is needed. New service refusal labels preserve authentication and expose future401/409/429causes. Historical uncertain wakes still need authoritative reconciliation; this release does not replay them.

Coordinate these exact existing profile/configuration values; the release URL
requires its trailing slash:

| Setting | Value |
|---|---|
| CP `runtime_revision`; box `DECISION_RUNTIME_REVISION`; DS experiment revision | `moralmod-c85b591-180385847dc2` |
| CP `release_url` | `https://github.com/Edge-City/agentvillage/releases/download/moralmod-c85b591-180385847dc2/` |
| CP `release_sha256` | `180385847dc2eb61d13ce42c306718a7218c24d981323cb9bbdb7ef68d3b4d6d` |
| CP `source_commit` (Decision Studio bundle source) | `c85b5918834b9aa5725d9a3a0c812cada1a1f7e2` |

Retain existing live input kind, credentials and identities. A service revision
change affects the experiment, so coordinate all affected boxes; do not switch
only one side. Merge, install, read-back and resident canary remain separate
gates. Require a saved selection tied to the assessment and an Index-acknowledged
outgoing turn before claiming recovery. Restore the previous matching release,
profile and service label together for rollback; preserve uncertain effects.


## Request-amplification supplement — 19 October 2026

This candidate also retains qualified completed and pending wake preparation. Fifty unchanged opportunities over eight model rounds now prepare once each, with fresh source/authority checks at reuse and distinct publication permits. An aborted subscriber cannot cancel another caller; abandoned all-or-nothing preparation is cancelled. Failed/expired/held work cannot renew science or the original use deadline. There is no permission TTL cache, CP code change, scheduler or scientific-policy change.

Decision Service readiness shares one cancellable probe connection. Its check wait is bounded to 1.5 seconds, with one-second connect/SQL settings and at most 100 ms of driver cancellation/drain within the existing sub-two-second HTTP contract. It refuses when the ordinary API pool is full and retains schema/privilege checks. Deployment accounting reserves one extra probe connection per API process: the example overlap peak changes from78 to81, without increasing the ordinary pool. Safe execution-claim markers attribute future zero-attempt stalls. The three historical expiries were delivered but their first blocked boundary remains unresolved; this is not a worker-recovery fix.

Exact local manifest: `180385847dc2eb61d13ce42c306718a7218c24d981323cb9bbdb7ef68d3b4d6d`. Core: `3d82a683d3e048cb5c42dac5b2b2ccf5e20921816b3ac73de5c3d9ffc5acf539`. Executable: `91b182d882c3c51e4310edb9eb9e327f3b9d80e946bd4e59da570f39c343ef31`. Bun1.4.2, Index/plugin pins and environment variable names are unchanged. Use `DECISION_RUNTIME_REVISION=moralmod-c85b591-180385847dc2` only in an authorized coordinated switch. The existing executable emits safe model-response and tool-validation diagnostics by default; no new debug environment variable is needed and no private text should be logged.

The older locally prepared `moralmod-8a2542c-6a281afaf009` is superseded, not overwritten or published. This branch prepares a candidate only. Publication, asset download/CI, compatible service deployment, CP configuration readback, installation, installed use and the existing five-box observation gate remain separate. Follow the existing paired installer/profile rollback; retain compatible scientific workers and a019 records, and never reset/replay uncertain effects.

The late-progress follow-up qualifies source continuity within the existing bookkeeping window before saving deadline fallback or a lawful hold. Assessed prepare/begin still enforce the original use deadline. Exhausted turn fallback explicitly sends a null selection so its durable hold satisfies the existing contract. No CP change, new model budget or deadline extension is introduced. The locally prepared `moralmod-1dfe74c-7205d60f51d9` is superseded; its evidence and bytes remain preserved.

### Final scoped diagnostic follow-up (19 October)

This candidate additionally emits `reasoning_failed` before a fallible hold save and includes `phase=brief|turn` on `continuation_started` before evidence/admission. A failed save remains a failed save; neither a saved hold nor an outgoing effect is invented. Count brief and turn attempts separately, and deduplicate by attempt ID. Transport retries do not emit fresh start markers. Logs contain safe codes and opaque subject/runtime identifiers, not prompts or model responses. The N1 follow-up below adds bounded runner observations; private runner prose stays disabled.

Decision Service must include source `c85b5918834b9aa5725d9a3a0c812cada1a1f7e2` (or a descendant with identical product source) for shielded readiness cleanup and request-correlated authentication lookup timing. This adds no environment variables, migration, model change, CP source change, or automatic uncertain-effect replay. The runtime assets remain unpublished pending independent review, authorized publication, CI, coordinated installation and the existing five-box observation gate.

Historical qualification of `moralmod-9cffe6c-7d98a71d20c9` (manifest `7d98a71d20c92211cb7ec845519609132fe8b63135470955a8bf89d137762343`, source `9cffe6c1371d10fa14c0f5a78a1137a9c1c030ef`) passed 138 installer checks and 85 connected native-x86 service/PostgreSQL checks (three external skips), plus the failed hold-save regression. Its API/scientific/maintenance role images passed authored-checkpoint and restart checks on a temporary Fly environment. Those results apply to the preserved earlier bytes. The N1 candidate changes the runtime/core bytes; it requires its own exact-bundle checks and release/image gate. Neither candidate establishes installed resident use or authorizes expansion.

### N1 attribution follow-up (19 October)

Each validated resident start creates an opaque `boot_id`. Structured `runtime_started`, `runtime_ready`, and graceful `runtime_stopped` markers share it with existing evidence/model/continuation diagnostics. `runtime_ready` means local bootstrap finished; it does not prove a connected stream, an assessment, a research delivery or an Index effect. Invalid configuration can fail before the start marker; abrupt termination may omit the stop marker.

`stream_connected` numbers successful SDK connections within that boot. Each recovery scan emits a start and a finish or sanitized failure, with elapsed time and a bounded boundary (`refresh`, `list_negotiations`, `owed_work`). Scan counts describe signals scanned and wake/turn requests; existing guards can coalesce requests. A completed scan does not acknowledge the asynchronous work it launched. Original stream timestamps, intent/opportunity IDs and private prose are withheld.

Journal failures identify authorization, reconciliation reads, outbox reads, validation, delivery or delivery marking. A failing record retains its original opaque `event_id` where available. Reconciliation failures emit one aggregate per existing flush, reporting the count and the first sanitized cause. Reporting still proceeds after an individual reconciliation failure; uncertain effects remain durable. A lost reporting acknowledgement retries the same event identity, never a new Index effect. Failed diagnostic construction/writes cannot replace the original exception.

There are no retry, timer, deadline, authority, source-check, science or ON/OFF policy changes. The fifteen-second journal timer, Index reconnect policy and existing concurrency limits are retained. These observations do not explain the historical event stop or synchronize fleet scheduling. The incident timeline still needs resident boot/SSE records and an authoritative DS-to-CP-to-Data join. Publication, final Linux role acceptance and installed five-box recovery remain separate gates.

Current N1 evidence: [implementation packet](../../../docs/Triage/2026-10-19-n1-attribution-implementation-071058Z/assessment.md) and [fresh Refuter entrypoint](../../../docs/Triage/2026-10-19-n1-attribution-implementation-071058Z/refuter-packet.md).

For this exact candidate, the local checks passed 379 negotiator fixtures (one missing image-builder prerequisite skip), 35 signed service/PostgreSQL consumer cases, the explicit failed hold-save case, and 129 installer/morning cases. The exact executable passed isolated macOS and Linux smoke checks. Two host builds and a Linux rebuild using the recorded worktree dependency layout produced identical four-file release bytes. A different dependency layout changes bundler path comments and therefore hashes; retain the prepared release bytes and rebuild/repin any replacement. These checks used controlled Index/model/native fixtures and establish no installed recovery claim.

### Evidence queue-deadline follow-up

This candidate supersedes inactive `moralmod-70d3315-9983dbac02ab`. Four active evidence reads and eighty waiting callers are unchanged. Queue residence and execution have a maximum400-second total envelope, shortened by any supplied earlier absolute deadline. The45-second active-operation clock starts at the first HTTP permit, includes the protected command/backoff/retry, and never restarts on retry. This transport bound does not renew a saved assessment deadline or change the300-second scientific-attempt cap. Task6/7 worker/readiness edits are excluded; no new service image is needed for this runtime-only change. Installed R1–R5 and coordinated activation remain separate gates.
