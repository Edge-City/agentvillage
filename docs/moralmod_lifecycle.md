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
- the plugin's `runtime/dist/negotiator.js` and `morning.py` are not touched;
- no release is installed under `index/moralmod/`.

The run prints `→ index-network plugin: off (AV_MORALMOD_ARM is not on); MoralMod release or resident config present, not activated: the managed negotiator runs only for ON`. `av-events/install-status.json` gets `index_plugin_failed: null` and `index_plugin_note: "moralmod_arm_not_on"`.

Files an earlier ON run left stay on disk, but the plugin that would load them is not enabled.

Use `live` only for the explicitly authorized live experiment. The installer does not allocate an arm. The CP must already have an enrollment, saved assignment, registered installation/agent/epoch and a resident credential. Decision Service must trust its issuer/JWKS/client and allow the resident scopes `negotiations:manage_self`, `runs:create_self`, `runs:read_authorized`, and `contexts:write_self` for the approved experiment. Permissions still control each operation; OFF residents do not run this runtime.

The release pins Index source, Hermes plugin `eaec4fc02ffc251fca2cfd56b728c845562f6a3b` and Bun 1.4.2. It verifies every bundle digest, refuses resident custom hooks or modified managed files, and atomically writes the scoped config and runtime entrypoint. An existing plugin on another revision requires an explicit migration; there is no floating update in this path. Repeated installation verifies the same release and supports rotating the scoped resident credential.

The plugin's original Python sidecar retains its per-home lock, process supervisor, `INDEX_BRIDGE_URL`/token and Index credential setup. Its existing `runtime/dist/negotiator.js` executable becomes a managed thin loader for the shared pinned runtime. This replaces the full lifecycle, **not only the original post-brief hook**. The process prints the sidecar's `{ready,port}` handshake only after service authority and selected-agent checks succeed. Private `/health` and POST `/shutdown` use the existing bridge token. Raw participant context and credentials are not logged.

`index/moralmod/active.json` records installation only: `selected: "unverified", ready: false`. Installation is not proof of Index seat ownership; current signed evidence checks the selected agent and executor fence before each decision effect. No automatic selection or real resident activation is performed by the installer.

Morning discovery is intentionally not activated by the internal-MVP entrypoint (`/morning` returns 409). B.AV.1 must install its durable authority before **real-resident beta**, for ON residents (OFF residents do not run this runtime). Missing scheduling is not a resident-beta pass. Hosted Index and fresh scientific acceptance remain separate live gates.

## The release pin

The installer activates only the release whose `release.json` has the sha256 in `MORALMOD_RELEASE_SHA256`. The constant is in `install/moralmod_release.ts`, beside `INDEX_PLUGIN_REVISION`, and `install_index_plugin.ts` re-exports it beside `INDEX_PLUGIN_REF`. `release.json` lists the sha256 of every bundle file, so this one digest pins the whole bundle. (OV-249 post-hoc M2.)

A `release.json` with any other sha256 is refused before it is parsed, however consistent its own file hashes are. The refusal works like a plugin revision mismatch:

- the plugin is not enabled;
- its morning job is removed;
- nothing under the plugin is replaced and nothing is written under `index/moralmod/`;
- the install reports `index_plugin_failed=release_unpinned`.

Until a reviewed release is supplied, the constant is a sentinel that is not a sha256, so no bundle activates on any resident.

To pin a release (or move the pin):

1. NYU supplies the exact release directory to ship, the source commit it was built from, and how it was built (`bun run build:village`).
2. Take the digest of that exact file: `shasum -a 256 <release dir>/release.json` (or `sha256sum`). Use the 64 lowercase hex characters.
3. Open a PR to this repo whose only code change sets `MORALMOD_RELEASE_SHA256` to that digest. The PR names the release, its source commit and the review the bundle went through. It goes through the village review like a bump of `INDEX_PLUGIN_REF`; the bundle's code is part of what is reviewed.
4. Ship that same directory as `MORALMOD_RELEASE_DIR`.

Any rebuild that changes a byte of `release.json` or of a file it lists needs a new PR. Tests pass their own pin through the `releasePin` / `pin` parameters, computed from a fixture; the installer passes none.

Verification: `bun test install/tests/moralmod_release.test.ts install/tests/moralmod_host.test.ts install/tests/moralmod_arm_pin.test.ts`. The connected installer test consumes the sibling pinned `index-hermes-plugin` checkout and the sibling `decision-studio/custom-negotiator/dist/village` release (build with `bun run build:village`). It is explicitly skipped when those integration prerequisites are absent; it is not a substitute for installed-host acceptance. The Decision Studio `test_village_lifecycle.py` proof starts the installed executable against real local signing, HTTP and PostgreSQL boundaries with controlled Index/model fixtures.
