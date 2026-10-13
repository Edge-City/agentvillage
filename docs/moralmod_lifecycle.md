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

Morning discovery is intentionally not activated by the internal-MVP entrypoint (`/morning` returns 409). B.AV.1 must install its durable authority before **real-resident beta**, for ON residents (OFF residents do not run this runtime). Missing scheduling is not a resident-beta pass. Hosted Index and fresh scientific acceptance remain separate live gates.

## The release pin

The installer activates only the release whose `release.json` has the sha256 in `MORALMOD_RELEASE_SHA256`. The constant is in `install/moralmod_release.ts`, beside `INDEX_PLUGIN_REVISION`, and `install_index_plugin.ts` re-exports it beside `INDEX_PLUGIN_REF`. `release.json` lists the sha256 of every bundle file, so this one digest pins the whole bundle. (OV-249 post-hoc M2.)

A `release.json` with any other sha256 is refused before it is parsed, however consistent its own file hashes are. The refusal works like a plugin revision mismatch:

- the plugin is not enabled;
- its morning job is removed;
- nothing under the plugin is replaced, other than a managed loader taken out with the marker and the managed `morning.py` (below), and nothing is written under `index/moralmod/`;
- the install reports `index_plugin_failed=release_unpinned`.

The constant pins [the reviewed policy release](https://github.com/Edge-City/agentvillage/releases/tag/moralmod-bf51765-e92a48579232): `release.json` sha256 `e92a48579232375af2128ad017fd7387acb1183546eef6c12cf1cb0e0eec45fc`, built with Bun 1.4.2 from Decision Studio source `bf51765a9154e8f399ec8d5a6c5bfaa9611f54f5` for the unchanged plugin `04d833b8`. The installed files are exactly `release.json`, `negotiator-core.js`, `negotiator-runtime.js` and `INDEX-LICENSE`. A value that is not a sha256 matches no `release.json`, so under it no bundle activates on any resident. The Control Plane must supply this matching release URL, manifest digest and source commit before residents are rewired. Rollback requires restoring the previous reviewed installer pin and matching profile together; the new installer does not accept the old release.

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
