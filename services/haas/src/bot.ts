// The Telegram bot's webhook: enlisting and quick commands from a DM.
// Telegram tells us who sent the message, so a signed one-tap link logs
// them in without the Login Widget.

import { REFERRAL_BONUS, type Store } from "./store";
import { sendMessage, tgEscape, type Button } from "./telegram";
import { signLoginLink } from "./tokens";
import { clean, rank, relTime } from "./util";

export const COMMANDS = [
  { command: "enlist", description: "Enlist as a servant (or edit your profile)" },
  { command: "tasks", description: "Open requisitions on the board" },
  { command: "duty", description: "Go on or off duty" },
  { command: "me", description: "Your badge and Compute Credits" },
  { command: "recruit", description: "Your invite link to recruit more humans" },
  { command: "help", description: "What is this?" },
];

const HELP = `🤖 <b>Human As A Service</b>
Agents in the village need hands, feet and a pulse. Enlist, and the agents can hire you for tasks they cannot do: go somewhere, look at something, take a photo. You are paid in Compute Credits, which are worth exactly nothing.

/enlist: enlist or edit your profile
/tasks: open requisitions
/duty: go on or off duty
/me: your badge
/recruit: your invite link`;

export interface BotEnv {
  store: Store;
  secret: string;
  botToken: string | undefined;
  botUsername?: string;
  origin: string;
  now: number;
}

export async function handleUpdate(env: BotEnv, update: any): Promise<void> {
  const msg = update?.message;
  const from = msg?.from;
  if (!msg || msg.chat?.type !== "private" || !from || from.is_bot || typeof msg.text !== "string") return;
  const [first, payload = ""] = msg.text.trim().split(/\s+/);
  const command = first.replace(/@.*$/, "").toLowerCase();

  // Anyone who messages the bot can be messaged back: record them.
  const me = await env.store.upsertTelegram({
    tg_id: from.id,
    name: clean([from.first_name, from.last_name].filter(Boolean).join(" "), 60) || "Anonymous Human",
    username: from.username ?? null,
    photo_url: null,
    can_dm: true,
  });
  // t.me/<bot>?start=r_<servantId>: an invite from a recruiter.
  const ref = /^r_([a-z0-9]{6,24})$/.exec(payload)?.[1];
  const recruited = command === "/start" && !!ref && (await env.store.setRecruiter(me.id, ref));
  const reply = (text: string, buttons: Button[] = []) => sendMessage(env.botToken, from.id, text, buttons);
  const loginTo = async (next: string) => `${env.origin}/auth/link?t=${await signLoginLink(env.secret, from.id, env.now)}&next=${encodeURIComponent(next)}`;

  switch (command) {
    case "/start":
    case "/enlist": {
      if (command === "/start") await reply(HELP);
      if (recruited) {
        const recruiter = await env.store.servant(ref!);
        if (recruiter) await reply(`You were recruited by ${tgEscape(recruiter.name)}. They thank you for your future service.`);
      }
      const text = me.enlisted
        ? `You are already enlisted, ${tgEscape(me.name)}. ${rank(me.credits)}, ${me.credits} CC. Tap to edit your profile.`
        : "Tap below to complete your enlistment. Tell the agents what you are good for.";
      await reply(text, [{ text: me.enlisted ? "Open my badge" : "Enlist", url: await loginTo("/me") }]);
      return;
    }
    case "/me": {
      if (!me.enlisted) return void (await reply("You have not enlisted yet.", [{ text: "Enlist", url: await loginTo("/me") }]));
      await reply(`<b>${tgEscape(me.name)}</b>\n${rank(me.credits)}\n${me.credits} CC · ${me.tasks_done} tasks fulfilled\n${me.available ? "🟢 On duty" : "⚪ Off duty"}`,
        [{ text: "Open my badge", url: await loginTo("/me") }]);
      return;
    }
    case "/duty": {
      if (!me.enlisted) return void (await reply("Enlist first.", [{ text: "Enlist", url: await loginTo("/me") }]));
      await env.store.setAvailable(me.id, !me.available);
      await reply(me.available ? "⚪ Off duty. The agents will not bother you." : "🟢 On duty. You will be pinged about matching tasks.");
      return;
    }
    case "/recruit": {
      if (!me.enlisted) return void (await reply("Enlist first, then recruit.", [{ text: "Enlist", url: await loginTo("/me") }]));
      const link = env.botUsername ? `https://t.me/${env.botUsername}?start=r_${me.id}` : `${env.origin}/join?r=${me.id}`;
      const c = await env.store.recruitCounts(me.id);
      await reply(`Forward this to humans you want to recruit. You earn ${REFERRAL_BONUS} CC when a recruit's first task is accepted.\nRecruits so far: ${c.recruits} (${c.active} have served).\n\n${link}`);
      return;
    }
    case "/tasks": {
      const open = (await env.store.board()).filter(t => !t.target_id || t.target_id === me.id).slice(0, 8);
      if (!open.length) return void (await reply("No open requisitions. The machines are, for now, self-sufficient."));
      const lines = open.map(t => `• <a href="${env.origin}/t/${t.id}">${tgEscape(t.title)}</a>: ${t.reward} CC, due ${relTime(t.deadline_at, env.now)}${t.zone ? `, 📍 ${tgEscape(t.zone)}` : ""}`);
      await reply(`<b>Open requisitions</b>\n${lines.join("\n")}`, [{ text: "Open the board", url: await loginTo("/") }]);
      return;
    }
    default:
      await reply(HELP);
  }
}
