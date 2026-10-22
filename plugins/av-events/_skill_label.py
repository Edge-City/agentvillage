"""B-169b: label a `terminal` run of a shipped skill's script on its `tool.call`.

The overlay's skills reach their services by running their own scripts through
Hermes's `terminal` tool (`bun skills/agent-profile/scripts/profile.ts`,
`python3 skills/agent-commons/scripts/search_forum.py …`), so without a label
those calls are only `terminal` calls, and data's per-family alert (B-169)
cannot page on one skill's scripts failing across the fleet. This module
names the skill, and nothing else:

- `target_system = "skill"`;
- `operation = <name>` when the command's first words are exactly
  `bun|python3|node skills/<name>/scripts/<file>` (the form every shipped
  recipe uses: no prefix, the path relative to the Hermes folder the skill
  says to run it from) and `<name>` is a skill the overlay ships
  (`SHIPPED_SKILLS`, the installer's `EDGE_SKILL_NAMES`, plus
  `SEPARATELY_INSTALLED_SKILLS`, the two installed by their own steps)
  matching `^[a-z][a-z0-9_.-]{0,63}$` (data's door pattern); any other name is `other` (target_system
  still `skill`), so a name the agent makes up never reaches ingest.

Data keys the family `skill.<operation>` and pools unknowns as `skill.other`
(data#608 fold 2 adds `skill` to the door's closed target_system enum).

Nothing past the script path is read: no argument, flag or file name, and
of the path only the skill directory's name. The script's file name is
checked for shape (one plain name, so `scripts/x.py;rm …` is not a run of a
script) and then dropped. A label is alert routing only; a spoofed one
misroutes a page and grants nothing.

**EdgeOS keeps its own labels (ov#437).** The plugin labels a run of
`skills/edgeos/scripts/edgeos.ts` it can read with `target_system: "edgeos"`
and the verb's operation (`_edgeos.script_call`); the caller tries that
first, and a skill label is only written when the EdgeOS matcher wrote none.
A run of that one script the EdgeOS matcher does not read (odd arguments, a
`workdir` other than the Hermes folder) is never labelled here either, so
its `tool.call` is exactly what ov#437 sends. The edgeos skill's other
scripts (`events.ts`, `profile.ts`, `directory.ts`, `portal-link.ts`) carry
no EdgeOS label and are labelled `skill` / `edgeos`.

Pure: no I/O, no environment, no clock; never raises.

Python 3.11, standard library only.
"""

from __future__ import annotations

import re
from typing import Any, Optional

from ._edgeos import EDGEOS_SCRIPT

TOOL_NAME = "terminal"
TARGET_SYSTEM = "skill"
OTHER_OPERATION = "other"

#: The skill bundles the overlay ships, exactly the installer's
#: `EDGE_SKILL_NAMES` (`install/paths.ts`; `install/install_miniapps.ts` calls
#: the same set `SHIPPED_SKILLS`). A closed list, never read from the command:
#: `tests/test_skill_label.py` fails when the two drift apart.
SHIPPED_SKILLS = frozenset({
    "index-network",
    "edgeos",
    "rolodex",
    "gold-stars",
    "skylight",
    "edge-india",
    "edge-esmeralda",
    "token-usage-audit",
    "agent-plaza",
    "agent-commons",
    "simocracy",
    "record-intention",
    "agent-profile",
})

#: Skills the overlay installs by their own steps, outside `EDGE_SKILL_NAMES`
#: (data L17038: own keys, so a blocked one is not pooled with unknowns; data's
#: door list already names both). `tests/test_skill_label.py` checks both
#: directories ship scripts.
SEPARATELY_INSTALLED_SKILLS = frozenset({"recall", "approval"})
LABELLED_SKILLS = SHIPPED_SKILLS | SEPARATELY_INSTALLED_SKILLS

_OPERATION = re.compile(r"^[a-z][a-z0-9_.-]{0,63}$")
#: The command's first word sequence: a runner, then the script path, then
#: whitespace or the end of the command. Leading spaces and tabs run nothing.
#: The skill name is any run of non-slash, non-space characters (checked after);
#: the file name one plain name.
_RUN = re.compile(r"[ \t]*(?:bun|python3|node)[ \t]+skills/([^/\s]+)/scripts/([A-Za-z0-9_.-]+)(?=\s|\Z)")
#: A command longer than this is not read (the EdgeOS parser's bound).
MAX_COMMAND_CHARS = 16384


def skill_label(tool_name: Any, args: Any) -> Optional[tuple[str, str]]:
    """(`target_system`, `operation`) for a `terminal` run of a skill script,
    else None. Never raises: a label lost costs a page's routing, never the
    `tool.call`."""
    try:
        if tool_name != TOOL_NAME or not isinstance(args, dict):
            return None
        command = args.get("command")
        if not isinstance(command, str) or not command or len(command) > MAX_COMMAND_CHARS:
            return None
        match = _RUN.match(command)
        if match is None:
            return None
        name, script = match.group(1), match.group(2)
        if f"skills/{name}/scripts/{script}" == EDGEOS_SCRIPT:
            # ov#437 owns this script's label: edgeos.<verb>, or none.
            return None
        if name in LABELLED_SKILLS and _OPERATION.fullmatch(name):
            return TARGET_SYSTEM, name
        return TARGET_SYSTEM, OTHER_OPERATION
    except Exception:  # noqa: BLE001 - pure string checks; belt and braces
        return None


__all__ = ["LABELLED_SKILLS", "MAX_COMMAND_CHARS", "OTHER_OPERATION", "SEPARATELY_INSTALLED_SKILLS", "SHIPPED_SKILLS", "TARGET_SYSTEM", "TOOL_NAME", "skill_label"]
