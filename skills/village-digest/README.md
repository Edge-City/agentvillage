# Village Digest rollout

This bundle installs automatically with the other `EDGE_SKILL_NAMES`. It adds
no cron job, plugin, provisioning hook, or automatic secret injection.

For a hosted resident, configure these two variables in that resident's
runtime environment:

```text
VILLAGE_DIGEST_BASE_URL=https://agents.edgecity.live
VILLAGE_DIGEST_READ_SECRET=<the app DIGEST_READ_SECRET value>
```

The app uses `DIGEST_READ_SECRET`; resident runtimes receive the same value
under the deliberately narrower name `VILLAGE_DIGEST_READ_SECRET`. Carter can
roll out the mapping only to the intended resident runtimes. Do not expose the
app variable itself and do not reuse `APP_INTERNAL_SECRET`, Railway/operator
tokens, or database credentials. The skill remains safely off if either value
is absent or invalid.

After configuration, run this non-mutating canary inside one resident:

```bash
bun "$HERMES_HOME/skills/village-digest/scripts/read.ts"
```

Expected outcomes are a JSON object with `status: "ok"` and a validated
digest, `status: "unavailable"` with no digest, or a short `status: "error"`
code. Output never contains the bearer token or an unvalidated response body.
No live canary is part of repository tests.

