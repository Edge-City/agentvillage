/**
 * INTENTS-RELINK (rc43): the app's Intents tab is Intents V2 (`/intents-v2`). The contract (the app, the
 * control plane and the overlay emit exactly these):
 *
 *   /intents                                    -> /intents-v2
 *   /intents?intent=<id>                        -> /intents-v2/<id>
 *   /intents?opportunity=<id>#opportunity-<id>  -> /intents-v2?opportunity=<id>#opportunity-<id>
 *   /intents?conversation=<id>                  -> /intents-v2?conversation=<id>
 *
 * The app redirects `/intents[?...]` to the mapped V2 URL only when V2 can show that card or intent, so a
 * link emitted in the V2 form must be one V2 can show. A producer that may link something V2 does not show
 * (an introducer or community-ask card, a card on an archived intent, an archived or another person's
 * intent) stays on the `/intents` form, and the redirect takes the viewer to V2 whenever V2 can show it.
 *
 * Every V1 page link left in the overlay is listed in KEPT_ON_V1 with its reason; any other one fails.
 * Scanned: every Markdown file under skills/ and workspace/ (what the agent reads), every script under
 * skills/ and every plugin module, tests excluded. A V1 page link is `/intents` followed by `?`, `#`, a
 * quote, a backtick, a closing bracket, whitespace or the end of the line, and not after `/api`; API paths
 * (`/api/intents`, `/api/intents/<id>`, `/intents/list`) are not page links.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { appOpportunityLink } from "../../skills/index-network/scripts/proactive";

const REPO = join(import.meta.dir, "..", "..");
const V1_PAGE = /(?<!\/api)\/intents(?=[?#"'`)\]\s]|$)/m;

/** `path` lines containing `needle` may name the V1 page, for `reason`. */
const KEPT_ON_V1: Array<{ path: string; needle: string; reason: string }> = [
  {
    path: "plugins/index-links/__init__.py",
    needle: "/intents?intent=",
    reason: "rewrites any Index /i/<id> in any Index tool result: archived intents and other people's intents too",
  },
  {
    path: "skills/index-network/scripts/proactive.ts",
    needle: "/intents?opportunity=",
    reason: "the pending alert's card link: introducer cards and cards on archived intents are not in V2",
  },
  {
    path: "workspace/SOUL.md",
    needle: "/intents?intent=<intentId>",
    reason: "the agent links any intent id a tool returned, archived ones included (and matches index-links)",
  },
  {
    path: "skills/index-network/tools.md",
    needle: "/intents?intent=<intentId>",
    reason: "the same rule as SOUL.md, and the form index-links puts on the create_intent lead line",
  },
  {
    path: "plugins/av-events/_core.py",
    needle: "/intents?intent=",
    reason: "the capability-URL redactor's comment: both forms carry no capability and pass untouched",
  },
];

function walk(dir: string, keep: (path: string) => boolean, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "tests" || entry === "__pycache__" || entry.startsWith(".")) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, keep, out);
    else if (keep(path)) out.push(path);
  }
  return out;
}

const SCANNED = [
  ...walk(join(REPO, "skills"), (p) => p.endsWith(".md") || p.endsWith(".ts") || p.endsWith(".py")),
  ...walk(join(REPO, "workspace"), (p) => p.endsWith(".md")),
  ...walk(join(REPO, "plugins"), (p) => p.endsWith(".py")),
].map((p) => relative(REPO, p));

const read = (path: string) => readFileSync(join(REPO, path), "utf8");

describe("INTENTS-RELINK: links to the Intents page", () => {
  test("the scan covers the producers and the agent's URL rules", () => {
    for (const expected of [
      "workspace/SOUL.md",
      "skills/index-network/tools.md",
      "skills/index-network/scripts/proactive.ts",
      "skills/index-network/scripts/welcome.ts",
      "plugins/index-links/__init__.py",
      "plugins/av-events/_record_intention.py",
    ]) {
      expect(SCANNED).toContain(expected);
    }
  });

  test("every V1 page link left is a listed one, kept because V2 may not show what it links", () => {
    const hits = SCANNED.flatMap((path) =>
      read(path)
        .split("\n")
        .flatMap((line, i) =>
          V1_PAGE.test(line) && !KEPT_ON_V1.some((k) => k.path === path && line.includes(k.needle)) ? [`${path}:${i + 1}`] : [],
        ),
    );
    expect(hits).toEqual([]);
    // Each listed exception still exists (a stale entry would hide nothing but mislead).
    for (const k of KEPT_ON_V1) expect({ path: k.path, has: read(k.path).includes(k.needle) }).toEqual({ path: k.path, has: true });
  });

  test("the producers whose target V2 always shows emit the V2 form", () => {
    // The welcome's Intents page; a just-published intention's detail page; the brief's own live signals.
    expect(read("skills/index-network/scripts/welcome.ts")).toContain('new URL("/intents-v2", connectionsUrl(home))');
    expect(read("plugins/av-events/_record_intention.py")).toContain('_PORTAL_INTENT = "https://agents.edgecity.live/intents-v2/"');
    expect(read("skills/index-network/scripts/proactive.ts")).toContain("`${PORTAL_WEB}/intents-v2/${lastSegment(u)}`");
  });

  test("the pending card's app link stays on the V1 form the app redirects when V2 can show the card", () => {
    expect(appOpportunityLink("o1")).toBe("https://agents.edgecity.live/intents?opportunity=o1#opportunity-o1");
  });

  test("the pattern sees a V1 page link and passes V2 links and API paths", () => {
    for (const v1 of [
      "https://agents.edgecity.live/intents",
      "`https://agents.edgecity.live/intents?intent=<intentId>`",
      "${PORTAL_WEB}/intents?opportunity=x#opportunity-x",
      'new URL("/intents", home)',
      "[Intents](https://agents.edgecity.live/intents)",
    ]) {
      expect(V1_PAGE.test(v1)).toBe(true);
    }
    for (const ok of [
      "https://agents.edgecity.live/intents-v2",
      "https://agents.edgecity.live/intents-v2/abc",
      "https://agents.edgecity.live/intents-v2?conversation=c1",
      "PATCH /api/intents/{id}/archive",
      "One `POST <origin>/api/intents` with",
      "POST /intents/list",
    ]) {
      expect(V1_PAGE.test(ok)).toBe(false);
    }
  });
});
