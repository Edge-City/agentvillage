# MoralMod managed Index lifecycle (connected internal MVP)

This installer path runs the shared Decision Studio bundle **inside the existing per-resident Hermes sidecar**. Index credentials remain in Village. Hermes supplies the model bridge; Decision Service receives signed opaque requests and owns scientific execution and durable continuation. Both arms use this same runtime.

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

Use `live` only for the explicitly authorized live experiment. The installer does not allocate an arm. The CP must already have an enrollment, saved assignment, registered installation/agent/epoch and a resident credential. Decision Service must trust its issuer/JWKS/client and allow the resident scopes `negotiations:manage_self`, `runs:create_self`, `runs:read_authorized`, and `contexts:write_self` for the approved experiment. Permissions still control each operation; OFF cannot assess.

The release pins Index source, Hermes plugin `eaec4fc02ffc251fca2cfd56b728c845562f6a3b` and Bun 1.3.6. It verifies every bundle digest, refuses resident custom hooks or modified managed files, and atomically writes the scoped config and runtime entrypoint. An existing plugin on another revision requires an explicit migration; there is no floating update in this path. Repeated installation verifies the same release and supports rotating the scoped resident credential.

The plugin's original Python sidecar retains its per-home lock, process supervisor, `INDEX_BRIDGE_URL`/token and Index credential setup. Its existing `runtime/dist/negotiator.js` executable becomes a managed thin loader for the shared pinned runtime. This replaces the full lifecycle, **not only the original post-brief hook**. The process prints the sidecar's `{ready,port}` handshake only after service authority and selected-agent checks succeed. Private `/health` and POST `/shutdown` use the existing bridge token. Raw participant context and credentials are not logged.

`index/moralmod/active.json` records installation only: `selected: "unverified", ready: false`. Installation is not proof of Index seat ownership; current signed evidence checks the selected agent and executor fence before each decision effect. No automatic selection or real resident activation is performed by the installer.

Morning discovery is intentionally not activated by the internal-MVP entrypoint (`/morning` returns 409). B.AV.1 must install its durable authority before **real-resident beta**, identically in both arms. Missing scheduling is not a resident-beta pass. Hosted Index and fresh scientific acceptance remain separate live gates.

Verification: `bun test install/tests/moralmod_release.test.ts install/tests/moralmod_host.test.ts`. The connected installer test consumes the sibling pinned `index-hermes-plugin` checkout and the sibling `decision-studio/custom-negotiator/dist/village` release (build with `bun run build:village`). It is explicitly skipped when those integration prerequisites are absent; it is not a substitute for installed-host acceptance. The Decision Studio `test_village_lifecycle.py` proof starts the installed executable against real local signing, HTTP and PostgreSQL boundaries with controlled Index/model fixtures.
