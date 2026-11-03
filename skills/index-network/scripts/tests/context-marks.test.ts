/**
 * VISIBILITY MARKS (CLAIMS L13696): the overlay's two USER.md card-line readers, context-tags.ts
 * (parseContextTags, parseContextLine) and memory_signal_gate.py (ITEM_LINE, parse_item_line,
 * context_tags), accept the old marks (`public`, `village`, `private`: the e3 wire today) AND the
 * ids of agentvillage.visibility/1 (`agentvillage/edgecityindia2026`, `agentvillage/private`: the wire
 * a later release switches to), and read both to the same visibility. Writers are unchanged.
 *
 *   - the vocab pin: the ids and the mark mapping are the vocab's, by sha256;
 *   - the table: every old mark and every new id, under every marker form, read identically by
 *     TypeScript and Python, old and new to the same visibility;
 *   - anything else stays part of the words, as today; a guess or a chat line is Private whatever
 *     its mark; no mark ever reads wider than the vocab says;
 *   - the golden: today's inputs give byte-identical outputs (fixtures/context-marks-golden.json,
 *     from origin/main fe243b06's readers);
 *   - one tags entry (R2): both readers take the LAST entry starting with the mark (the app's), and the same one.
 *
 *   bun test skills/index-network/scripts/tests/context-marks.test.ts
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  CONTEXT_TAGS_MARK,
  ITEM_LINE_SOURCE,
  MARK_VISIBILITY,
  VISIBILITY_EDGE_CITY_INDIA_2026,
  VISIBILITY_IDS,
  VISIBILITY_PRIVATE,
  VISIBILITY_VOCAB,
  type Visibility,
  SETUP_PROFILE_MARK,
  contextTagsEntry,
  markVisibility,
  parseContextLine,
  parseContextTags,
  statedItems,
} from "../context-tags";
import { MARKER_FORMS, NEW_MARKS, NOT_MARKS, OLD_MARKS, entryFor, goldenFor, pyOutputs, pyRun, todayEntries, tsOutputs } from "./context-marks-corpus";

const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

/**
 * The vocab pin. Source: Edge-City/agentvillage-app src/lib/visibility/visibility-vocab.v1.json at
 * app main ee8dc195 (app#468), byte-identical to Edge-City/agentvillage-controlplane
 * control-plane/src/visibility/visibility-vocab.v1.json at cp main f8ec6165 (cp#321); both repos'
 * visibility-pins.v1.json pin the same sha256. This repo is public, so the file itself is not copied
 * here: VOCAB_SUBSET_SHA256 is the sha256 of the part the readers use, encoded as
 * JSON.stringify({vocab, ids, mark: mapping.mark, mark_of_a_guess: mapping.mark_of_a_guess,
 * unknown: mapping.unknown}) over that file. A vocab change (a new id, a new mapping) breaks this pin,
 * and the readers here move with it. With AV_VISIBILITY_VOCAB_FILE set to a copy of the file, the test
 * also checks the file's own sha256 and recomputes the subset from it.
 */
const VOCAB_FILE_SHA256 = "b7a02a2149aa2c99f309e223ecef80ffe52844f128b9646f1eef5d4fb2639521";
const VOCAB_SUBSET_SHA256 = "5467406579673c5ac7622208e418204110a0a456d608abb5171f36258895e5bf";
const VOCAB_SUBSET = {
  vocab: "agentvillage.visibility/1",
  ids: ["agentvillage/private", "agentvillage/edgecityindia2026"],
  mark: {
    public: "agentvillage/edgecityindia2026",
    village: "agentvillage/edgecityindia2026",
    private: "agentvillage/private",
    "": "agentvillage/private",
  },
  mark_of_a_guess: "agentvillage/private",
  unknown: "agentvillage/private",
};
/** Who reads each id (the vocab's `readers`): the no-widening check compares these sets. */
const READERS: Record<Visibility, readonly string[]> = {
  "agentvillage/private": ["agent"],
  "agentvillage/edgecityindia2026": ["agent", "index", "skylight"],
};
const OLD_TO_NEW: Record<string, Visibility> = { public: VISIBILITY_EDGE_CITY_INDIA_2026, village: VISIBILITY_EDGE_CITY_INDIA_2026, private: VISIBILITY_PRIVATE };

/** origin/main fe243b06's LINE (context-tags.ts:89), to show what today's reader made of a new id. */
const LINE_FE243B06 = /^- (.+?)(?:\s+\((setup|telegram|you|guess|chat)(?:,\s*intros chat\s+([0-9a-f]{12})|,\s*(guess))?(?:,\s*(public|village|private))?\))?$/i;

const isGuessForm = (form: string) => /guess/i.test(form);
const isChatForm = (form: string) => /^chat$/i.test(form);
const expectedMarker = (form: string) => {
  const f = form.toLowerCase();
  if (f === "chat, guess") return "guess";
  return f.split(",")[0]!.trim();
};

describe("the vocab pin", () => {
  test("the overlay's ids and mark mapping are the vocab's, by sha256", () => {
    expect(sha256(JSON.stringify(VOCAB_SUBSET))).toBe(VOCAB_SUBSET_SHA256);
    const ours = {
      vocab: VISIBILITY_VOCAB,
      ids: [...VISIBILITY_IDS],
      mark: {
        public: markVisibility("public", false),
        village: markVisibility("village", false),
        private: markVisibility("private", false),
        "": markVisibility(null, false),
      },
      mark_of_a_guess: markVisibility("public", true),
      unknown: markVisibility("everyone", false),
    };
    expect(JSON.stringify(ours)).toBe(JSON.stringify(VOCAB_SUBSET));
    expect(sha256(JSON.stringify(ours))).toBe(VOCAB_SUBSET_SHA256);
  });

  test("the marks are exactly the old three and the vocab's ids, each id naming itself", () => {
    expect(Object.keys(MARK_VISIBILITY).sort()).toEqual([...Object.keys(OLD_TO_NEW), ...VISIBILITY_IDS].sort());
    for (const [old, id] of Object.entries(OLD_TO_NEW)) expect([old, MARK_VISIBILITY[old]]).toEqual([old, id]);
    for (const id of VISIBILITY_IDS) expect([id, MARK_VISIBILITY[id]]).toEqual([id, id]);
    expect(Object.isFrozen(MARK_VISIBILITY)).toBe(true);
  });

  test.skipIf(!process.env.AV_VISIBILITY_VOCAB_FILE)("AV_VISIBILITY_VOCAB_FILE: the app/cp file hashes to the pin and holds the same subset", () => {
    const bytes = readFileSync(process.env.AV_VISIBILITY_VOCAB_FILE!);
    expect(sha256(bytes)).toBe(VOCAB_FILE_SHA256);
    const v = JSON.parse(bytes.toString("utf8"));
    const subset = { vocab: v.vocab, ids: v.ids, mark: v.mapping.mark, mark_of_a_guess: v.mapping.mark_of_a_guess, unknown: v.mapping.unknown };
    expect(JSON.stringify(subset)).toBe(JSON.stringify(VOCAB_SUBSET));
  });

  test("Python holds the same constants and the same line pattern", () => {
    const py = pyRun({ constants: true }).constants!;
    expect(py.vocab).toBe(VISIBILITY_VOCAB);
    expect(py.ids).toEqual([...VISIBILITY_IDS]);
    expect(py.marks).toEqual({ ...MARK_VISIBILITY });
    expect(py.pattern).toBe(ITEM_LINE_SOURCE);
  });
});

describe("the table: every old mark and every new id, TypeScript and Python alike", () => {
  const MARKS = [...OLD_MARKS, ...NEW_MARKS];
  const lines: string[] = [];
  for (const mark of MARKS) for (const form of MARKER_FORMS) lines.push(`- Item words (${form}, ${mark})`);
  for (const mark of MARKS) lines.push(`- Item words (you,${mark})`, `- Item words (setup,   ${mark})`);
  const py = pyRun({ lines }).lines;

  test("every line is read: the words alone, the marker, the mark lower-cased, its visibility", () => {
    let i = 0;
    for (const mark of MARKS) {
      for (const form of MARKER_FORMS) {
        const line = lines[i++]!;
        const read = parseContextLine(line);
        const marker = expectedMarker(form);
        const vis = isGuessForm(form) || isChatForm(form) ? VISIBILITY_PRIVATE : MARK_VISIBILITY[mark.toLowerCase()]!;
        expect([line, read]).toEqual([line, { text: "Item words", marker, mark: mark.toLowerCase(), visibility: vis }]);
      }
    }
  });

  test("Python's parse_item_line gives the same answer for every line", () => {
    lines.forEach((line, i) => {
      const ts = parseContextLine(line)!;
      expect([line, py[i]]).toEqual([line, [ts.text, ts.marker, ts.mark, ts.visibility]]);
    });
  });

  test("an old mark and its new id read the same: words, marker and visibility", () => {
    for (const form of MARKER_FORMS) {
      for (const [old, id] of [["public", VISIBILITY_EDGE_CITY_INDIA_2026], ["village", VISIBILITY_EDGE_CITY_INDIA_2026], ["private", VISIBILITY_PRIVATE]] as const) {
        const a = parseContextLine(`- Item words (${form}, ${old})`)!;
        const b = parseContextLine(`- Item words (${form}, ${id})`)!;
        expect([form, old, a.text, a.marker, a.visibility]).toEqual([form, old, b.text, b.marker, b.visibility]);
      }
    }
  });

  test("a whole entry with the new ids reads as the same entry with the old marks (and holds the unmarked one's words)", () => {
    const oldEntry = entryFor("village", "Same");
    const newEntry = entryFor(VISIBILITY_EDGE_CITY_INDIA_2026, "Same");
    const privOld = entryFor("private", "Same");
    const privNew = entryFor(VISIBILITY_PRIVATE, "Same");
    const plain = entryFor(null, "Same");
    const words = (e: string) => JSON.stringify(Object.values(parseContextTags(e).groups).map((items) => items.map((i) => [i.text, i.marker])));
    for (const e of [oldEntry, newEntry, privOld, privNew]) expect(words(e)).toBe(words(plain));
    expect(parseContextTags(newEntry)).toEqual(parseContextTags(oldEntry));
    expect(parseContextTags(privNew)).toEqual(parseContextTags(privOld));
    for (const g of ["here", "work", "meet", "offer", "curious", "prefs", "fun", "about"] as const) expect(statedItems(parseContextTags(newEntry), g)).toEqual(statedItems(parseContextTags(oldEntry), g));
    const [, pOld, pNew, pPrivOld, pPrivNew] = pyOutputs([plain, oldEntry, newEntry, privOld, privNew]);
    expect(pNew).toBe(pOld!);
    expect(pPrivNew).toBe(pPrivOld!);
  });

  test("the hazard this closes: today's reader took a new id as words, so a guess read as stated", () => {
    const line = `- A seed library (guess, ${VISIBILITY_PRIVATE})`;
    const before = LINE_FE243B06.exec(line)!;
    expect([before[1], before[2]]).toEqual([`A seed library (guess, ${VISIBILITY_PRIVATE})`, undefined]); // read as an unmarked (telegram) item
    const tags = parseContextTags(`${CONTEXT_TAGS_MARK}\nWorking on:\n${line}\n- Tool library (you, ${VISIBILITY_EDGE_CITY_INDIA_2026})`);
    expect(tags.groups.work.map(({ text, marker }) => ({ text, marker }))).toEqual([{ text: "A seed library", marker: "guess" }, { text: "Tool library", marker: "you" }]);
    expect(statedItems(tags, "work")).toEqual(["Tool library"]);
    expect(tags.groups.work.map((i) => i.text).join(" ")).not.toMatch(/agentvillage/);
  });
});

describe("anything else is still no mark, exactly as today", () => {
  const lines = NOT_MARKS.flatMap((token) => [`- Item words (you, ${token})`, `- Item words (guess, ${token})`, `- Item words (chat, guess, ${token})`]);
  const py = pyRun({ lines }).lines;

  test("the parenthesis stays part of the words: an unmarked (telegram) item, Private", () => {
    for (const line of lines) {
      expect([line, parseContextLine(line)]).toEqual([line, { text: line.slice(2), marker: "telegram", mark: null, visibility: VISIBILITY_PRIVATE }]);
      // and today's reader did the same
      const before = LINE_FE243B06.exec(line)!;
      expect([line, before[1], before[2]]).toEqual([line, line.slice(2), undefined]);
    }
  });

  test("Python agrees on every one", () => {
    lines.forEach((line, i) => expect([line, py[i]]).toEqual([line, [line.slice(2), "telegram", null, VISIBILITY_PRIVATE]]));
  });

  test("a mark is only ever the last thing in the parenthesis, never two", () => {
    expect(parseContextLine(`- W (you, private, ${VISIBILITY_PRIVATE})`)!.marker).toBe("telegram");
    expect(parseContextLine(`- W (you, ${VISIBILITY_PRIVATE}, private)`)!.marker).toBe("telegram");
    expect(parseContextLine(`- W (${VISIBILITY_PRIVATE})`)).toEqual({ text: `W (${VISIBILITY_PRIVATE})`, marker: "telegram", mark: null, visibility: VISIBILITY_PRIVATE });
  });
});

/**
 * OV-415 refute N1: Python's `re.I` folds `ſ`/`ı`/`İ` into ASCII letters, and the two languages' `\s`
 * differ (`﻿` is JavaScript's only; `\x1c`-`\x1f` and `\x85` Python's only), so on such a line the
 * two readers may take different words and markers (as on main; parseContextTags and context_tags
 * are unchanged). The visibility both name is Private, never a mark's audience.
 */
describe("lookalikes and invisibles: both readers name Private", () => {
  const LINES = [
    "- X (guesſ, public)",
    "- X (guesſ, village)",
    "- X (guesſ, agentvillage/edgecityindia2026)",
    "- X (ſetup, public)",
    "- X (chat, guesſ, public)",
    "- X (you, publıc)",
    "- X (setup, prıvate)",
    "- X (you, vıllage)",
    "- X (you, vİllage)",
    "- X (ıntros chat, public)",
    "- X (telegram, ıntros chat 0123456789ab, public)",
    "- X (you, agentvıllage/edgecityindia2026)",
    "- X (you, agentvİllage/edgecityindia2026)",
    "- X (yoU, public)".replace("U", "U̇"),
    "- X (you,﻿public)",
    "- X﻿(you, public)",
    "- X (you,\u0085public)",
    "- X (you,\u001cpublic)",
    "- X (you,\u001fvillage)",
    "- X (you, public)",
    "- X (you, public)",
    "- X (you,\tpublic)",
    "- X\t(setup, village)",
    "- X (you, public​)",
  ];
  const py = pyRun({ lines: LINES }).lines;

  test("TypeScript and Python: every one is Private (or no item at all)", () => {
    LINES.forEach((line, i) => {
      const ts = parseContextLine(line);
      expect([JSON.stringify(line), ts?.visibility ?? null]).toEqual([JSON.stringify(line), VISIBILITY_PRIVATE]);
      expect([JSON.stringify(line), py[i]?.[3] ?? null]).toEqual([JSON.stringify(line), VISIBILITY_PRIVATE]);
    });
  });

  test("the same lines in plain ASCII still name their audience (the check is not vacuous)", () => {
    for (const line of ["- X (guess, public)", "- X (setup, public)", "- X (you, village)", "- X (telegram, intros chat 0123456789ab, public)", "- X (you, agentvillage/edgecityindia2026)"]) {
      const want = /guess/.test(line) ? VISIBILITY_PRIVATE : VISIBILITY_EDGE_CITY_INDIA_2026;
      expect([line, parseContextLine(line)!.visibility]).toEqual([line, want]);
      expect([line, pyRun({ lines: [line] }).lines[0]![3]]).toEqual([line, want]);
    }
  });
});

/** OV-415 refute N5 F and N3: near-ids and a closing after the parenthesis are no mark (words, Private), in both. */
describe("near-ids and trailing text: still no mark", () => {
  const LINES = [
    "- X (you, agentvillage/edgecityindia2026x)",
    "- X (guess, agentvillage/edgecityindia2026x)",
    "- X (you, agentvillage/privatex)",
    "- X (you, agentvillage/edgecityindia2026_)",
    "- X (you, publicx)",
    "- X (guess, agentvillage/private).",
    "- X (you, public)!",
    "- X (agentvillage/edgecityindia2026, guess)",
  ];
  const py = pyRun({ lines: LINES }).lines;
  test("the whole line is the words, telegram, Private, in TypeScript and Python", () => {
    LINES.forEach((line, i) => {
      const want = { text: line.slice(2), marker: "telegram", mark: null, visibility: VISIBILITY_PRIVATE };
      expect([line, parseContextLine(line)]).toEqual([line, want]);
      expect([line, py[i]]).toEqual([line, [want.text, want.marker, want.mark, want.visibility]]);
    });
  });
});

describe("never wider: a narrower mark is never read as a wider one", () => {
  const MARK_INPUTS: (string | null)[] = [null, "", ...OLD_MARKS, ...NEW_MARKS, ...NOT_MARKS, "hasOwnProperty", "toString", "valueOf"];
  const cases: [string | null, boolean][] = MARK_INPUTS.flatMap((m) => [[m, false], [m, true]] as [string | null, boolean][]);
  const py = pyRun({ marks: cases }).marks;

  const GUESS_ANSWER = VOCAB_SUBSET.mark_of_a_guess as Visibility;
  /** The vocab's answer (its visibilityOfMark, over the old marks), with each id naming itself. */
  function vocabAnswer(mark: string | null, guess: boolean): Visibility {
    if (guess) return GUESS_ANSWER;
    const m = (mark ?? "").toLowerCase();
    if (Object.prototype.hasOwnProperty.call(VOCAB_SUBSET.mark, m)) return VOCAB_SUBSET.mark[m as keyof typeof VOCAB_SUBSET.mark] as Visibility;
    if ((VOCAB_SUBSET.ids as string[]).includes(m)) return m as Visibility;
    return VOCAB_SUBSET.unknown as Visibility;
  }

  test("markVisibility is the vocab's answer for every mark and guess flag, in both languages", () => {
    cases.forEach(([mark, guess], i) => {
      const ours = markVisibility(mark, guess);
      expect([mark, guess, ours]).toEqual([mark, guess, vocabAnswer(mark, guess)]);
      expect([mark, guess, py[i]]).toEqual([mark, guess, ours]);
      for (const reader of READERS[ours]) expect(READERS[vocabAnswer(mark, guess)]).toContain(reader);
    });
  });

  test("a guess flag that is not exactly false is a guess (fail closed), in both languages", () => {
    const flags = [true, undefined, null, 0, "", "false", 1] as unknown as boolean[];
    for (const g of flags) expect(markVisibility("public", g)).toBe(VISIBILITY_PRIVATE);
    const pyFlags = flags.filter((g) => g !== undefined);
    expect(pyRun({ marks: pyFlags.map((g) => ["public", g] as [string, boolean]) }).marks).toEqual(pyFlags.map(() => VISIBILITY_PRIVATE));
    expect(pyRun({ marks: [["public", false]] }).marks).toEqual([VISIBILITY_EDGE_CITY_INDIA_2026]);
  });

  test("private, old or new, is never Edge City India 2026; a guess or a chat line never is, whatever its mark", () => {
    for (const mark of ["private", "PRIVATE", VISIBILITY_PRIVATE, VISIBILITY_PRIVATE.toUpperCase()]) {
      for (const form of MARKER_FORMS) expect(parseContextLine(`- W (${form}, ${mark})`)!.visibility).toBe(VISIBILITY_PRIVATE);
    }
    for (const mark of [...OLD_MARKS, ...NEW_MARKS]) {
      for (const form of MARKER_FORMS.filter((f) => isGuessForm(f) || isChatForm(f))) expect(parseContextLine(`- W (${form}, ${mark})`)!.visibility).toBe(VISIBILITY_PRIVATE);
    }
    expect(parseContextLine("- W (you)")!.visibility).toBe(VISIBILITY_PRIVATE);
    expect(parseContextLine("- W")!.visibility).toBe(VISIBILITY_PRIVATE);
  });
});

describe("the golden: today's inputs give byte-identical outputs", () => {
  const golden = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "context-marks-golden.json"), "utf8"));
  const now = goldenFor(golden.generated_at);

  test("the golden is origin/main fe243b06's, over this corpus", () => {
    expect(golden.generated_at).toBe("fe243b06ff70519b739bbe7872982f7a4df6ed53");
    expect(now.corpus_sha256).toBe(golden.corpus_sha256);
    expect(now.entries.map((e) => [e.name, e.entry_sha256])).toEqual(golden.entries.map((e: { name: string; entry_sha256: string }) => [e.name, e.entry_sha256]));
    expect(now.entries.length).toBe(todayEntries().length);
    expect(now.entries.length).toBeGreaterThanOrEqual(30);
  });

  /**
   * VISIBILITY B3 (stacked on #415): an entry with no marks at all (no mark, and every token that is no
   * mark) is byte-identical to main; an entry WITH marks now drops its Private and unmarked lines from
   * the stated items (context-private-skip.test.ts holds what it reads instead), so its outputs differ.
   */
  const unmarked = (name: string) => !name.startsWith("old mark") && name !== "mixed old marks";

  test("TypeScript: every unmarked entry's outputs are byte-identical; every marked one's differ (B3)", () => {
    expect(now.entries.filter((e) => unmarked(e.name)).length).toBe(24);
    for (let i = 0; i < now.entries.length; i++) {
      const same = now.entries[i]!.ts_sha256 === golden.entries[i].ts_sha256;
      expect([now.entries[i]!.name, same]).toEqual([golden.entries[i].name, unmarked(golden.entries[i].name)]);
    }
  });

  test("Python: every unmarked entry's outputs are byte-identical; every marked one's differ (B3)", () => {
    for (let i = 0; i < now.entries.length; i++) {
      const same = now.entries[i]!.py_sha256 === golden.entries[i].py_sha256;
      expect([now.entries[i]!.name, same]).toEqual([golden.entries[i].name, unmarked(golden.entries[i].name)]);
    }
  });

  test("the corpus is not vacuous: it holds stated items, guesses, removals and words that kept a parenthesis", () => {
    const out = JSON.parse(tsOutputs(todayEntries().find((e) => e.name === 'not a mark "agentvillage/private "')!.entry));
    expect(out.stated.here.length).toBeGreaterThan(0);
    expect(JSON.stringify(out.tags)).toContain("agentvillage/private )");
    const old = JSON.parse(tsOutputs(todayEntries().find((e) => e.name === "old mark village")!.entry));
    expect(old.tags.groups.here.some((it: { marker: string }) => it.marker === "guess")).toBe(true);
    expect(old.tags.removed.length).toBe(3);
  });
});

/**
 * R2 (ov#604 item 6, review-b L38688 N6 (4); lead ruling: LAST): both readers take the LAST entry that
 * starts with CONTEXT_TAGS_MARK (trimmed as JavaScript trims), the entry the app and the control plane
 * keep, and they take the same entry for every text. On f938afa0 TypeScript took the FIRST and Python
 * the LAST, so the two disagreed. A later entry a session that is not private would append is refused at
 * the write (the USER.md gate's `opens_app_entry`, plugins/village-memory/tests/test_user_md_gate_paths.py).
 */
describe("one tags entry, the app's: the last entry starting with the mark, in both readers (R2)", () => {
  const SEP = "\n§\n";
  const APP = `${CONTEXT_TAGS_MARK}\nKept by the Agent Village app.\nHere to:\n- App item (you, public)\nRemoved by you:\n- App removed (you)`;
  const OLDER = `${CONTEXT_TAGS_MARK}\nHere to:\n- Older item (you, public)`;
  const APPENDED = `${CONTEXT_TAGS_MARK}\nWorking on:\n- Appended item (you, ${VISIBILITY_EDGE_CITY_INDIA_2026})`;
  const SETUP = `${SETUP_PROFILE_MARK}\nName: Test Resident`;
  const NOTE = "The agent's own note.";
  const QUOTE = `A note that quotes ${CONTEXT_TAGS_MARK}\nHere to:\n- Quoted item (you, public)`;
  /** [name, the whole USER.md text, the one item the chosen entry holds (null: no entry)]. */
  const CASES: [string, string, string | null][] = [
    ["the app's alone, after the setup profile and a note", [SETUP, NOTE, APP].join(SEP), "App item"],
    ["an older entry, then the app's (the app's write replaced the last in place)", [OLDER, NOTE, APP].join(SEP), "App item"],
    ["the app's, then one appended: the appended one is last", [APP, APPENDED].join(SEP), "Appended item"],
    ["setup, a note, an older one, the app's, a note", [SETUP, NOTE, OLDER, APP, NOTE].join(SEP), "App item"],
    ["the app's, then a note quoting the mark (not an entry start)", [APP, QUOTE].join(SEP), "App item"],
    ["CRLF line ends", [SETUP, OLDER, APP].join(SEP).replace(/\n/g, "\r\n"), "App item"],
    ["CR line ends", [SETUP, OLDER, APP].join(SEP).replace(/\n/g, "\r"), "App item"],
    ["separators with blanks and tabs around the section sign", `${OLDER}\n \t§\t \n${APP}`, "App item"],
    ["blanks and a tab before the last entry's mark", [OLDER, ` \t${APP}`].join(SEP), "App item"],
    // Whitespace leading an entry: both languages trim as JavaScript does, so an entry counts in both or neither.
    ["U+FEFF before a later entry (JavaScript trims it): that one is last", [APP, `\ufeff${APPENDED}`].join(SEP), "Appended item"],
    ["U+00A0 before a later entry (both trim it): that one is last", [APP, `\u00a0${APPENDED}`].join(SEP), "Appended item"],
    ["U+001C before a later entry (JavaScript keeps it): not an entry start", [APP, `\u001c${APPENDED}`].join(SEP), "App item"],
    ["U+0085 before a later entry (JavaScript keeps it): not an entry start", [APP, `\u0085${APPENDED}`].join(SEP), "App item"],
    ["U+001F before a later entry (JavaScript keeps it): not an entry start", [APP, `\u001f${APPENDED}`].join(SEP), "App item"],
    ["no tags entry", [SETUP, NOTE].join(SEP), null],
    ["only a note that quotes the mark", QUOTE, null],
    ["empty", "", null],
  ];
  const texts = CASES.map(([, text]) => text);
  const py = pyRun({ entries: texts, tags_entry_of: texts });
  const itemTexts = (groups: Record<string, { text: string }[] | unknown[][]>) =>
    Object.values(groups).flatMap((items) => items.map((i) => (Array.isArray(i) ? (i[0] as string) : (i as { text: string }).text)));

  test("TypeScript takes the last entry starting with the mark", () => {
    for (const [name, text, item] of CASES) {
      const entry = contextTagsEntry(text);
      const got = entry === null ? null : itemTexts(parseContextTags(entry).groups);
      expect([name, got]).toEqual([name, item === null ? null : [item]]);
    }
  });

  test("Python takes the same entry, byte for byte, and context_tags reads that entry's items", () => {
    CASES.forEach(([name, text, item], i) => {
      expect([name, py.tags_entry_of![i]]).toEqual([name, contextTagsEntry(text)]);
      const read = JSON.parse(py.entries[i]!) as { groups: Record<string, unknown[][]> };
      expect([name, itemTexts(read.groups)]).toEqual([name, item === null ? [] : [item]]);
    });
  });

  test("an appended entry moves both readers to it, and to the same entry", () => {
    const before = [SETUP, NOTE, APP].join(SEP);
    const after = [before, APPENDED].join(SEP);
    const [pyBefore, pyAfter, pyAppended] = pyOutputs([before, after, APPENDED]);
    expect(contextTagsEntry(before)).toBe(APP);
    expect(contextTagsEntry(after)).toBe(APPENDED);
    expect(pyRun({ tags_entry_of: [before, after] }).tags_entry_of).toEqual([APP, APPENDED]);
    expect(pyAfter).not.toBe(pyBefore!);
    expect(pyAfter).toBe(pyAppended!);
    expect(parseContextTags(contextTagsEntry(after)!)).toEqual(parseContextTags(APPENDED));
    expect(statedItems(parseContextTags(contextTagsEntry(after)!), "work")).toEqual(["Appended item"]);
  });

  /**
   * The app's own rule, restated (no cross-repo import): Edge-City/agentvillage-app main 35a2ddab
   * src/lib/agent/context.ts :98 `SEPARATOR = /\n§\n/`, :139-144 `entries` (split, trim, drop empty),
   * :185-187 `tagsEntryText` = `entries(user).filter((e) => e.startsWith(TAGS_MARK)).at(-1)`; the control
   * plane (Edge-City/agentvillage-controlplane main 38a214c2) replaces that same entry in place,
   * control-plane/src/memory-entry.js:150 ENTRY_PY `at=found[-1]`, and reads it so,
   * control-plane/src/context-claims-render.js:636.
   */
  test("LAST is the entry the app reads: context.ts tagsEntryText, on every text in its own form", () => {
    const appTagsEntryText = (user: string) =>
      user.split(/\n§\n/).map((e) => e.trim()).filter(Boolean).filter((e) => e.startsWith(CONTEXT_TAGS_MARK)).at(-1) ?? null;
    // The app splits on the bare separator and folds no CR: compare on the texts written in that form.
    const appForm = CASES.filter(([, text]) => !text.includes("\r") && !/\n[ \t]+§|§[ \t]+\n/.test(text));
    expect(appForm.length).toBeGreaterThanOrEqual(13);
    for (const [name, text] of appForm) expect([name, contextTagsEntry(text)]).toEqual([name, appTagsEntryText(text)]);
    const multi = [OLDER, NOTE, APP, APPENDED].join(SEP);
    expect(contextTagsEntry(multi)).toBe(appTagsEntryText(multi));
    expect(contextTagsEntry(multi)).toBe(APPENDED);
  });

  test("Python's trim set is JavaScript's String.prototype.trim set, character for character", () => {
    const js: string[] = [];
    for (let c = 0; c <= 0xffff; c++) if (String.fromCharCode(c).trim() === "") js.push(String.fromCharCode(c));
    const pyTrim = pyRun({ constants: true }).constants!.js_trim;
    expect(pyTrim).not.toBeNull();
    expect([...pyTrim!].sort()).toEqual(js.sort());
  });
});

describe("writers are unchanged: nothing in the overlay writes a new id", () => {
  test("only the two readers, the Private items rule in tools.md (and these tests) name an id, anywhere in the repo", () => {
    const REPO = join(import.meta.dir, "..", "..", "..", "..");
    const hits: string[] = [];
    // Every file git tracks or would add (OV-415 refute N6): the whole checkout, less what .gitignore drops.
    const listed = Bun.spawnSync(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: REPO, stdout: "pipe", stderr: "pipe" });
    expect(listed.exitCode).toBe(0);
    const files = listed.stdout.toString().split("\0").filter(Boolean);
    expect(files.length).toBeGreaterThan(500);
    for (const rel of files) {
      const path = join(REPO, rel);
      let st;
      try { st = statSync(path); } catch { continue; }
      if (!st.isFile() || st.size > 8_000_000) continue;
      const text = readFileSync(path, "latin1");
      if (text.includes("agentvillage/private") || text.includes("agentvillage/edgecityindia2026")) hits.push(rel);
    }
    expect(hits.sort()).toEqual([
      // ov#431: the developer docs describe the vocabulary; write nothing.
      "docs/MINI-APPS-DEVELOPER.md",
      // Lead L32765 R1 (ov#604): the USER.md gate's tags allowlist (one block, byte-identical in both plugins) keeps a
      // line whose mark names Edge City India 2026 (`agentvillage/edgecityindia2026` among them) outside a
      // private session; it reads the id, writes nothing. Its README and tests name the ids. village-memory's
      // prompt notes also name the shared id beside Edge City India 2026 (review-b ov#559 N4, ov#602): prose.
      "plugins/av-events/_user_md_gate.py",
      "plugins/village-memory/README.md",
      "plugins/village-memory/__init__.py",
      "plugins/village-memory/tests/test_user_md_tags.py",
      "scripts/tests/memory-signal-gate.test.ts",
      "skills/index-network/scripts/context-tags.ts",
      "skills/index-network/scripts/memory_signal_gate.py",
      "skills/index-network/scripts/tests/context-marks-corpus.ts",
      "skills/index-network/scripts/tests/context-marks.test.ts",
      "skills/index-network/scripts/tests/context-private-skip.test.ts",
      "skills/index-network/scripts/tests/fixtures/context-marks-golden.json",
      // VISIBILITY B3 prompt half: the agent's reader-side rule ("Private items"), which writes nothing.
      "skills/index-network/tools.md",
    ]);
  });
});
