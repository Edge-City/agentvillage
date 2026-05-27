# Setup

The CLI is shipped as the public package
`@geoprotocol/geo-edge-esmeralda-cli`. Installed users run it with Node through
the `geo-edge-esmeralda` binary. From this repository, run commands through Bun
or the workspace wrapper that exposes `geo-edge-esmeralda`.

Required configuration:

```bash
export EDGEOS_BEARER_TOKEN="..."          # Human session JWT for Geo knowledge graph access and content writes
```

Keep bearer tokens in environment/config only. `EDGEOS_API_TOKEN` is the
service-token env var for EdgeOS sync and must not be used by attendee agents.

Copy this folder into `~/.hermes/skills/` or include it through an external
AgentSkills directory such as `~/.agents/skills`.

Run an auth check first:

```bash
geo-edge-esmeralda auth
```
