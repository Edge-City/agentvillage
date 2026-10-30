# Rolodesi mini-app bundle (Agent Village)

Submitted for sandbox review by team IRLmaxxinggg (Edge India Buildathon).

- `manifest.json`: manifest v2, a generic public read relay (`service.kind: "mcp"`, `auth.mode: "none"`, five `read` operations) pointing at `https://app.rolodesi.com/api/mcp`. `visibility: "sandbox"`.
- `skills/rolodesi/SKILL.md`: the skill, pinned in the manifest by sha256. Any edit to the skill changes the pin: update `skills[0].sha256` (`shasum -a 256 skills/rolodesi/SKILL.md`).

The two "prepare" tools are reads: they return an encrypted review link and save nothing. The resident's tap on that link writes; the worker's own Publish makes a page public. See `docs/features/agent-village/SPEC.md`.

Checked by `app/src/server/agent/manifest.test.ts`, our own copy of the v2 rules read from `Edge-City/agentvillage` on 30 Oct 2026 (their validator is not run). The same test holds every operation's `input` equal to the server's `tools/list` schema.

Per their quickstart, submission is one control-plane pull request with three files: `control-plane/src/mini-apps/skills/rolodesi/SKILL.md`, `control-plane/src/mini-apps/rolodesi/manifest.json`, and `"rolodesi"` appended to `control-plane/src/mini-apps/catalog.json`. Staff then allowlist a tenant; a fleet roll is a precondition. Until then, any MCP client can use the endpoint directly (`docs/features/agent-village/DEMO.md`).
