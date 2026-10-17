/**
 * CD-03 C (17 Oct 2026): Intents V2 is the only landing. Every link the agent or its cron scripts hand a
 * resident for one opportunity lands on that card on V2:
 *
 *   message link (introLink / messageLink, the drops, the evening note, the follow-up, the pending
 *   alert's acceptUrl)                     -> <portal>/intents-v2?opportunity=<id>&via=agent
 *   the pending alert's appUrl (DATA-430)  -> <portal>/intents-v2?opportunity=<id>
 *   index-links' signed accept rewrite     -> <portal>/intents-v2?opportunity=<id>   (pinned in pytest)
 *
 * The app keeps its older intro route as an alias that redirects to V2, so links already in Telegram keep
 * working; nothing here may emit it again. The mutation pin at the end fails on any `/intro` link in the
 * three producer files (proactive.ts, the index-links plugin, tools.md) or in a rendered link.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { appOpportunityLink, introLink, pendingView } from "../proactive";

const REPO = join(import.meta.dir, "..", "..", "..", "..");
const PORTAL = "https://agents.edgecity.live";
const SIGNED = (id: string) => `https://index.network/o/${id}?action=accept&viewer=v1&sig=s1`;
const UUID = "bbbbbbbb-0000-4000-8000-000000000001";
/** `/intro` as a path: `/intro`, `/intro/<id>`, `/intro?…`; not `/introduction`. */
const INTRO_ROUTE = /\/intro\b/;

describe("CD-03 C: the agent's opportunity links land on Intents V2", () => {
  test("introLink: a signed accept link becomes the V2 card with via=agent; the signature never survives", () => {
    expect(introLink(SIGNED("op1"))).toBe(`${PORTAL}/intents-v2?opportunity=op1&via=agent`);
    expect(introLink(SIGNED(UUID))).toBe(`${PORTAL}/intents-v2?opportunity=${UUID}&via=agent`);
    expect(introLink(`https://app.index.network/o/op1/?sig=s1&viewer=v1&action=accept&to=x`)).toBe(
      `${PORTAL}/intents-v2?opportunity=op1&via=agent`,
    );
    const out = introLink(SIGNED("op1"))!;
    expect(new URL(out).searchParams.get("via")).toBe("agent");
    expect([...new URL(out).searchParams.keys()]).toEqual(["opportunity", "via"]);
    expect(out).not.toContain("sig");
    expect(out).not.toContain("viewer");
    expect(out).not.toContain("#");
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

  test("appOpportunityLink: the V2 card, no via, no V1 page, no anchor; only an id that encodes to itself", () => {
    expect(appOpportunityLink("o1")).toBe(`${PORTAL}/intents-v2?opportunity=o1`);
    expect(appOpportunityLink(UUID)).toBe(`${PORTAL}/intents-v2?opportunity=${UUID}`);
    expect(appOpportunityLink("A_b-9")).toBe(`${PORTAL}/intents-v2?opportunity=A_b-9`);
    for (const bad of ["", "a/b", "a?b", "a&b", "a#b", "a b", "a%2Fb", "é", "x".repeat(129), null, 7]) {
      expect(appOpportunityLink(bad)).toBeNull();
    }
  });

  test("the pending alert's two links (appUrl, and acceptUrl = messageLink): both V2, only acceptUrl carries via=agent", () => {
    const now = new Date("2026-10-12T09:30:00Z");
    const card = { name: "Asha", opportunityId: "a1", status: "pending", acceptUrl: SIGNED("a1") };
    const { view } = pendingView([{ card, opportunityId: "a1", firstSeen: now.toISOString() }] as never, now);
    const [entry] = (view as { cards: Array<{ appUrl: string; acceptUrl: string }> }).cards;
    expect(entry.appUrl).toBe(`${PORTAL}/intents-v2?opportunity=a1`);
    expect(entry.acceptUrl).toBe(`${PORTAL}/intents-v2?opportunity=a1&via=agent`);
  });
});

describe("mutation pin: nothing emits the old intro route", () => {
  const PRODUCERS = ["skills/index-network/scripts/proactive.ts", "plugins/index-links/__init__.py", "skills/index-network/tools.md"];

  test("the three producer files never name `/intro`", () => {
    const hits = PRODUCERS.flatMap((path) =>
      readFileSync(join(REPO, path), "utf8")
        .split("\n")
        .flatMap((line, i) => (INTRO_ROUTE.test(line) ? [`${path}:${i + 1}`] : [])),
    );
    expect(hits).toEqual([]);
  });

  test("no rendered link names `/intro`", () => {
    const now = new Date("2026-10-12T09:30:00Z");
    const card = { name: "Asha", opportunityId: UUID, status: "pending", acceptUrl: SIGNED(UUID) };
    const rendered = [
      introLink(SIGNED("op1")),
      introLink(SIGNED(UUID)),
      appOpportunityLink(UUID),
      JSON.stringify(pendingView([{ card, opportunityId: UUID, firstSeen: now.toISOString() }] as never, now).view),
    ];
    for (const link of rendered) {
      expect(link).toContain("/intents-v2?opportunity=");
      expect(INTRO_ROUTE.test(link!)).toBe(false);
    }
  });

  test("the pattern sees every form of the old route and passes the V2 links", () => {
    for (const hit of [`${PORTAL}/intro/op1`, "`${PORTAL_WEB}/intro/${id}`", '_portal("/intro/" + id)', `${PORTAL}/intro?x=1`, "/intro"]) {
      expect(INTRO_ROUTE.test(hit)).toBe(true);
    }
    for (const ok of [`${PORTAL}/intents-v2?opportunity=op1&via=agent`, "any intros?", "make intro", "/introductions"]) {
      expect(INTRO_ROUTE.test(ok)).toBe(false);
    }
  });
});
