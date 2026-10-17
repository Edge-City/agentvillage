/**
 * CD-03 C (17 Oct 2026): Intents V2 is the only landing. Where each opportunity link the agent or its cron
 * scripts hand a resident goes:
 *
 *   message link (introLink / messageLink: the drops, the evening note, the follow-up, the pending
 *   alert's acceptUrl)                     -> <portal>/intro/<id>?via=agent
 *   the pending alert's appUrl (DATA-430)  -> <portal>/intents-v2?opportunity=<id>
 *
 * The message link keeps the app's `/intro` alias on purpose: a tap from Telegram is often signed out on a
 * phone, `/intro` owns the sign-in return (the (app) layout has no `next`), and under
 * `INTRO_LANDING=intents-v2` it answers 303 to the card on V2 for a signed-in V2 viewer, `via` carried. The
 * pending card link is an in-app link (the resident is signed in) and V2 shows every card after app step 1,
 * so it goes straight to V2 and never to the V1 page.
 *
 * The copy pin at the end: since RC-11 the accepter can message at once, so no prompt or exemplar may say
 * Telegram opens only once both people have accepted.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { appOpportunityLink, introLink, pendingView } from "../proactive";

const SKILL = join(import.meta.dir, "..", "..");
const PORTAL = "https://agents.edgecity.live";
const SIGNED = (id: string) => `https://index.network/o/${id}?action=accept&viewer=v1&sig=s1`;
const UUID = "bbbbbbbb-0000-4000-8000-000000000001";
/** The V1 Intents page with a query: `/intents?…` (not `/intents-v2?…`, not `/api/intents?…`). */
const V1_QUERY = /(?<!\/api)\/intents\?/;

describe("CD-03 C: the message link keeps the /intro alias, the pending card link lands on V2", () => {
  test("introLink: a signed accept link becomes `/intro/<id>?via=agent`; the signature never survives", () => {
    expect(introLink(SIGNED("op1"))).toBe(`${PORTAL}/intro/op1?via=agent`);
    expect(introLink(SIGNED(UUID))).toBe(`${PORTAL}/intro/${UUID}?via=agent`);
    expect(introLink(`https://app.index.network/o/op1/?sig=s1&viewer=v1&action=accept&to=x`)).toBe(`${PORTAL}/intro/op1?via=agent`);
    const out = new URL(introLink(SIGNED("op1"))!);
    expect([...out.searchParams.keys()]).toEqual(["via"]);
    expect(out.searchParams.get("via")).toBe("agent");
    expect(out.href).not.toContain("sig");
    expect(out.href).not.toContain("viewer");
    expect(out.hash).toBe("");
  });

  test("introLink: no link for a decline, an unsigned, a plain, a foreign-host or a malformed one", () => {
    for (const bad of [
      "https://index.network/o/op1?action=decline&viewer=v1&sig=s1",
      "https://index.network/o/op1?action=accept&viewer=v1",
      "https://index.network/o/op1",
      "https://evil.example/o/op1?action=accept&viewer=v1&sig=s1",
      "https://index.network/o/a%3Fb?action=accept&viewer=v1&sig=s1",
      `https://index.network/o/${"x".repeat(129)}?action=accept&viewer=v1&sig=s1`,
      "",
      null,
      7,
    ]) {
      expect(introLink(bad)).toBeNull();
    }
  });

  test("appOpportunityLink: the V2 card, no via, no anchor; only an id that encodes to itself", () => {
    expect(appOpportunityLink("o1")).toBe(`${PORTAL}/intents-v2?opportunity=o1`);
    expect(appOpportunityLink(UUID)).toBe(`${PORTAL}/intents-v2?opportunity=${UUID}`);
    expect(appOpportunityLink("A_b-9")).toBe(`${PORTAL}/intents-v2?opportunity=A_b-9`);
    for (const bad of ["", "a/b", "a?b", "a&b", "a#b", "a b", "a%2Fb", "é", "x".repeat(129), null, 7]) {
      expect(appOpportunityLink(bad)).toBeNull();
    }
  });

  test("the pending alert's two links: appUrl on V2, acceptUrl (= messageLink) on the /intro alias with via=agent", () => {
    const now = new Date("2026-10-12T09:30:00Z");
    const card = { name: "Asha", opportunityId: "a1", status: "pending", acceptUrl: SIGNED("a1") };
    const { view } = pendingView([{ card, opportunityId: "a1", firstSeen: now.toISOString() }] as never, now);
    const [entry] = (view as { cards: Array<{ appUrl: string; acceptUrl: string }> }).cards;
    expect(entry.appUrl).toBe(`${PORTAL}/intents-v2?opportunity=a1`);
    expect(entry.acceptUrl).toBe(`${PORTAL}/intro/a1?via=agent`);
  });
});

describe("mutation pins", () => {
  test("appOpportunityLink never emits the V1 page (`/intents?`), rendered or in its source", () => {
    for (const id of ["o1", UUID, "A_b-9", "x".repeat(128)]) {
      const link = appOpportunityLink(id)!;
      expect(link.startsWith(`${PORTAL}/intents-v2?opportunity=`)).toBe(true);
      expect(V1_QUERY.test(link)).toBe(false);
    }
    const source = readFileSync(join(SKILL, "scripts", "proactive.ts"), "utf8");
    const start = source.indexOf("export const appOpportunityLink");
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf("\n};", start));
    expect(V1_QUERY.test(body)).toBe(false);
    expect(body).not.toContain("#opportunity-");
  });

  test("RC-11: no prompt or exemplar says Telegram opens only once both have accepted", () => {
    const files = [
      ...readdirSync(join(SKILL, "prompts")).filter((f) => f.endsWith(".md")).map((f) => join("prompts", f)),
      "exemplars.md",
    ];
    expect(files).toContain(join("prompts", "opportunity-drop.md"));
    expect(files).toContain(join("prompts", "negotiation-summary.md"));
    expect(files).toContain(join("prompts", "ask-questions.md"));
    const stale = files.filter((f) => {
      const text = readFileSync(join(SKILL, f), "utf8");
      return text.includes("both accepted") && text.includes("opens Telegram");
    });
    expect(stale).toEqual([]);
  });

  test("the V1 pattern sees what it must", () => {
    for (const hit of [`${PORTAL}/intents?opportunity=o1#opportunity-o1`, "`${PORTAL_WEB}/intents?opportunity=${encoded}`"]) {
      expect(V1_QUERY.test(hit)).toBe(true);
    }
    for (const ok of [`${PORTAL}/intents-v2?opportunity=o1`, "/api/intents?x=1", `${PORTAL}/intro/o1?via=agent`]) {
      expect(V1_QUERY.test(ok)).toBe(false);
    }
  });
});
