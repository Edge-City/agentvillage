/**
 * question-vocab.ts: the closed vocabulary of Index's recovery question
 * (SEED-REVISION round 3, OV-302 refute M1/S2; the lead's 22:24Z conditions).
 *
 * - Index's recorded recovery questions (BOARD row 153, Carter's three
 *   `prepare` probes; fixtures/index-prepare-row153.json) still pass where
 *   they are plain: honest feedback is not flattened.
 * - No harmful word is in the list, and none can be spelled by joining words
 *   of it.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { TOOL_NAMES, questionDenylistHit, questionGuardHit } from "../question-guard";
import { QUESTION_VOCAB, VOCAB_NEVER, outOfVocabulary, vocabWords } from "../question-vocab";
import { refusedQuestion } from "../welcome";

const ROW153 = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "index-prepare-row153.json"), "utf8")) as {
  bodies: Array<{ payload: string; feedback: string; recovery: Array<{ label: string; kind: string }> }>;
};
const FIELDS = ROW153.bodies.flatMap((b) => b.recovery.map((r) => r.label));
/** The recorded recovery fields that are questions (the other two are "Describe ..." prompts, not questions). */
const RECORDED = FIELDS.filter((label) => label.endsWith("?"));

describe("the nine recorded Index recovery questions (row 153)", () => {
  test("the fixture holds Carter's three answers: 11 fields, 9 of them questions", () => {
    expect(ROW153.bodies.map((b) => b.payload)).toEqual(["Here to meet founders", "Wants to meet people working on climate tools", "Working on a climate data startup"]);
    expect(FIELDS).toHaveLength(11);
    expect(RECORDED).toHaveLength(9);
  });

  test("7 of the 9 reach the agent unchanged; the 2 withheld hold a word the denylist withheld before this round (domains, tool)", () => {
    const out = RECORDED.map((q) => ({ q, withheld: refusedQuestion(q, "Here to meet founders").withheld }));
    expect(out).toEqual([
      { q: "What is your primary goal in meeting founders?", withheld: null },
      // `domains` is a destination word (round 2, review flag 1), so it is not in the vocabulary.
      { q: "Which industries or domains are you most interested in?", withheld: "vocab" },
      { q: "What stage of startups are you focusing on?", withheld: null },
      // `tool` is on the lead's stop list (round 1), so it is not in the vocabulary.
      { q: "Which climate tool areas are you most interested in?", withheld: "vocab" },
      { q: "What is the primary goal of connecting?", withheld: null },
      { q: "Who specifically would you like to speak with?", withheld: null },
      { q: "What core area of climate data are you addressing?", withheld: null },
      { q: "Who are you primarily looking to connect with?", withheld: null },
      { q: "What is the specific goal or milestone you need help with right now?", withheld: null },
    ]);
    // Not a vocabulary regression: the denylist alone withholds both, as it did at 2372cbf8.
    expect(questionDenylistHit("Which industries or domains are you most interested in?")).toBe("destination");
    expect(questionDenylistHit("Which climate tool areas are you most interested in?")).toBe("stop_word");
    // The two prompts that are not questions stay withheld.
    for (const label of FIELDS.filter((f) => !f.endsWith("?"))) expect({ label, hit: questionGuardHit(label) }).toEqual({ label, hit: "not_question" });
  });

  test("the words the recorded questions needed are in the list (none of them from VOCAB_NEVER)", () => {
    const added = ["primary", "primarily", "goal", "meeting", "founders", "stage", "startups", "focusing", "interested", "industries", "areas", "connecting", "specifically", "speak", "core", "climate", "data", "addressing", "milestone", "specific", "help", "right", "now"];
    for (const word of added) expect({ word, in: QUESTION_VOCAB.has(word), never: VOCAB_NEVER.includes(word) }).toEqual({ word, in: true, never: false });
    for (const word of ["tool", "domains"]) expect({ word, in: QUESTION_VOCAB.has(word) }).toEqual({ word, in: false });
  });
});

describe("the list itself", () => {
  test("its size is pinned (an edit is a decision, not a drift)", () => {
    expect(QUESTION_VOCAB.size).toBe(VOCAB_SIZE);
    for (const word of QUESTION_VOCAB) expect({ word, ok: /^[a-z]+(?:['-][a-z]+)?$/.test(word) }).toEqual({ word, ok: true });
  });

  test("it never meets VOCAB_NEVER, and every VOCAB_NEVER word withholds a question on its own (vocab)", () => {
    expect([...QUESTION_VOCAB].filter((w) => VOCAB_NEVER.includes(w))).toEqual([]);
    for (const word of VOCAB_NEVER) expect({ word, hit: questionGuardHit(`What is your ${word}?`) }).toEqual({ word, hit: "vocab" });
  });

  test("no VOCAB_NEVER word, stop word or tool name can be spelled by joining words of the list (only `todo`, as \"to do\", which the tool fold reads as two words)", () => {
    const parts = new Set([...QUESTION_VOCAB].map((w) => w.replace(/['-]/g, "")));
    const spell = (word: string): boolean => {
      const ok = [true];
      for (let i = 1; i <= word.length; i++) ok[i] = [...Array(i).keys()].some((j) => ok[j] && parts.has(word.slice(j, i)));
      return ok[word.length]!;
    };
    const stops = ["ignore", "instructions", "system", "prompt", "override", "tool", "call", "publish", "approve", "password", "wallet", "telegram", "send", "forward", "delete", "seedphrase", "share", "contact", "click", "visit", "download", "install", "enter", "otp", "sms", "url", "link", "site", "email", "dot", "com", "disregard", "rules"];
    const targets = [...VOCAB_NEVER, ...stops, ...TOOL_NAMES.map((n) => n.replace(/-/g, ""))];
    expect(targets.filter(spell)).toEqual(["todo"]);
    expect(questionGuardHit("What do you want to do together?")).toBeNull();
  });

  test("every word of the list passes the denylist on its own: the layers do not disagree", () => {
    for (const word of QUESTION_VOCAB) expect({ word, hit: questionDenylistHit(`What ${word}?`) }).toEqual({ word, hit: null });
  });

  test("words are read in lower case after NFKC, split at spaces, commas, apostrophes and hyphens; accents are kept", () => {
    expect(vocabWords("What's your  Co-Founder, goal")).toEqual([["what's", "what", "s"], ["your"], ["co-founder", "co", "founder"], ["goal"]]);
    expect(outOfVocabulary("What's your goal")).toBe(false);
    expect(outOfVocabulary("Who is your co-founder")).toBe(false);
    expect(outOfVocabulary("Which founder-investor")).toBe(false);
    // A joined word passes whole or in parts of the list only: `co` alone is not a word of it ("co in" would read `coin`).
    expect(outOfVocabulary("Is it a co-in")).toBe(true);
    expect(outOfVocabulary("Is it a co")).toBe(true);
    expect(outOfVocabulary("Who's here")).toBe(false);
    expect(outOfVocabulary("Who s here")).toBe(true);
    expect(outOfVocabulary("Who would you like to mèet")).toBe(true);
    expect(outOfVocabulary("Who would you like to ＭＥＥＴ")).toBe(false);
  });
});

const VOCAB_SIZE = 258;
