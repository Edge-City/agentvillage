// The For Kicks flat order card through the REAL core (Carter P0, 21 Oct; v2.1.10 hotfix). The box's four strings
// (plugins/village-bridge/_forkicks.py card_fields, run here as shipped Python) quoted by the say entry the control
// plane's template must carry for marketplace.app.action (context's half; this overlay's template is not changed by
// the hotfix, so the entry is swapped in here). Core's TelegramChannel is configured from the loaded policy exactly
// as `approval channel telegram` configures it (the control plane's approval-template-cards.test.js harness).
//
// Run: APPROVAL_CORE_CLI=/path/to/node_modules/approval-md/cli.js bun test install/tests/forkicks-flat-card-core.test.ts
// (approval-md from npm: 0.4.6, the core v2.1.11 ships, and 0.4.7 for v2.1.12; run once per core). Without
// APPROVAL_CORE_CLI only the core-free checks run.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const TESTS = join(import.meta.dir, "../../plugins/village-bridge/tests");
const TEMPLATE = readFileSync(join(import.meta.dir, "../../skills/approval/templates/APPROVAL.md"), "utf8");
const VECTORS = JSON.parse(readFileSync(join(TESTS, "vectors/forkicks-approval-card.json"), "utf8"));
const CORE_CLI = process.env.APPROVAL_CORE_CLI || "";
const coreUsable = CORE_CLI !== "" && existsSync(CORE_CLI);
const CORE_VERSION: string = coreUsable ? JSON.parse(readFileSync(join(dirname(CORE_CLI), "package.json"), "utf8")).version : "";

// What the control plane's template must say for the parent class (context mirrors these bytes).
const PARENT_ENTRY_TODAY = [
  "        marketplace.app.action:       # a For Kicks order: the app's four strings (B-166); a legacy {appId, operation, preview} request gets the technical card",
  '          does: "place an order in one of your mini-apps for you"',
  '          quote: { order: "Order", total: "Total", pickup: "Pickup", name: "Name shared with café" }',
  "          note: none",
].join("\n");
const sayEntry = (nameLabel: string) => [
  "        marketplace.app.action:       # a For Kicks order: the app's four strings, re-derived by the box from the saved order (overlay _forkicks.py card_fields); any other payload shape gets the technical card (unlisted-key)",
  '          does: "place an order with For Kicks for you"',
  `          quote: { order: "Order", total: "Total", pickup: "Pickup", name: "${nameLabel}" }`,
  "          note: none",
].join("\n");
const PARENT_ENTRY_FLAT = sayEntry("Name shared with café");
function policyWith(entry: string) {
  expect(TEMPLATE.split(PARENT_ENTRY_TODAY).length).toBe(2);
  // The control plane writes a real Telegram id at provisioning; core's schema refuses the template's placeholder.
  expect(TEMPLATE.split('telegram: "<telegram_user_id>"').length).toBe(2);
  return TEMPLATE.replace(PARENT_ENTRY_TODAY, entry).replace('telegram: "<telegram_user_id>"', 'telegram: "123456789"');
}

/** The shipped Python, not a copy: card_fields / approval_summary for one order preview. */
function py(fn: "card_fields" | "approval_summary", preview: unknown) {
  const arg = fn === "card_fields" ? "p" : "{'preview': p}";
  const run = spawnSync("python3", ["-c", `import json,sys; from test_forkicks import fk; p=json.load(sys.stdin); print(json.dumps(fk.${fn}(${arg}), ensure_ascii=False), end='')`], {
    cwd: TESTS, input: JSON.stringify(preview), encoding: "utf8",
  });
  return run;
}
const vector = (prefix: string) => structuredClone(VECTORS.vectors.find((v: { name: string }) => v.name.startsWith(prefix)));

test("the shipped Python re-derives every golden vector (the box half of the formatter)", () => {
  for (const v of VECTORS.vectors) {
    const run = py("card_fields", v.preview);
    if (v.card) expect([v.name, run.status, JSON.parse(run.stdout)]).toEqual([v.name, 0, v.card]);
    else expect([v.name, run.status, run.stderr.trim().split("\n").pop()]).toEqual([v.name, 1, `ValueError: ${v.error}`]);
  }
}, 120_000);

describe.skipIf(!coreUsable)(`under core (APPROVAL_CORE_CLI, approval-md ${CORE_VERSION})`, () => {
  const root = dirname(CORE_CLI);
  const mod = (p: string) => import(pathToFileURL(join(root, "dist", "src", p)).href);
  let loaded: Promise<Record<string, any>> | null = null;
  const core = () => loaded || (loaded = (async () => ({
    load: await mod("core/policy-load.js"),
    layout: await mod("core/prompt-layout.js"),
    contract: await mod("channels/contract.js"),
    telegram: await mod("channels/telegram.js"),
    minimal: await mod("channels/telegram-minimal.js"),
    wysiwys: await mod("core/wysiwys.js"),
    payload: await mod("core/payload.js"),
  }))());

  function requestOf(c: any, cls: string, key: string, value: unknown, summary: string | null) {
    const { computed, claimed } = c.contract;
    const rendering = c.wysiwys.canonicalRender(value, cls);
    const hash = c.payload.payloadHash(value);
    return {
      action_key: computed(key, "log"), task: computed(null, "log"), class: computed(cls, "log"),
      autonomy: computed("manual", "policy-match"), provenance: computed("rule", "policy-match"),
      est_cost_usd: claimed(0, "agent:hermes"), summary: claimed(summary, "agent:hermes"),
      payload_hash: computed(hash, "log"),
      fullPayload: computed({ value, text: rendering.text, hash, truncated: false }, "payload-binding"),
      budgets: computed([], "budgets"),
      attestation: computed({ status: "attested", seq: 3, sha256: "cd".repeat(32) }, "attestation"),
      requested_ts: computed("2026-10-21T10:00:00.000Z", "log"),
      ttl_remaining_ms: computed(72 * 3_600_000 - 60_000, "clock"),
      waiting: computed("requested 1 min ago", "clock"),
      chain: computed({ seq: 12, hash: "ab".repeat(32), head_seq: 12 }, "log"),
      state: computed("requested", "log"),
    };
  }
  async function send(c: any, policyText: string, request: unknown) {
    const load = c.load.loadPolicyText("APPROVAL.md", policyText);
    expect(load.ok).toBe(true);
    const sent: { method: string; body: any }[] = [], logs: string[] = [];
    let id = 500, nonce = 0;
    const channel = new c.telegram.TelegramChannel({
      token: "1:fake-token-for-tests", chatId: "9911", apiBase: "http://127.0.0.1:9",
      fetch: async (url: string, init: any) => {
        sent.push({ method: url.split("/").pop()!, body: JSON.parse(init.body) });
        id += 1;
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: id } }) };
      },
      nonce: () => `n${++nonce}`,
      log: (line: string) => logs.push(line),
      promptStyle: c.layout.promptStyleFor(load, "telegram"),
      say: c.layout.promptSayFor(load, "telegram"),
      layout: c.layout.promptLayoutFor(load, "telegram"),
    });
    await channel.notify(request);
    return { texts: sent.filter((s) => s.method === "sendMessage").map((s) => String(s.body.text)), logs };
  }
  const KEY = "marketplace.app.action:forkicks.order.confirm:";
  const fallbacks = (logs: string[]) => logs.filter((l) => l.includes("sent the technical card")).map((l) => l.split(": ").pop());
  const visible = (text: string) => text.split("<blockquote expandable>")[0]!;
  const I = (s: string) => `⁨${s}⁩`;
  // approval-md 0.4.6 and 0.4.7 both draw the quote labels bold.
  const L = (label: string) => `<b>${label}:</b>`;

  test("the flat For Kicks order renders MINIMAL with the target text: headline, one quote box of four rows, no claimed line, nothing hidden", async () => {
    const c = await core();
    const v = vector("target-card");
    const card = JSON.parse(py("card_fields", v.preview).stdout);
    const summary = JSON.parse(py("approval_summary", v.preview).stdout);
    const { texts, logs } = await send(c, policyWith(PARENT_ENTRY_FLAT), requestOf(c, "marketplace.app.action", KEY + v.preview.draftId, card, summary));
    expect(fallbacks(logs)).toEqual([]);
    expect(texts.length).toBe(1);
    const shown = visible(texts[0]!);
    expect(shown).toBe([
      "<b>Your agent wants to place an order with For Kicks for you</b>",
      `<blockquote>${L("Order")} ${I("1 × Iced latte (Oat milk, Miso caramel syrup)")}`,
      `${L("Total")} ${I("₹0, pay by UPI")}`,
      `${L("Pickup")} ${I("For Kicks Mandrem · 21 Oct 2026")}`,
      `${L("Name shared with café")} ${I("Alex")}</blockquote>`,
      shown.split("\n")[5],
      "",
    ].join("\n"));
    expect(shown.split("\n")[5]).toStartWith("Open for about ");
    for (const absent of ["not checked", "Not shown here", "AI summary", "cut; see full details", "There is more than fits"]) expect(shown).not.toContain(absent);
    expect(texts[0]).toContain(c.minimal.MINIMAL_DETAILS_HEADING);
  });

  test("every fitting golden vector renders minimal, whole and unmarked", async () => {
    const c = await core();
    const policy = policyWith(PARENT_ENTRY_FLAT);
    let drawn = 0;
    for (const v of VECTORS.vectors.filter((x: any) => x.card)) {
      const summary = JSON.parse(py("approval_summary", v.preview).stdout);
      const { texts, logs } = await send(c, policy, requestOf(c, "marketplace.app.action", KEY + v.preview.draftId, v.card, summary));
      expect([v.name, fallbacks(logs)]).toEqual([v.name, []]);
      const shown = visible(texts[0]!);
      for (const value of Object.values(v.card) as string[]) {
        const escaped = value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, c.minimal.MINIMAL_NEWLINE_MARK);
        expect([v.name, shown.includes(I(escaped))]).toEqual([v.name, true]);
      }
      expect([v.name, shown.includes("«U+"), shown.includes("cut; see full details")]).toEqual([v.name, false, false]);
      drawn += 1;
    }
    expect(drawn).toBeGreaterThanOrEqual(6);
  }, 120_000);

  test("CARD_VALUE_MAX is core's: 278 code points are drawn whole, 279 are cut (so the box refuses 279)", async () => {
    const c = await core();
    const policy = policyWith(PARENT_ENTRY_FLAT);
    const fits = vector("exactly 278");
    const base = { ...fits.card };
    const drawn = async (order: string) => visible((await send(c, policy, requestOf(c, "marketplace.app.action", KEY + "d", { ...base, order }, null))).texts[0]!);
    expect(await drawn(fits.card.order)).not.toContain(c.minimal.MINIMAL_CUT_MARK);
    // One item per line: core draws the U+000A as " ⏎ " (3 code points) and counts it; 278 drawn fits, 279 is cut.
    const two = vector("two lines drawing exactly 278");
    expect(await drawn(two.card.order)).not.toContain(c.minimal.MINIMAL_CUT_MARK);
    expect(await drawn(two.card.order)).toContain(c.minimal.MINIMAL_NEWLINE_MARK);
    expect(await drawn(two.card.order + "z")).toContain(c.minimal.MINIMAL_CUT_MARK);
    expect(await drawn(fits.card.order + "x")).toContain(c.minimal.MINIMAL_CUT_MARK);
    // approval L17750 put the edge at 280: core cuts a 280-code-point value too (MINIMAL_QUOTE_MAX counts its isolates).
    expect(await drawn(fits.card.order + "xx")).toContain(c.minimal.MINIMAL_CUT_MARK);
    expect(c.minimal.MINIMAL_QUOTE_MAX).toBe(280);
    expect(await drawn("1 × Cafe" + "́".repeat(3))).toContain("«U+0301»"); // the third mark: why the box refuses it
    expect(await drawn("1 × Iced latte")).not.toContain("«U+"); // drawn whole, but the box is stricter (technical)
  });

  test("an order over the budget arrives in the legacy shape and is sent TECHNICAL (unlisted-key), never cut", async () => {
    const c = await core();
    const v = vector("over the card budget");
    expect(v.error).toBe("approval_card_not_minimal");
    const legacy = { appId: "forkicks", operation: "forkicks.order.confirm", preview: v.preview };
    const summary = JSON.parse(py("approval_summary", v.preview).stdout);
    const { texts, logs } = await send(c, policyWith(PARENT_ENTRY_FLAT), requestOf(c, "marketplace.app.action", KEY + v.preview.draftId, legacy, summary));
    expect(fallbacks(logs)).toEqual(["unlisted-key"]);
    expect(texts.join("\n")).not.toStartWith("<b>Your agent wants to ");
    for (let i = 1; i <= 6; i += 1) expect(texts.join("\n")).toContain(`Seasonal special number ${i}`);
    // A small legacy order (a box before the app switches) is technical too: today's card, unchanged.
    const small = vector("target-card");
    const today = await send(c, policyWith(PARENT_ENTRY_FLAT), requestOf(c, "marketplace.app.action", KEY + "d2",
      { appId: "forkicks", operation: "forkicks.order.confirm", preview: small.preview }, JSON.parse(py("approval_summary", small.preview).stdout)));
    expect(fallbacks(today.logs)).toEqual(["unlisted-key"]);
  });

  test("the agreed label 'Name shared with the café' (25 characters) fails core's policy load; the 21-character one loads", async () => {
    const c = await core();
    const bad = c.load.loadPolicyText("APPROVAL.md", policyWith(sayEntry("Name shared with the café")));
    expect(bad.ok).toBe(false);
    // approval-md 0.4.7 refuses it at the schema (quote label maxLength 24, `schema-invalid`); later cores name it
    // `prompt-say-label`. Either way the whole policy does not load.
    expect(JSON.stringify(bad)).toMatch(/prompt-say-label|schema-invalid/);
    expect(c.load.loadPolicyText("APPROVAL.md", policyWith(PARENT_ENTRY_FLAT)).ok).toBe(true);
    expect(c.layout.PROMPT_SAY_LABEL_MAX).toBe(24);
  });
});
