/**
 * DATA-412: the first welcome seeds up to three Index intents from the
 * intentions the resident selected at signup (`## Selected intentions` in the
 * app's profile, `$HERMES_HOME/USER.md`), once per box, then lists them.
 *
 *   bun test skills/index-network/scripts/tests/welcome-seed.test.ts
 *
 * The profile here is built by profileText below, a copy of the app's
 * (agentvillage-app src/lib/agent/profile-text.ts) kept byte for byte, so the
 * parser is pinned against the text the control plane actually writes. The
 * new welcome texts are pinned in fixtures/welcome-texts.json next to the six
 * older ones (welcome.test.ts), which this file shows are unchanged.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ALREADY_SENT,
  INTENTS_URL_MAX,
  MAX_LISTED,
  SEEDED_COPY,
  SELECTED_HEADING,
  TITLE_MAX,
  WELCOME_MAX_CHARS,
  WELCOME_SEED_FILE,
  WELCOME_STATE_FILE,
  type WelcomeBranch,
  claimSeed,
  createdIntent,
  draftTrailer,
  intentRows,
  main,
  seedKey,
  seedMode,
  selectedIntentions,
  welcomeName,
  welcomeRun,
  welcomeText,
  writeRefused,
} from "../welcome";
import { FAKE_API_KEY, type FakeCall, type ToolHandler, type ToolReply, indexMcpFake } from "./index-mcp-fake";
import golden from "./fixtures/welcome-texts.json";

const FIXTURE_PATH = join(import.meta.dir, "fixtures", "welcome-texts.json");
const INTENTS_URL = "https://agents.edgecity.live/intents";
/** sha256 of the six texts on origin/main 336fdec9, concatenated in this order. */
const OLD_KEYS = ["three", "moreThanThree", "two", "one", "zero", "unreachable"] as const;
const OLD_SHA256 = "a69563f1dedda0afab68f1348a7ff64522ec5779548b0cb1696ccce8e5e6123c";
const ASTRAL_NAME = "\u{20000}".repeat(32);
/** A text of `n` code points, words of four letters and a space (`n` > 0). */
const words = (n: number, letter = "w") => `${letter.repeat(4)} `.repeat(Math.ceil(n / 5)).slice(0, n).trimEnd().padEnd(n, letter);

// ── The app's profile, as the control plane writes it to USER.md ─────────────

type Draft = {
  profile: { name: string; whatYouDo: string; basedIn: string; staying: string; links: string };
  sources: Array<{ label: string; text: string }>;
  intentions: Array<{ category: string; text: string; kept: boolean }>;
  answers: Record<string, string[]>;
  offers: Array<{ title: string; detail: string }>;
  agentsDecideOffers: boolean;
};

/** agentvillage-app src/lib/agent/profile-text.ts profileText, byte for byte (comments dropped). */
function profileText(draft: Draft): string {
  const p = draft.profile;
  return [
    "# Participant profile",
    `Name: ${p.name}`,
    `Work: ${p.whatYouDo}`,
    `Based in: ${p.basedIn}`,
    `Staying: ${p.staying}`,
    `Links: ${p.links}`,
    draft.intentions.some((i) => i.kept)
      ? "Only the selected intentions below are current goals. Imported sources are background and may contain discarded suggestions; do not pursue those unless the participant selects them again."
      : "The participant has not selected intentions yet. Treat the context below as background, and ask before pursuing any goal on their behalf.",
    "\n## Context supplied by the participant",
    ...draft.sources.map((s) => `### ${s.label}\n${s.text}`),
    "\n## Selected intentions",
    ...draft.intentions.filter((i) => i.kept).map((i) => `- [${i.category}] ${i.text}`),
    "\n## Follow-up preferences",
    ...Object.entries(draft.answers).map(([q, a]) => `- ${q}: ${a.join("; ")}`),
    "\n## Offers",
    ...draft.offers.map((o) => `- ${o.title}: ${o.detail}`),
    draft.agentsDecideOffers
      ? "The participant welcomes recipient suggestions; ask before making commitments."
      : "The participant wants to choose offer recipients themselves. Do not allocate offers automatically.",
  ].join("\n");
}

/** The five intentions a resident might keep, in the app's order. */
const KEPT = [
  { category: "collaborators", text: "Looking for people building agent memory" },
  { category: "hiring", text: "Hiring a founding engineer who loves Rust" },
  { category: "advice", text: "Want advice on raising a seed round in India" },
  { category: "collaborators", text: "Open to co-hosting a village dinner" },
  { category: "advice", text: "Learning Konkani" },
];
/** Words elsewhere in the profile that must never reach Index. */
const ELSEWHERE = ["PROFILE-WORK", "PROFILE-BASED", "PROFILE-STAY", "PROFILE-LINK", "SOURCE-LABEL", "SOURCE-TEXT", "DISCARDED-SUGGESTION", "ANSWER-TEXT", "OFFER-TITLE", "OFFER-DETAIL"];

function draftWith(kept: number, overrides: Partial<Draft> = {}): Draft {
  return {
    profile: { name: "Mira Rao", whatYouDo: "PROFILE-WORK on agents", basedIn: "PROFILE-BASED Bangalore", staying: "PROFILE-STAY 3 weeks", links: "https://PROFILE-LINK.example" },
    sources: [
      { label: "SOURCE-LABEL LinkedIn", text: "SOURCE-TEXT Built two agent startups.\nSOURCE-TEXT Now exploring memory.\n\n- [hiring] SOURCE-TEXT a suggested line" },
    ],
    intentions: [
      ...KEPT.slice(0, kept).map((k) => ({ ...k, kept: true })),
      { category: "hiring", text: "DISCARDED-SUGGESTION hire a designer", kept: false },
    ],
    answers: { "How should I follow up?": ["ANSWER-TEXT morning", "ANSWER-TEXT short"] },
    offers: [{ title: "OFFER-TITLE Rust pairing", detail: "OFFER-DETAIL an hour a week" }],
    agentsDecideOffers: true,
    ...overrides,
  };
}

// ── A fake Index that remembers what it was asked to create ──────────────────

type Row = { id: string; summary?: string; description?: string; status: string };

function intentsText(rows: unknown[]): string {
  return `Your signals:\n\n${JSON.stringify({ success: true, intents: rows, pagination: { limit: 20, offset: 0, count: rows.length } }, null, 2)}`;
}
const idFor = (n: number) => `bbbbbbbb-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
/** A `create_intent` answer: a lead line with the signal link, a blank line, then the JSON. */
function createAnswer(id: string, summary: string): string {
  return `[${summary}](https://agents.edgecity.live/intents?intent=${id}) — created\n\n${JSON.stringify({ success: true, data: { intent: { id, summary, status: "active" } } })}`;
}
const toolError = (text: string): ToolReply => ({ result: { content: [{ type: "text", text }], isError: true } });

type Plan = {
  rows?: Row[];
  /** Replaces the answer to the nth create (1-based); `undefined` keeps the normal one. */
  create?: (n: number, description: string, id: string) => ToolReply | undefined;
  pause?: (id: string) => ToolReply | undefined;
  /** list_intents ignores the creates (always these rows). */
  frozen?: boolean;
  list?: (n: number) => ToolReply | undefined;
};

function fakeIndex(plan: Plan = {}) {
  const rows: Row[] = plan.rows ? plan.rows.map((r) => ({ ...r })) : [];
  const frozen = rows.map((r) => ({ ...r }));
  let creates = 0;
  let lists = 0;
  const tools: Record<string, ToolHandler> = {
    list_intents: () => {
      lists++;
      return plan.list?.(lists) ?? intentsText(plan.frozen ? frozen : rows);
    },
    create_intent: (args) => {
      creates++;
      const description = String(args.description);
      const id = idFor(0x100 + creates);
      const replaced = plan.create?.(creates, description, id);
      if (replaced !== undefined) return replaced;
      rows.push({ id, summary: description, status: "active" });
      return createAnswer(id, description);
    },
    pause_intent: (args) => {
      const id = String(args.intentId);
      const replaced = plan.pause?.(id);
      if (replaced !== undefined) return replaced;
      const row = rows.find((r) => r.id === id);
      if (!row) return toolError("No such intent.");
      row.status = "paused";
      return `[${row.summary}](https://agents.edgecity.live/intents?intent=${id}) — paused\n\n${JSON.stringify({ success: true, data: { intentId: id, status: "paused", changed: true } })}`;
    },
  };
  return { fake: indexMcpFake({ tools }), rows };
}

const VARS = ["INDEX_API_KEY", "INDEX_MCP_URL", "AV_CONNECTIONS_URL", "HERMES_HOME", "AV_WELCOME_SEED_MODE"];
const saved: Record<string, string | undefined> = {};
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "av-welcome-seed-"));
  for (const key of VARS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  for (const key of VARS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function writeUserMd(text: string): void {
  writeFileSync(join(home, "USER.md"), text);
}
function writeNickname(nickname: string): void {
  writeFileSync(join(home, "av-profile.json"), JSON.stringify({ version: 1, nickname, about_me: "", interests: [], preferences: {} }));
}

/** welcomeRun against `index`; the text, the branch, and the tool calls in order. */
async function run(index: ReturnType<typeof fakeIndex>, argv: string[] = [], options: { timeoutMs?: number; budgetMs?: number } = {}) {
  process.env.INDEX_API_KEY = FAKE_API_KEY;
  process.env.INDEX_MCP_URL = index.fake.url;
  const out = await welcomeRun(["--home", home, ...argv], { fetch: index.fake.fetch, timeoutMs: options.timeoutMs ?? 200, budgetMs: options.budgetMs });
  const calls = index.fake.calls.filter((c) => c.method === "tools/call");
  return { ...out, calls, names: calls.map((c) => c.name) };
}
const creates = (calls: FakeCall[]) => calls.filter((c) => c.name === "create_intent");
const seedMarker = () => JSON.parse(readFileSync(join(home, WELCOME_SEED_FILE), "utf8"));
const listedLines = (text: string) => text.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2));

// ── The parser ───────────────────────────────────────────────────────────────

describe("selectedIntentions: the profile's selected intentions, in order, as the resident's own words", () => {
  for (const n of [0, 1, 3, 5]) {
    test(`${n} kept: exactly their texts, in order, and nothing else of the profile`, () => {
      const text = profileText(draftWith(n));
      writeUserMd(text);
      // The fixture is the app's shape: the heading is always there, after a blank line.
      expect(text).toContain(`\n\n${SELECTED_HEADING}\n`);
      expect(selectedIntentions(home)).toEqual(KEPT.slice(0, n).map((k) => k.text));
    });
  }

  test("a line of another shape, or empty after its tag, is skipped; a `]` inside the text stays", () => {
    writeUserMd(
      [
        "# Participant profile",
        "",
        SELECTED_HEADING,
        "- [advice] Learn [Rust] fast, with a mentor]",
        "- [hiring]   ",
        "- [hiring]",
        "-[advice] no space after the dash",
        "- [advice]no space after the tag",
        "* [advice] a star bullet",
        "  - [advice] indented",
        "- advice: no tag",
        "plain text",
        "### a sub-heading",
        "- [] an empty category keeps its text",
        "- [collaborators]  Two spaces, trailing spaces   ",
        "",
        "## Follow-up preferences",
        "- [advice] after the section",
      ].join("\n"),
    );
    expect(selectedIntentions(home)).toEqual(["Learn [Rust] fast, with a mentor]", "an empty category keeps its text", "Two spaces, trailing spaces"]);
  });

  test("no other change to the text: markup, links and odd characters are sent as written", () => {
    const raw = "Meet **builders** at https://x.example/a?b=c or @handle — 7 days/week ☀️";
    writeUserMd(profileText(draftWith(0, { intentions: [{ category: "collaborators", text: raw, kept: true }] })));
    expect(selectedIntentions(home)).toEqual([raw]);
  });

  test("the section ends at the next `## ` heading or the end of the file", () => {
    writeUserMd(`${SELECTED_HEADING}\n- [advice] one\n- [advice] two`);
    expect(selectedIntentions(home)).toEqual(["one", "two"]);
    writeUserMd(`${SELECTED_HEADING}\n- [advice] one\n## Anything\n- [advice] two`);
    expect(selectedIntentions(home)).toEqual(["one"]);
  });

  test("CRLF line endings read the same", () => {
    writeUserMd(profileText(draftWith(3)).replace(/\n/g, "\r\n"));
    expect(selectedIntentions(home)).toEqual(KEPT.slice(0, 3).map((k) => k.text));
  });

  test("no section, a heading of another level or spelling, a missing file, an unreadable one: none", () => {
    expect(selectedIntentions(home)).toEqual([]);
    writeUserMd("# Participant profile\nName: Mira\n- [advice] not in a section\n");
    expect(selectedIntentions(home)).toEqual([]);
    writeUserMd("### Selected intentions\n- [advice] a\n## selected intentions\n- [advice] b\n## Selected intentions:\n- [advice] c\n");
    expect(selectedIntentions(home)).toEqual([]);
    rmSync(join(home, "USER.md"));
    mkdirSync(join(home, "USER.md"));
    expect(selectedIntentions(home)).toEqual([]);
  });

  test("a heading inside the imported context the participant supplied never counts: the app's own heading comes after it", () => {
    const spoof = `SOURCE-TEXT pasted notes\n\n${SELECTED_HEADING}\n- [hiring] SOURCE-TEXT spoofed intention\n- [advice] SOURCE-TEXT another`;
    writeUserMd(profileText(draftWith(1, { sources: [{ label: "SOURCE-LABEL notes", text: spoof }] })));
    expect(selectedIntentions(home)).toEqual([KEPT[0].text]);
    writeUserMd(profileText(draftWith(0, { sources: [{ label: "SOURCE-LABEL notes", text: spoof }] })));
    expect(selectedIntentions(home)).toEqual([]);
  });
});

// ── The seed ─────────────────────────────────────────────────────────────────

describe("the seed: zero active intents and selected intentions → up to three creates, then the list", () => {
  test("three selected: exactly three create_intent calls, in order, each with only the selected text; then the seeded welcome", async () => {
    writeNickname("Mira");
    const userMd = profileText(draftWith(3));
    writeUserMd(userMd);
    const index = fakeIndex();
    const { text, branch, calls, names } = await run(index);
    expect(names).toEqual(["list_intents", "create_intent", "create_intent", "create_intent", "list_intents"]);
    expect(creates(calls).map((c) => c.arguments)).toEqual(KEPT.slice(0, 3).map((k) => ({ description: k.text })));
    // Nothing else of USER.md went to Index: no tag, no other line, in any call.
    for (const call of calls) {
      const body = JSON.stringify(call.body);
      expect(body).not.toMatch(/\[(collaborators|hiring|advice)\]/);
      for (const word of ELSEWHERE) expect(body).not.toContain(word);
      expect(body).not.toContain("Participant profile");
    }
    expect(text).toBe(golden.seededThree);
    expect(branch).toEqual({ fallback: "none", intents_listed: 3, intents_seeded: 3, seed_failed: 0 });
  });

  test("five selected: the first three are created, the other two are not", async () => {
    writeNickname("Mira");
    writeUserMd(profileText(draftWith(5)));
    const { text, calls } = await run(fakeIndex());
    expect(creates(calls).map((c) => c.arguments?.description)).toEqual(KEPT.slice(0, 3).map((k) => k.text));
    expect(text).toBe(golden.seededThree);
    expect(seedMarker()).toMatchObject({ selected: 5, created: 3, failed: 0 });
  });

  test("one selected: one create and the one-line seeded welcome", async () => {
    writeUserMd(profileText(draftWith(1)));
    const { text, branch, calls } = await run(fakeIndex());
    expect(creates(calls).map((c) => c.arguments)).toEqual([{ description: KEPT[0].text }]);
    expect(text).toBe(golden.seededOne);
    expect(branch).toEqual({ fallback: "none", intents_listed: 1, intents_seeded: 1, seed_failed: 0 });
  });

  test("none selected and no active intents: no create, no marker, today's questions text byte for byte", async () => {
    writeUserMd(profileText(draftWith(0)));
    const { text, names, branch } = await run(fakeIndex());
    expect(names).toEqual(["list_intents"]);
    expect(text).toBe(golden.zero);
    expect(branch).toEqual({ fallback: "questions", intents_listed: 0, intents_seeded: 0, seed_failed: 0 });
    expect(existsSync(join(home, WELCOME_SEED_FILE))).toBe(false);
  });

  test("an active intent already there: no create, no marker, today's listed text", async () => {
    writeNickname("Mira");
    writeUserMd(profileText(draftWith(3)));
    const rows = [
      { id: idFor(1), summary: "Looking for people building agent memory", status: "active" },
      { id: idFor(2), summary: "Open to co-hosting a village dinner", status: "active" },
      { id: idFor(3), summary: "Want a surfing buddy for early mornings", status: "active" },
    ];
    const { text, names, branch } = await run(fakeIndex({ rows }));
    expect(names).toEqual(["list_intents"]);
    expect(text).toBe(golden.three);
    expect(branch).toEqual({ fallback: "none", intents_listed: 3, intents_seeded: 0, seed_failed: 0 });
    expect(existsSync(join(home, WELCOME_SEED_FILE))).toBe(false);
  });

  test("Index unreachable: no create, no marker, today's unreachable text", async () => {
    writeUserMd(profileText(draftWith(3)));
    for (const list of [() => ({ response: new Response("down", { status: 503 }) }), () => toolError("Could not list intents."), () => "no json at all"] as const) {
      const index = fakeIndex({ list });
      const { text, names, branch } = await run(index, ["--draft"]);
      expect(names).toEqual(["list_intents"]);
      expect(text).toBe(golden.unreachable);
      expect(branch).toEqual({ fallback: "unreachable", intents_listed: 0, intents_seeded: 0, seed_failed: 0 });
    }
    // No key: no call at all.
    const index = fakeIndex();
    process.env.INDEX_MCP_URL = index.fake.url;
    process.env.INDEX_API_KEY = "";
    const out = await welcomeRun(["--home", home, "--draft"], { fetch: index.fake.fetch, timeoutMs: 200 });
    expect(out.text).toBe(golden.unreachable);
    expect(index.fake.calls).toHaveLength(0);
    expect(existsSync(join(home, WELCOME_SEED_FILE))).toBe(false);
  });

  for (const [label, reply] of [
    ["a throw (HTTP 503)", { response: new Response("down", { status: 503 }) }],
    ["an isError answer", toolError("Could not create the intent.")],
    ["intent_needs_revision", "That intent is too vague to match on (intent_needs_revision). Nothing was created."],
    ["success false", `Too vague.\n\n${JSON.stringify({ success: false, error: "too vague" })}`],
  ] as const) {
    test(`one create failing (${label}): the others are created, seed_failed 1, and the welcome lists what is active`, async () => {
      writeNickname("Mira");
      writeUserMd(profileText(draftWith(3)));
      const index = fakeIndex({ create: (n) => (n === 2 ? (reply as ToolReply) : undefined) });
      const { text, branch, calls } = await run(index, ["--draft"]);
      expect(creates(calls).map((c) => c.arguments?.description)).toEqual(KEPT.slice(0, 3).map((k) => k.text));
      expect(branch).toEqual({ fallback: "none", intents_listed: 2, intents_seeded: 2, seed_failed: 1 });
      expect(listedLines(text)).toEqual([KEPT[0].text, KEPT[2].text]);
      expect(text).toContain(`\n\n${SEEDED_COPY.publish.lead}\n`);
      expect(seedMarker()).toMatchObject({ selected: 3, created: 2, failed: 1 });
    });
  }

  test("every create failing: nothing seeded, so today's text from the list (no active intent: the questions)", async () => {
    writeUserMd(profileText(draftWith(3)));
    const { text, branch, names } = await run(fakeIndex({ create: () => toolError("down") }), ["--draft"]);
    expect(names).toEqual(["list_intents", "create_intent", "create_intent", "create_intent", "list_intents"]);
    expect(text).toBe(golden.zero);
    expect(branch).toEqual({ fallback: "questions", intents_listed: 0, intents_seeded: 0, seed_failed: 3 });
  });

  test("a create that timed out but landed: not counted as seeded, and the second list shows it under today's lead", async () => {
    writeUserMd(profileText(draftWith(1)));
    const index = fakeIndex({
      create: (_n, description, id) => {
        index.rows.push({ id, summary: description, status: "active" });
        return { hang: true };
      },
    });
    const { text, branch } = await run(index, ["--draft"], { timeoutMs: 50 });
    expect(branch).toEqual({ fallback: "none", intents_listed: 1, intents_seeded: 0, seed_failed: 1 });
    expect(text).toContain("Here's what I have you down for so far:\n- Looking for people building agent memory\n");
  });

  test("the second list failing: the titles come from the create answers, else the selected texts, cleaned", async () => {
    writeUserMd(profileText(draftWith(3, { intentions: [
      { category: "advice", text: "Meet **builders** at evil.example", kept: true },
      { category: "advice", text: "Second want", kept: true },
    ] })));
    const index = fakeIndex({
      list: (n) => (n === 2 ? { response: new Response("down", { status: 503 }) } : undefined),
      // The first answer names an id only (no summary): its title is the selected text, cleaned.
      create: (n, _d, id) => (n === 1 ? `Created.\n\n${JSON.stringify({ success: true, data: { intentId: id } })}` : createAnswer(id, "Index's own summary")),
    });
    const { text, branch } = await run(index, ["--draft"]);
    expect(branch).toMatchObject({ intents_seeded: 2, seed_failed: 0, intents_listed: 2 });
    expect(listedLines(text)).toEqual(["Meet builders at evil. example", "Index's own summary"]);
  });

  test("a create answer with no id: its intent is matched in the second list by the text sent, so it is listed once, under Index's title", async () => {
    writeUserMd(profileText(draftWith(2)));
    const index = fakeIndex({
      create: (n, description, id) => {
        index.rows.push({ id, summary: `Index's words for want ${n}`, description, status: "active" });
        return n === 1 ? "Created your signal." : createAnswer(id, `Index's words for want ${n}`);
      },
    });
    const { text, branch } = await run(index, ["--draft"]);
    expect(branch).toEqual({ fallback: "none", intents_listed: 2, intents_seeded: 2, seed_failed: 0 });
    expect(listedLines(text)).toEqual(["Index's words for want 1", "Index's words for want 2"]);
  });

  test("dedupe: a selected line repeating an earlier one, or any listed intent whatever its status, is skipped and not counted", async () => {
    writeUserMd(
      profileText(
        draftWith(0, {
          intentions: [
            { category: "advice", text: "Learning Konkani", kept: true },
            { category: "advice", text: "  learning **KONKANI** ", kept: true },
            { category: "hiring", text: "Resting want", kept: true },
            { category: "hiring", text: "Old want", kept: true },
            { category: "hiring", text: "Described differently", kept: true },
            { category: "advice", text: "https://only-a-link.example/x", kept: true },
            { category: "collaborators", text: "Fresh want one", kept: true },
            { category: "collaborators", text: "Fresh want two", kept: true },
            { category: "collaborators", text: "Fresh want three", kept: true },
          ],
        }),
      ),
    );
    const rows = [
      { id: idFor(1), summary: "Resting want", status: "paused" },
      { id: idFor(2), summary: "OLD WANT", status: "archived" },
      { id: idFor(3), summary: "Index's summary", description: "described differently", status: "archived" },
    ];
    const { calls, branch, text } = await run(fakeIndex({ rows }), ["--draft"]);
    expect(creates(calls).map((c) => c.arguments?.description)).toEqual(["Learning Konkani", "Fresh want one", "Fresh want two"]);
    expect(branch).toEqual({ fallback: "none", intents_listed: 3, intents_seeded: 3, seed_failed: 0 });
    expect(listedLines(text)).toEqual(["Learning Konkani", "Fresh want one", "Fresh want two"]);
  });

  test("every selected line already listed (paused or archived): no create and no marker", async () => {
    writeUserMd(profileText(draftWith(1)));
    const rows = [{ id: idFor(1), summary: KEPT[0].text.toUpperCase(), status: "paused" }];
    const { names, text } = await run(fakeIndex({ rows }));
    expect(names).toEqual(["list_intents"]);
    expect(text).toBe(golden.zero);
    expect(existsSync(join(home, WELCOME_SEED_FILE))).toBe(false);
  });

  test("a long selected line is sent whole; the welcome shows it cut at TITLE_MAX", async () => {
    const long = `${words(TITLE_MAX + 100)} end`;
    writeUserMd(profileText(draftWith(0, { intentions: [{ category: "advice", text: long, kept: true }] })));
    const { calls, text } = await run(fakeIndex(), ["--draft"]);
    expect(creates(calls).map((c) => c.arguments)).toEqual([{ description: long }]);
    const [line] = listedLines(text);
    expect(line.endsWith("…")).toBe(true);
    expect([...line].length).toBeLessThanOrEqual(TITLE_MAX);
  });

  test("the seed never writes to stderr or the console on any path", async () => {
    writeUserMd(profileText(draftWith(3)));
    const written: string[] = [];
    const originals = { error: console.error, log: console.log, warn: console.warn, write: process.stderr.write };
    console.error = console.log = console.warn = (...a: unknown[]) => void written.push(a.join(" "));
    process.stderr.write = ((s: string) => (written.push(String(s)), true)) as typeof process.stderr.write;
    try {
      await run(fakeIndex({ create: (n) => (n === 2 ? toolError("x") : undefined) }));
      process.env.AV_WELCOME_SEED_MODE = "paused";
      rmSync(join(home, WELCOME_SEED_FILE));
      rmSync(join(home, WELCOME_STATE_FILE));
      await run(fakeIndex({ create: (n, _d, id) => (n === 1 ? `Created.\n\n${JSON.stringify({ success: true })}` : createAnswer(id, "x")) }), ["--draft"]);
    } finally {
      Object.assign(console, { error: originals.error, log: originals.log, warn: originals.warn });
      process.stderr.write = originals.write;
    }
    expect(written).toEqual([]);
  });

  test("a call that would start with too little of the run's budget left is not made, and counts as failed", async () => {
    writeUserMd(profileText(draftWith(3)));
    // No budget at all: the marker is claimed, nothing is sent, all three fail, and the first read stands.
    const none = await run(fakeIndex(), ["--draft"], { budgetMs: 0 });
    expect(none.names).toEqual(["list_intents"]);
    expect(none.branch).toEqual({ fallback: "questions", intents_listed: 0, intents_seeded: 0, seed_failed: 3 });
    expect(seedMarker()).toMatchObject({ selected: 3, created: 0, failed: 3 });
    rmSync(join(home, WELCOME_SEED_FILE));
    // Budget for one hanging create (200 ms of 350, so 150 ms of slack either way): the second and third, and the second list, are never sent.
    const one = await run(fakeIndex({ create: () => ({ hang: true }) }), ["--draft"], { timeoutMs: 200, budgetMs: 350 });
    expect(one.names).toEqual(["list_intents", "create_intent"]);
    expect(one.branch).toEqual({ fallback: "questions", intents_listed: 0, intents_seeded: 0, seed_failed: 3 });
  });
});

describe("the seed marker: the creates run once per box, in both modes", () => {
  test("claimed exclusively before the first create, then rewritten with the counts (0600, these four keys)", async () => {
    writeUserMd(profileText(draftWith(3)));
    const now = new Date("2026-10-11T04:30:00.000Z");
    process.env.INDEX_API_KEY = FAKE_API_KEY;
    const index = fakeIndex({
      create: (n) => {
        if (n === 1) expect(JSON.parse(readFileSync(join(home, WELCOME_SEED_FILE), "utf8"))).toEqual({ seededAt: now.toISOString(), selected: 3, created: 0, failed: 0 });
        return undefined;
      },
    });
    process.env.INDEX_MCP_URL = index.fake.url;
    await welcomeRun(["--home", home], { fetch: index.fake.fetch, timeoutMs: 200, now });
    const raw = readFileSync(join(home, WELCOME_SEED_FILE), "utf8");
    expect(raw).toBe(`${JSON.stringify({ seededAt: now.toISOString(), selected: 3, created: 3, failed: 0 })}\n`);
    expect(statSync(join(home, WELCOME_SEED_FILE)).mode & 0o777).toBe(0o600);
  });

  for (const [label, content] of [
    ["the seed's own", '{"seededAt":"2026-10-11T04:30:00.000Z","selected":3,"created":0,"failed":3}\n'],
    ["empty", ""],
    ["not JSON", "seeded"],
  ] as const) {
    test(`a marker that exists (${label}) means no create, even with no active intent and lines selected; it is left as it was`, async () => {
      writeUserMd(profileText(draftWith(3)));
      mkdirSync(join(home, "memory"), { recursive: true });
      writeFileSync(join(home, WELCOME_SEED_FILE), content);
      const { names, text, branch } = await run(fakeIndex(), ["--draft"]);
      expect(names).toEqual(["list_intents"]);
      expect(text).toBe(golden.zero);
      expect(branch).toEqual({ fallback: "questions", intents_listed: 0, intents_seeded: 0, seed_failed: 0 });
      expect(readFileSync(join(home, WELCOME_SEED_FILE), "utf8")).toBe(content);
    });
  }

  test("two runs in one home create once: the second sees the marker (Index still lists nothing, so only the marker stops it)", async () => {
    writeUserMd(profileText(draftWith(3)));
    const index = fakeIndex({ frozen: true });
    const first = await run(index, ["--draft"]);
    expect(creates(first.calls)).toHaveLength(3);
    const second = await run(index, ["--draft"]);
    expect(creates(second.calls)).toHaveLength(3); // the same three: none added
    expect(second.names.slice(first.names.length)).toEqual(["list_intents"]);
    // And a default run after them: still no create.
    const third = await run(index);
    expect(creates(third.calls)).toHaveLength(3);
  });

  test("--draft claims the seed marker and never the welcome marker; the default run then welcomes without creating", async () => {
    writeUserMd(profileText(draftWith(3)));
    const index = fakeIndex();
    const draft = await run(index, ["--draft"]);
    expect(draft.text).toBe(welcomeText("Edge", { kind: "listed", titles: KEPT.slice(0, 3).map((k) => k.text), seeded: "publish" }, INTENTS_URL));
    expect(existsSync(join(home, WELCOME_SEED_FILE))).toBe(true);
    expect(existsSync(join(home, WELCOME_STATE_FILE))).toBe(false);
    const plain = await run(index);
    expect(creates(plain.calls)).toHaveLength(3);
    // Three active intents now: today's listed text, and the welcome marker claimed.
    expect(plain.text).toContain("Here's what I have you down for so far:");
    expect(existsSync(join(home, WELCOME_STATE_FILE))).toBe(true);
    expect((await run(index)).text).toBe(ALREADY_SENT);
  });

  test("a welcome already sent: ALREADY_SENT before any Index call, so no seed", async () => {
    writeUserMd(profileText(draftWith(3)));
    mkdirSync(join(home, "memory"), { recursive: true });
    writeFileSync(join(home, WELCOME_STATE_FILE), JSON.stringify({ welcomeSent: true, sentAt: "2026-10-06T10:00:00.000Z" }));
    const { text, names } = await run(fakeIndex());
    expect(text).toBe(ALREADY_SENT);
    expect(names).toEqual([]);
    expect(existsSync(join(home, WELCOME_SEED_FILE))).toBe(false);
  });

  test("a marker that cannot be written: no create at all (memory/ is a file)", async () => {
    writeUserMd(profileText(draftWith(3)));
    writeFileSync(join(home, "memory"), "not a directory");
    const { names, text } = await run(fakeIndex(), ["--draft"]);
    expect(names).toEqual(["list_intents"]);
    expect(text).toBe(golden.zero);
  });

  test("two runs at once in one home: one seeds and the other only lists, three creates in all (across processes the exclusive claim decides: claimSeed below)", async () => {
    writeUserMd(profileText(draftWith(3)));
    const index = fakeIndex({ frozen: true });
    process.env.INDEX_API_KEY = FAKE_API_KEY;
    process.env.INDEX_MCP_URL = index.fake.url;
    const both = await Promise.all([1, 2].map(() => welcomeRun(["--home", home, "--draft"], { fetch: index.fake.fetch, timeoutMs: 200 })));
    expect(creates(index.fake.calls)).toHaveLength(3);
    expect(both.map((b) => b.branch?.intents_seeded).sort()).toEqual([0, 3]);
  });

  test("claimSeed: exactly one of two claims wins", () => {
    expect(claimSeed(home, 3)).toBe(true);
    expect(claimSeed(home, 3)).toBe(false);
  });
});

describe("AV_WELCOME_SEED_MODE=paused: create, then pause each one created", () => {
  test("create then pause_intent with the created id, line by line; the paused welcome", async () => {
    writeNickname("Mira");
    writeUserMd(profileText(draftWith(3)));
    process.env.AV_WELCOME_SEED_MODE = "paused";
    const index = fakeIndex();
    const { text, branch, calls, names } = await run(index, ["--draft"]);
    expect(names).toEqual(["list_intents", "create_intent", "pause_intent", "create_intent", "pause_intent", "create_intent", "pause_intent", "list_intents"]);
    expect(calls.filter((c) => c.name === "pause_intent").map((c) => c.arguments)).toEqual([0x101, 0x102, 0x103].map((n) => ({ intentId: idFor(n) })));
    expect(index.rows.map((r) => r.status)).toEqual(["paused", "paused", "paused"]);
    expect(text).toBe(golden.seededPausedThree);
    expect(branch).toEqual({ fallback: "none", intents_listed: 3, intents_seeded: 3, seed_failed: 0 });
  });

  test("the mode from $HERMES_HOME/.env; any other value publishes", () => {
    expect(seedMode(home)).toBe("publish");
    writeFileSync(join(home, ".env"), "AV_WELCOME_SEED_MODE=paused\n");
    expect(seedMode(home)).toBe("paused");
    process.env.AV_WELCOME_SEED_MODE = "PAUSED ";
    expect(seedMode(home)).toBe("paused");
    for (const value of ["publish", "draft", "", "pause"]) {
      process.env.AV_WELCOME_SEED_MODE = value;
      expect(seedMode(home)).toBe("publish");
    }
  });

  test("an id the create answer does not name: that line fails, no pause is sent for it, and nothing is retried", async () => {
    writeUserMd(profileText(draftWith(3)));
    process.env.AV_WELCOME_SEED_MODE = "paused";
    const index = fakeIndex({
      create: (n, description, id) => {
        if (n !== 2) return undefined;
        index.rows.push({ id, summary: description, status: "active" });
        return `Created your signal.\n\n${JSON.stringify({ success: true, data: { networkIds: [] } })}`;
      },
    });
    const { names, branch, text } = await run(index, ["--draft"]);
    expect(names).toEqual(["list_intents", "create_intent", "pause_intent", "create_intent", "create_intent", "pause_intent", "list_intents"]);
    expect(branch).toEqual({ fallback: "none", intents_listed: 2, intents_seeded: 2, seed_failed: 1 });
    // The paused lead names only what it paused.
    expect(listedLines(text)).toEqual([KEPT[0].text, KEPT[2].text]);
    expect(text).toContain(`\n\n${SEEDED_COPY.paused.lead}\n`);
  });

  test("a pause that fails counts its line as failed", async () => {
    writeUserMd(profileText(draftWith(1)));
    process.env.AV_WELCOME_SEED_MODE = "paused";
    const { names, branch, text } = await run(fakeIndex({ pause: () => toolError("cannot pause") }), ["--draft"]);
    expect(names).toEqual(["list_intents", "create_intent", "pause_intent", "list_intents"]);
    expect(branch).toEqual({ fallback: "none", intents_listed: 1, intents_seeded: 0, seed_failed: 1 });
    expect(text).toContain("Here's what I have you down for so far:");
  });
});

describe("the answers the seed reads", () => {
  test("createdIntent: the id and title in each shape, the link when that is all, null for a refusal", () => {
    const id = idFor(9);
    expect(createdIntent(createAnswer(id, "A **want**"))).toEqual({ id, title: "A want" });
    expect(createdIntent(`[x](u)\n${JSON.stringify({ success: true, data: { intentId: id } })}`)).toEqual({ id, title: null });
    expect(createdIntent(`${JSON.stringify({ success: true, data: { intents: [{ id, description: "From description" }] } })}`)).toEqual({ id, title: "From description" });
    expect(createdIntent(`${JSON.stringify({ intent: { id, summary: "Top" } })}`)).toEqual({ id, title: "Top" });
    expect(createdIntent(`${JSON.stringify({ intentId: id })}`)).toEqual({ id, title: null });
    expect(createdIntent(`[x](https://agents.edgecity.live/intents?intent=${id}) — created`)).toEqual({ id, title: null });
    expect(createdIntent(`[x](https://index.network/i/${id}) — created`)).toEqual({ id, title: null });
    expect(createdIntent(`[a](https://index.network/i/${id}) and [b](https://index.network/i/${idFor(10)})`)).toEqual({ id: null, title: null });
    expect(createdIntent(`${JSON.stringify({ data: { intent: { id: "bad id; rm -rf" } } })}`)).toEqual({ id: null, title: null });
    expect(createdIntent("intent_needs_revision: say more")).toBeNull();
    expect(createdIntent(JSON.stringify({ success: false, data: { intentId: id } }))).toBeNull();
    expect(writeRefused(JSON.stringify({ success: "true" }))).toBe(true);
    expect(writeRefused("Paused.")).toBe(false);
  });

  test("intentRows: every row whatever its status, with its id, activity, title and keys", () => {
    const rows = intentRows(intentsText([
      { id: idFor(1), summary: "A", status: "active" },
      { id: idFor(2), summary: "", description: "B text", status: "paused" },
      { id: idFor(3), summary: "C", description: "C long", status: "archived" },
      "not a row",
    ]));
    expect(rows).toEqual([
      { id: idFor(1), active: true, title: "A", keys: ["a"] },
      { id: idFor(2), active: false, title: "B text", keys: ["b text"] },
      { id: idFor(3), active: false, title: "C", keys: ["c", "c long"] },
    ]);
  });

  test("seedKey: the welcome's cleaning, lower-cased; null when nothing showable is left", () => {
    expect(seedKey("  Learning **KONKANI** ")).toBe("learning konkani");
    expect(seedKey("https://only-a-link.example/x")).toBeNull();
    expect(seedKey("")).toBeNull();
  });
});

// ── The texts ────────────────────────────────────────────────────────────────

describe("the seeded texts", () => {
  test("the six older fixture texts are byte for byte as on origin/main; the three new ones are there", () => {
    const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Record<string, string>;
    const hash = new Bun.CryptoHasher("sha256").update(OLD_KEYS.map((k) => fixture[k]).join("")).digest("hex");
    expect(hash).toBe(OLD_SHA256);
    expect(Object.keys(fixture)).toEqual([...OLD_KEYS, "seededThree", "seededOne", "seededPausedThree"]);
  });

  test("the seeded welcome's parts, exactly", () => {
    const three = KEPT.slice(0, 3).map((k) => k.text);
    for (const mode of ["publish", "paused"] as const) {
      const text = welcomeText("Mira", { kind: "listed", titles: three, seeded: mode }, INTENTS_URL);
      expect(text.split("\n\n")).toEqual([
        "Welcome to Edge City India ☀️",
        "Mandrem, Goa, October 11 to November 1. I'm Mira, your personal agent for your time in the village.",
        [SEEDED_COPY[mode].lead, ...three.map((t) => `- ${t}`)].join("\n"),
        "I'll keep watch for people and events that fit these and bring the best to your morning brief.",
        SEEDED_COPY[mode].close,
      ]);
      expect(text).not.toContain("Intents page");
    }
    expect(SEEDED_COPY.publish).toEqual({
      lead: "From what you told me at signup, I've set up these signals:",
      close: "Say change or pause to adjust any of them, or tell me a new one.",
    });
    expect(SEEDED_COPY.paused).toEqual({
      lead: "From what you told me at signup, I've drafted these signals, paused until you say go:",
      close: "Say go to publish any of them, change or drop to adjust, or tell me a new one.",
    });
    expect(welcomeText("Edge", { kind: "listed", titles: ["One"], seeded: "publish" }, INTENTS_URL)).toContain("fit this and bring");
  });

  test("the worst case stays under WELCOME_MAX_CHARS by construction: the longest name, three TITLE_MAX titles, both modes, through the real path", async () => {
    writeNickname(ASTRAL_NAME);
    expect(welcomeName(home)).toBe(ASTRAL_NAME);
    for (const mode of ["publish", "paused"] as const) {
      for (const [label, title] of [
        ["words", (n: number) => words(TITLE_MAX, String.fromCharCode(96 + n))],
        ["one word", (n: number) => String.fromCharCode(96 + n).repeat(TITLE_MAX)],
        ["astral", (n: number) => String.fromCodePoint(0x1f600 + n).repeat(TITLE_MAX)],
      ] as const) {
        const texts = [1, 2, 3].map(title);
        writeUserMd(profileText(draftWith(0, { intentions: texts.map((text) => ({ category: "advice", text, kept: true })) })));
        rmSync(join(home, WELCOME_SEED_FILE), { force: true });
        process.env.AV_WELCOME_SEED_MODE = mode;
        const { text, calls } = await run(fakeIndex(), ["--draft"]);
        expect({ mode, label, sent: creates(calls).map((c) => c.arguments?.description) }).toEqual({ mode, label, sent: texts });
        expect({ mode, label, ok: text.includes(`I'm ${ASTRAL_NAME},`) && text.includes(SEEDED_COPY[mode].lead) }).toEqual({ mode, label, ok: true });
        expect({ mode, label, length: text.length <= WELCOME_MAX_CHARS }).toEqual({ mode, label, length: true });
        const listed = listedLines(text);
        expect(listed).toHaveLength(MAX_LISTED);
        for (const line of listed) expect(line.endsWith("…")).toBe(true);
      }
    }
  });

  test("never over WELCOME_MAX_CHARS for any mix of title lengths, either mode, any name; titles that fit stay whole", () => {
    const names = ["Edge", "Mira", "Abcdefghij Klmnopqrst Uvwxyzabcd", ASTRAL_NAME];
    const lengths = [1, 40, 120, 200, 240, 260, 299, TITLE_MAX];
    // The link is not in the seeded text; the longest one changes nothing.
    const links = [INTENTS_URL, `https://${"h".repeat(INTENTS_URL_MAX - 16)}/intents`];
    for (const seeded of ["publish", "paused"] as const) {
      for (const name of names) {
        for (const link of links) {
          for (const a of lengths) {
            for (const b of lengths) {
              for (const c of [1, 120, TITLE_MAX]) {
                const titles = [words(a, "a"), words(b, "b"), words(c, "c")];
                const text = welcomeText(name, { kind: "listed", titles, seeded }, link);
                if (text.length > WELCOME_MAX_CHARS) throw new Error(`over: ${[seeded, name.length, a, b, c]}`);
                const rest = welcomeText(name, { kind: "listed", titles: ["", "", ""], seeded }, link).length;
                if (a + b + c <= WELCOME_MAX_CHARS - rest) expect(listedLines(text)).toEqual(titles);
                else expect(listedLines(text).some((l) => l.endsWith("…"))).toBe(true);
              }
            }
          }
        }
      }
    }
  });
});

describe("the --draft trailer on the seeded branches", () => {
  const TRAILER = /^\{"welcome":1,"fallback":"(none|questions|unreachable)","intents_listed":[0-3],"intents_seeded":[0-3],"seed_failed":[0-3]\}$/;

  async function captured(index: ReturnType<typeof fakeIndex>, argv: string[]) {
    process.env.INDEX_API_KEY = FAKE_API_KEY;
    process.env.INDEX_MCP_URL = index.fake.url;
    const out = { stdout: "", stderr: "" };
    await main(["--home", home, ...argv], { stdout: (x) => (out.stdout += x), stderr: (x) => (out.stderr += x) }, (a) =>
      welcomeRun(a, { fetch: index.fake.fetch, timeoutMs: 200 }),
    );
    return out;
  }

  const CASES: Array<[string, () => void, Plan, string | null, WelcomeBranch]> = [
    ["seededThree", () => writeNickname("Mira"), {}, "seededThree", { fallback: "none", intents_listed: 3, intents_seeded: 3, seed_failed: 0 }],
    ["seededOne", () => {}, {}, "seededOne", { fallback: "none", intents_listed: 1, intents_seeded: 1, seed_failed: 0 }],
    ["seededPausedThree", () => {
      writeNickname("Mira");
      process.env.AV_WELCOME_SEED_MODE = "paused";
    }, {}, "seededPausedThree", { fallback: "none", intents_listed: 3, intents_seeded: 3, seed_failed: 0 }],
    ["one failed", () => {}, { create: (n) => (n === 3 ? toolError("x") : undefined) }, null, { fallback: "none", intents_listed: 2, intents_seeded: 2, seed_failed: 1 }],
    ["all failed", () => {}, { create: () => toolError("x") }, "zero", { fallback: "questions", intents_listed: 0, intents_seeded: 0, seed_failed: 3 }],
    ["unreachable", () => {}, { list: () => ({ response: new Response("down", { status: 503 }) }) }, "unreachable", { fallback: "unreachable", intents_listed: 0, intents_seeded: 0, seed_failed: 0 }],
  ];

  for (const [label, setup, plan, key, branch] of CASES) {
    test(`${label}: five keys in order, the seed's counts; the default run prints the same and nothing on stderr`, async () => {
      setup();
      writeUserMd(profileText(draftWith(key === "seededOne" ? 1 : 3)));
      const draft = await captured(fakeIndex(plan), ["--draft"]);
      if (key) expect(draft.stdout).toBe(`${(golden as Record<string, string>)[key]}\n`);
      const line = draft.stderr.slice(0, -1);
      expect(draft.stderr.endsWith("\n") && !line.includes("\n")).toBe(true);
      expect(line).toMatch(TRAILER);
      expect(line).toBe(draftTrailer(branch));
      expect(Object.keys(JSON.parse(line))).toEqual(["welcome", "fallback", "intents_listed", "intents_seeded", "seed_failed"]);
      for (const word of ["agent memory", "Rust", "seed round", "Mira", "signup", "https"]) expect(draft.stderr).not.toContain(word);

      rmSync(join(home, WELCOME_SEED_FILE), { force: true });
      const plain = await captured(fakeIndex(plan), []);
      expect(plain.stdout).toBe(draft.stdout);
      expect(plain.stderr).toBe("");
    });
  }
});
