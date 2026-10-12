"""av-help: a bare /help becomes the resident's question, answered by the agent.

Hermes answers ``/help`` itself, before the model sees anything, with the full
command and skill list. For a resident that is noise. ``pre_gateway_dispatch``
runs on every incoming message before commands are handled and may rewrite the
text (hermes_cli/plugins.py, gateway/run_inbound.py), so a bare ``/help`` is
rewritten into an ordinary question and the agent answers it from the "When
asked for help" section of its workspace AGENTS.md.

A plugin cannot register its own ``/help``: ``register_command`` refuses names
that clash with a built-in. Everything else is left alone: ``/help foo``, other
slash commands, ordinary text. The hook never raises and never drops a message.
"""

from __future__ import annotations

import logging
import re
from typing import Any, Optional

logger = logging.getLogger(__name__)

#: What the agent is asked in place of the command. It is how a resident would
#: ask in words, so the agent's normal answer (AGENTS.md) applies.
HELP_QUESTION = "help - what can you do for me?"

#: `/help` alone, or `/help@SomeBot` (how Telegram addresses a command in a group).
_BARE_HELP = re.compile(r"^/help(?:@\w+)?$", re.IGNORECASE)


def rewrite_help(text: Any) -> Optional[str]:
    """The replacement text for a bare /help, else None (leave the message as it is)."""
    if isinstance(text, str) and _BARE_HELP.match(text.strip()):
        return HELP_QUESTION
    return None


def pre_gateway_dispatch(event: Any = None, **_: Any) -> Optional[dict]:
    try:
        replacement = rewrite_help(getattr(event, "text", None))
    except Exception:  # noqa: BLE001 - a help tweak must never stop a message
        logger.warning("av-help: could not read the message; left as is", exc_info=True)
        return None
    return {"action": "rewrite", "text": replacement} if replacement else None


def register(ctx: Any) -> None:
    """Hermes plugin entrypoint: one hook."""
    try:
        ctx.register_hook("pre_gateway_dispatch", pre_gateway_dispatch)
    except Exception:  # noqa: BLE001
        logger.warning("av-help: could not register pre_gateway_dispatch", exc_info=True)
