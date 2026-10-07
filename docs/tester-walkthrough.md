# Agent Village: tester walkthrough (sign up as a resident and check what you get)

For team members who want to try Agent Village the way a resident will, before beta users arrive.
You need: an email address that has an Edge City India application (the app refuses unknown emails),
Telegram on your phone, about 25 minutes, and a channel to report in (the team chat, or Carter).
No control-plane access is needed. Where the operators read logs behind a step, this guide says what
you should see on your side; the operator runbook (`agentvillage-data/docs/runbooks/signup-rehearsal.md`)
has the matching reads.

Write down the time (with timezone) when you start each step, and what you saw. Screenshots are
welcome; blur Telegram ids and other people's names.

## Before you start

- **If your account already has an agent**, you cannot sign up again until an operator deletes that
  tenant. Ask Carter or the lead to delete it; then continue here. Deleting loses your agent's memory;
  your intents and profile come back with the new agent.
- **A fresh account** needs nothing.
- Quiet hours: approval cards are held between 23:00 and 08:00 India time and delivered after. Test
  outside those hours if you want to see a card arrive at once.

## The steps

### 1. Sign in
- Do: open https://agents.edgecity.live/signin, enter your email, enter the six-digit code.
- Expect: under a minute. You land on the consent page (or on your existing agent: see "Before you
  start").
- If not: "unknown email" means the account has no Edge City application. No code email: the mailer,
  note the time and stop.

### 2. Research consent
- Do: read the Participation and Consent Brief, tick research (training is a separate, optional
  choice, unticked by default), "Agree and continue".
- Expect: the About you step.
- If not: a save error: note the wording on screen and stop (no agent is created without research
  consent).

### 3. Create the agent
- Do: fill About you. In "Name your agent" give the agent a name (leaving it empty keeps "Edge";
  giving one is the better test). Write the name down. "Create my agent". Stay on the page until it
  says the agent is ready.
- Expect: ready within about 5 minutes (a first-time build is slower than a repeat).
- If not: still building after 15 minutes, or an error: note the time and the message, do not retry
  more than once, report.

### 4. Connect Telegram
- Do: on the Connect Telegram step tap Create; Telegram opens; finish creating the bot; come back to
  the app. Open the bot in Telegram and send `/start`.
- Expect: the app shows the bot connected. The bot's suggested name is the name you gave in step 3.
- If not: no bot after Create: use the manual token path on the same panel (BotFather `/newbot`,
  paste the token) and report that the quick path failed.

### 5. The approvals bot
- Do: the setup shows "The approvals bot" as a step: tap Start, open the approvals bot in Telegram,
  send `/start`.
- Expect: the app shows it paired. This bot is where your approval cards arrive.
- If not: it never shows paired: report, with the time. Do not block the bot.

### 6. First message: the welcome
- Do: send your agent a greeting in Telegram.
- Expect: a reply within a minute: a welcome that names the village dates, the agent introduces
  itself by the name you gave (not "Edge", unless you left the name empty), lists the things you said
  you are looking for (your intents, each shown whole), and points at the Intents page. Exactly one
  welcome, no reasoning text, at most one short "working on it" line.
- If not: no reply after two minutes: send the greeting once more (a message during the agent's
  first start can be lost); still nothing: report. A generic welcome with none of your intents, or the
  wrong name: report with a screenshot.

### 7. Approval cards (watch for them during steps 8 and 9)
- Do: nothing on purpose. When a card arrives in the approvals bot, read it. Tap Approve or Deny
  only if you mean it.
- Expect: a plain card: first line "Your agent wants to ...", an Approve and a Deny button, and the
  technical detail folded under "Full details". A few request kinds (treasury proposals, for
  example) still arrive as the detailed card; that is by design.
- If not: a card with no buttons, or a tap that nothing acknowledges: screenshot (ids hidden) and
  report. Note the time and what the card was about.

### 8. Tell the agent what you want
- Do: in one message, say something you want from the village and ask it to save it, for example:
  "I want to meet people building tools for local farmers while I'm in Goa. Please save that as my
  intention."
- Expect: the agent confirms it saved the intention (it may ask you to approve posting it to the
  matching network: that is a card, step 7). Within a few minutes the Intents page in the app lists
  it.
- If not: the agent says it saved it but the Intents page never shows it after 15 minutes: report.

### 9. RSVP to one event
- Do: ask "What's on the Edge City calendar this week?", then "RSVP me to <one event it listed>",
  then "Am I registered for it?".
- Expect: a list of real events; the RSVP confirmed; the confirming question answered yes. Check
  the EdgeOS portal shows the RSVP.
- If not: the agent says it has no calendar access, or the RSVP fails: report the exact sentence.
  A card may arrive here (step 7).

### 10. That evening
- Do: nothing. Around 19:00 India time scheduled messages run.
- Expect: as a brand-new resident you get the evening reminder, not the outcome question (that goes
  to residents with an older connection). Scheduled messages end with a line in parentheses saying
  what the message is and that you can ask the agent to stop or manage it.
- If not: a message with a "Cronjob Response" header, or no footer line: report with the time.

### 11. Next morning
- Do: nothing. The daily digest arrives around 08:15 India time.
- Expect: a digest that names only interests you actually stated (steps 3 and 8), nothing invented,
  ending with "(Daily digest message - you can ask me to stop or manage it)". It may say there is
  nothing today; that is fine.
- If not: an interest you never gave, or the header/footer from the previous point: report.

## Report template

```
Tester: <name>        Account: <email, or "fresh">        Start: <date, time, timezone>
Agent name given: <name or empty>
1 sign in: ok / issue: ...
2 consent: ok / issue: ...
3 create: ready after <m> min / issue: ...
4 telegram: ok, bot name <name> / issue: ...
5 approvals bot: paired / issue: ...
6 welcome: name right? intents listed whole? one welcome? / issue: ...
7 cards: none / arrived at <time>, about <what>, buttons yes/no, tapped <approve/deny/not>
8 intention: saved? on the Intents page after <m> min? / issue: ...
9 rsvp: event <name>, confirmed yes/no, portal shows it yes/no / issue: ...
10 evening: message at <time>, footer line yes/no
11 morning: digest at <time>, only stated interests yes/no, footer line yes/no
```

Send it to the team chat. Operators match your times against the control-plane logs.

## For operators
The delete-then-signup pre-step, the per-step log reads, the expected fleet versions and the
pass/fail sheet are in `agentvillage-data/docs/runbooks/signup-rehearsal.md`. Keep that file and this
one in step when a step changes.
