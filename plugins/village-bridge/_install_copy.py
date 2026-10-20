"""Product-owned words for a mini-app the resident has not installed. Every install string the agent sees is here.

MINIAPP-INSTALL-LINK (v2.1.5; lead ASSIGN CLAIMS L13329, product copy L13345,
lanes-product/MINIAPP-INSTALL-SUGGESTION-copy.md). Carter's rule: the agent never sends the resident to the team
or the organisers, and always gives a one-tap path; it cannot install anything itself, and the resident's tap is
the consent. Swap a string here and nowhere else: the `village` tool description, the not-installed refusal and
the shipped skills read these (their tests pin the wiring, not the words). {name}, {description} and {link}
are filled from the reviewed catalog (_install_catalog.py), never from a tool argument or an upstream reply.

No "/new": v2.1.5 (ov#410: an installed mini-app reaches an open chat without /new) is on every box (lead L13755,
product L13758), so NAMED, GENERAL_OUTRO, MID_TASK and NOT_INSTALLED carry product's post-v2.1.5 tails, verbatim
(CLAIMS L13415, confirmed L14006), and NEVER ends "Never promise it works before their next message." (L14006). After any change, rerun `python3 scripts/gen_install_catalog.py`.
"""

# The lead's install rule, whole (L13329). The shipped `mini-apps` skill carries it.
RULE = ("If an app isn't installed, send the resident its install link (one tap). Never tell them to contact the "
        "team or organisers. You cannot install apps yourself; the resident's tap is the consent.")
# The same rule as the `village` tool description's last sentences, written there literally (R-DEON's proof
# literal-evals SCHEMA; a test pins them equal). It drops "the resident's tap is the consent": with it, the longer
# description lets ask_village outrank village for "people search" in Hermes's tool_search BM25
# (plugins/av-events/tests/test_ask_village_findable.py). Keep any rewrite at or under this length.
TOOL_RULE = ("If an app isn't installed, send the resident its install link (one tap). Never tell them to contact the "
             "team or organisers. You cannot install apps yourself.")

# The refusal's `instruction` when the catalog has a link this resident can open (product's text, verbatim).
NOT_INSTALLED = ("This app is not installed for this resident. Do not retry and do not send them to the team. Tell them "
                 "you cannot install it yourself and give the one-tap link below. Never show this code.")

# The refusal's `instruction` when no link can be given (an app outside the reviewed catalog, or one this resident
# cannot open in Mini-apps). Product's text, verbatim (CLAIMS L13415).
NOT_OFFERED = ("This app isn't available to this resident here. Do not retry, do not send an install link, and do not "
               "send them to the team or the organisers. Tell them: 'That app isn't available on your agent yet, so I'll "
               "carry on without it.' Never show this code.")

# The refusal's `instruction` when the app is installed but this agent's entry does not carry the operation yet.
# Product's text, verbatim (CLAIMS L13415); {name} is the catalog name. A minute, not /new: the gateway restarts
# after each mini-apps reconcile.
NOT_YET = ("This app is installed, but this action isn't available on this agent yet. Do not retry now, do not send an "
           "install link, and do not send them to the team or the organisers. Tell them: '{name} is installed, but that "
           "action isn't ready on your agent yet. Try again in a minute.' Never show this code.")

# STAFF APPS (lead L13438; product L13443 and lanes-product/MINIAPPS-STAFF-APPS-copy.md): an app that comes with every
# agent (manifest "staff": true; Gold Stars, which Rolodex rides) is never installed or removed by the resident, so
# it never gets an install link. Installed but missing the operation: NOT_YET above. No entry on the box yet (the
# cp's backfill has not reached it): STAFF_PENDING, NOT_YET's words with product's line for this case, verbatim.
STAFF_TELL = "**{name}** is on its way to your agent. Try again in a minute."
STAFF_PENDING = ("This app comes with every agent and has not reached this one yet. Do not retry now, do not send an "
                 "install link, and do not send them to the team or the organisers. Tell them: '" + STAFF_TELL + "' Never "
                 "show this code.")
# The shipped skill's section for these apps. STAFF_INTRO is product's box line, verbatim; the rest is release wording.
STAFF_INTRO = "These come with every agent: always on, nothing to install or remove."
STAFF_ROW = "**{name}** — {description}"
STAFF_RULE = ("Rolodex comes with Gold Stars. Never give an install link for these apps and never offer to install or "
              "remove them. If one of their actions answers `mini_app_not_installed`, say the answer's `instruction` "
              "words, for example:")

# 1. The resident names an app that isn't installed.
NAMED = ("I can't install apps myself, but you can in one tap: **{name}** — {description} {link} Once it's installed "
         "I'll pick it up on your next message.")
# 2. A general ask ("install mini-apps", "what apps can you use?"): the intro, one LINE per app (unranked), the outro.
GENERAL_INTRO = "I can't install apps myself, but you can add any of these in one tap:"
LINE = "**{name}** — {description} {link}"
GENERAL_OUTRO = "Tap the ones you want; I'll pick each one up on your next message."
# 3. An action fails mid-task because its app isn't installed: name the app, never the error.
MID_TASK = "That needs **{name}**, which isn't installed yet. One tap: {link} Then ask me again."

# The shipped `mini-apps` skill (skills/mini-apps/SKILL.md, generated from these strings and the catalog by
# scripts/gen_install_catalog.py). SKILL_DESCRIPTION is its skills-index line.
SKILL_DESCRIPTION = ("Install or add mini-apps, what apps you can use, or an action that needs an app that isn't installed: "
                     "give the resident that app's one-tap install link. Rolodex comes with Gold Stars, which every agent "
                     "has: never an install link for it. You cannot install apps yourself; the resident's tap is the "
                     "consent. Never send them to the team or organisers.")
SKILL_OFFER = ("Offer only apps this resident can open in Mini-apps: the app ids in `$AV_MINI_APPS_OFFERED` (read it with "
               "`printenv AV_MINI_APPS_OFFERED`; comma-separated), and the `installUrl` and `installable` list in the "
               "`village` tool's `mini_app_not_installed` answer. Give each link exactly as written below or as the tool "
               "returned it; never build or change one. If the variable is unset or empty and the tool gave no link, say "
               "you can't add apps from here right now and carry on.")
NEVER = ("Never send them to the team or the organisers to install an app. Never say you installed it. Never show the "
         "error code, a tool name or any link other than the app's install link. Never promise it works before their "
         "next message.")
