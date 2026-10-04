/**
 * Ten village days for a resident who never answers, with 1, 2, 4 and 10
 * pending direct-conversation cards, every path in its daily slot:
 *
 *   08:00 brief (prepare + send) · 12:00 drop · 14:00 follow-up · 17:00 drop · 19:00 evening card
 *
 * Each case pins the exact schedule (which card each path delivers, per day)
 * and checks it against an oracle built only from the schedule's own history:
 *   - a card's first showing is a proper card (brief, drop or evening), never
 *     the follow-up, which only re-shows;
 *   - no card is delivered twice in one day, or more than three times;
 *   - a showing comes at least three days after the card's last one;
 *   - no slot is silent while a card it may deliver is eligible, so the 17:00
 *     drop and the 19:00 evening card are never starved by the follow-up.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { pagedOpportunities } from "./index-mcp-fake";
import { DAY0, addDays, briefAndSend, cleanUp, drop, evening, followUp, newStateFile, oppId, row } from "./delivery-paths";

afterEach(cleanUp);

const SLOTS = [
  ["brief", briefAndSend],
  ["d12", drop],
  ["fu14", followUp],
  ["d17", drop],
  ["ev19", evening],
] as const;
type Slot = (typeof SLOTS)[number][0];
const DAYS = 10;
const MAX_PER_SLOT: Record<Slot, number> = { brief: 3, d12: 1, fu14: 3, d17: 1, ev19: 1 };

const label = (id: string) => `c${Number(id.slice(-12))}`;

async function runSchedule(cards: number): Promise<string[]> {
  const file = newStateFile();
  const handler = pagedOpportunities(Array.from({ length: cards }, (_, i) => row(`P${i + 1}`, i + 1)));
  const ids = Array.from({ length: cards }, (_, i) => oppId(i + 1));
  const history = new Map<string, number[]>(ids.map((id) => [id, []]));
  const table: string[] = [];

  for (let day = 0; day < DAYS; day++) {
    const date = addDays(DAY0, day);
    const today = new Set<string>();
    const cells: string[] = [];
    for (const [slot, path] of SLOTS) {
      const eligible = ids.filter((id) => {
        const days = history.get(id) as number[];
        if (today.has(id) || days.length >= 3) return false;
        if (days.length > 0 && day - (days.at(-1) as number) < 3) return false;
        return slot === "fu14" ? days.length > 0 : true;
      });
      const delivered = await path(date, file, handler);
      const where = `day ${day} ${slot}`;
      expect(delivered.length, where).toBe(Math.min(eligible.length, MAX_PER_SLOT[slot]));
      for (const id of delivered) {
        expect(eligible, `${where}: ${label(id)}`).toContain(id);
        const days = history.get(id) as number[];
        if (slot === "fu14") expect(days.length, `${where}: follow-up gave ${label(id)} its first showing`).toBeGreaterThan(0);
        days.push(day);
        today.add(id);
      }
      cells.push(delivered.map(label).join(",") || "-");
    }
    table.push(`${day} | ${cells.join(" | ")}`);
  }
  for (const [id, days] of history) expect(days.length, label(id)).toBeLessThanOrEqual(3);
  return table;
}

//            day | brief | d12 | fu14 | d17 | ev19
const EXPECTED: Record<number, string[]> = {
  1: [
    "0 | c1 | - | - | - | -",
    "1 | - | - | - | - | -",
    "2 | - | - | - | - | -",
    "3 | c1 | - | - | - | -",
    "4 | - | - | - | - | -",
    "5 | - | - | - | - | -",
    "6 | c1 | - | - | - | -",
    "7 | - | - | - | - | -",
    "8 | - | - | - | - | -",
    "9 | - | - | - | - | -",
  ],
  2: [
    "0 | c1,c2 | - | - | - | -",
    "1 | - | - | - | - | -",
    "2 | - | - | - | - | -",
    "3 | c1,c2 | - | - | - | -",
    "4 | - | - | - | - | -",
    "5 | - | - | - | - | -",
    "6 | c1,c2 | - | - | - | -",
    "7 | - | - | - | - | -",
    "8 | - | - | - | - | -",
    "9 | - | - | - | - | -",
  ],
  4: [
    "0 | c1,c2,c3 | c4 | - | - | -",
    "1 | - | - | - | - | -",
    "2 | - | - | - | - | -",
    "3 | c1,c2,c3 | c4 | - | - | -",
    "4 | - | - | - | - | -",
    "5 | - | - | - | - | -",
    "6 | c1,c2,c3 | c4 | - | - | -",
    "7 | - | - | - | - | -",
    "8 | - | - | - | - | -",
    "9 | - | - | - | - | -",
  ],
  10: [
    "0 | c1,c2,c3 | c4 | - | c5 | c6",
    "1 | c7,c8,c9 | c10 | - | - | -",
    "2 | - | - | - | - | -",
    "3 | c1,c2,c3 | c4 | c5,c6 | - | -",
    "4 | c7,c8,c9 | c10 | - | - | -",
    "5 | - | - | - | - | -",
    "6 | c1,c2,c3 | c4 | c5,c6 | - | -",
    "7 | c7,c8,c9 | c10 | - | - | -",
    "8 | - | - | - | - | -",
    "9 | - | - | - | - | -",
  ],
};

describe("ten days of a resident who never answers", () => {
  for (const cards of [1, 2, 4, 10]) {
    test(`${cards} pending card(s)`, async () => {
      const table = await runSchedule(cards);
      expect(table).toEqual(EXPECTED[cards]);
    }, 60_000);
  }
});
