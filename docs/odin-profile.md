# Installing as ODIN

ODIN is the village god agent: it serves the whole village, not one resident,
and answers to the organisers. This overlay installs as ODIN instead of as a
resident's agent (Edge) when `AV_PROFILE=odin`. The change is files and the
installer only.

## Install

```
AV_PROFILE=odin HERMES_HOME=/path/to/hermes-home bun install/install.ts
```

`AV_PROFILE` is `resident` (default, unchanged behaviour) or `odin`; any other
value stops the installer. With `odin` the installer writes, instead of the
resident files:

- `$HERMES_HOME/SOUL.md` from `workspace/odin/SOUL.md`
- `$HERMES_HOME/AGENTS.md` from `workspace/odin/AGENTS.md`

The resident `USER.md` is not installed. `install/reset.ts` removes the same
`SOUL.md` and `AGENTS.md` under either profile and never touches `constitution.md`.

### How a box keeps the profile

The installer reads `AV_PROFILE` from the process environment first, else from
`$HERMES_HOME/.env` (the same file, and the same parser, as `AV_MORALMOD_ARM`).
The control plane writes `AV_PROFILE=odin` into the box `.env` before install, so
a provisioned box stays ODIN across update, reset and roll without anyone
passing the variable. The process environment wins when both are set. An
unknown value stops the installer. Without either, the box installs as the
resident.

## The fixed sections

`workspace/odin/SOUL.md` opens with the fixed sections of ODIN-SOUL-TEMPLATE-v1,
verbatim and in the template's order: who you are, the safety and harm floor, the
privacy and consent floor, tools and actions, honesty, and how you resolve
conflicts (the fixed sections win any conflict with the Village constitution).
The overlay's own "How you speak" follows them, and the Village constitution ends
the file. Because the installer rebuilds SOUL.md from this file on every install,
update, reset and roll (except with `--preserve-context`), a roll restores these
floors rather than losing them; they change only through a PR here (`install/tests/profile.test.ts` pins the headings, their order
and the template-v1 text).

## The constitution

No constitution text is in this repo. SOUL.md ends with a `## Village
constitution` section. At install time the installer fills it from
`$HERMES_HOME/constitution.md`:

- file present and not empty: its text, verbatim;
- file absent or empty: the single line `(no constitution adopted yet)`.

The operator obtains the text from the app's owner-only soul export and saves it
as `$HERMES_HOME/constitution.md` as is, before running the installer. If the file
starts with a `## Village constitution` heading (the export does), the installer
drops that line and the blank lines after it, so SOUL.md carries one heading. To adopt or
change it later, replace that file and re-run the installer: SOUL.md is
rebuilt on every run (except with `--preserve-context` when one already exists).

## What ODIN gets, and does not get

Under `AV_PROFILE=odin` the installer runs the core install as for a resident
(skills copy, `av-events`, `av-approval` custody, `av-display`, model and
gateway settings) and these resident-only pieces are not installed:

- the village bridge (`village-bridge` is not enabled);
- `av-vote`;
- the Index network: no `index-network` plugin, no `index-links`, no Index MCP
  entry or key (the install needs no Index API key and `--skip-index` is
  implied), and no Index cron jobs;
- EdgeOS tokens.

A box switched from resident to ODIN has the four plugin names dropped from
`plugins.enabled`; Index cron jobs already on it are not removed by the
installer. Plugin files are still staged on disk but nothing enables them. The
resident `USER.md` and `AGENTS.md` are not installed.

There is still no ODS tool, no data access of any kind (ODIN's "village-level
data only" is a rule in its soul, not a mechanism), no posting to residents and
no allocation. ODIN does get the core install's generic tools and skills, as
the resident does; anything beyond that needs its own work and the organisers'
approval.
