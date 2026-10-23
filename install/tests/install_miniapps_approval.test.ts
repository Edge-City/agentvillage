// The generic approval card's projection key on the installer (Phase 1 item 6; cp#352, context L19898 / L20468): a
// GENERIC card app's entry carries `approval: { prepare, card, fields: { item, total, when, shared }, bind }` after its
// four keys, and operations [an accepted list or none, prepare, card]. The installer takes it in exactly the cp's
// box shape (catalog.boxEntry / the bridge's _card_entry_ok), stages it byte for byte (projectionSha256 is the cp's),
// and refuses a malformed key for that app alone, `operations_not_generic`. The shared card vectors
// (plugins/village-bridge/tests/vectors/mini-app-card.json) run end to end: staged by the installer, then the bridge
// reads the declaration back from the staged mini-apps.json and renders (or refuses) each vector's card.
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CARD_FIELDS, cardKey, GENERIC_OPERATIONS_ACCEPTED, reconcileMiniApps, REFUSAL_CODES, REVIEWED_MINI_APPS, validateProjection } from "../install_miniapps";

const REPO = join(import.meta.dir, "..", "..");
const VECTORS_DIR = join(REPO, "plugins", "village-bridge", "tests", "vectors");
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function home() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "curated-miniapps-approval-")));
  roots.push(root);
  return root;
}
const OFFER = "cd".repeat(32);
const READ = "mini-app.read", CTX_READ = "mini-app.context.read", CTX_WRITE = "mini-app.context.write";
const ID = "acme", PREPARE = "acme.order.prepare", CONFIRM = "acme.order.confirm";
const skillText = (id: string) => `---\nname: ${id}\nversion: 1.0.0\n---\n# Acme\nPrepare, then confirm on the card.\n`;
const bundle = (id = ID) => ({ offer: OFFER, skills: JSON.stringify({ version: 1, skills: [{ id, sha256: sha(skillText(id)), bytes: Buffer.from(skillText(id)).toString("base64") }] }) });
type Delivery = ReturnType<typeof bundle>;
type Receipt = ReturnType<typeof reconcileMiniApps> & { refused?: { id: string; code: string }[] };
const gold = () => ({ ...REVIEWED_MINI_APPS[0], operations: [...REVIEWED_MINI_APPS[0].operations], skills: [...REVIEWED_MINI_APPS[0].skills] });
const dizko = () => ({ ...REVIEWED_MINI_APPS[1], operations: [...REVIEWED_MINI_APPS[1].operations], skills: [...REVIEWED_MINI_APPS[1].skills] });
const onDisk = (root: string) => readFileSync(join(root, "mini-apps.json"), "utf8");
const DECLARATION = { item: "rental.summary", total: "price.text", when: "slot.text", shared: "sharedWith", bind: [["kayakId", "request.kayakId"], ["hours", "request.hours"]] };
/**
 * The cp's `approval` key for a manifest declaration (catalog approval(): the four paths in contract order, then bind
 * as declared). A declaration the cp's validator would refuse is keyed the same way (a missing field or bind left out,
 * any other key after the four), so the installer sees what such a key would carry.
 */
function keyFor(declaration: unknown, id = ID, prepare = `${id}.order.prepare`, card = `${id}.order.confirm`): Record<string, unknown> {
  if (!declaration || typeof declaration !== "object" || Array.isArray(declaration)) return { prepare, card, fields: declaration };
  const d = declaration as Record<string, unknown>;
  const names = [...CARD_FIELDS.filter(f => Object.hasOwn(d, f)), ...Object.keys(d).filter(k => k !== "bind" && !(CARD_FIELDS as readonly string[]).includes(k))];
  return { prepare, card, fields: Object.fromEntries(names.map(k => [k, d[k]])), ...(Object.hasOwn(d, "bind") ? { bind: d.bind } : {}) };
}
/** The entry the cp emits for a card app (catalog.boxEntry): id, version, operations [list, prepare, card], skills, approval. */
function cardApp(approval: unknown = keyFor(DECLARATION), ops: readonly string[] = [], id = ID): Record<string, unknown> {
  const named = (key: string, fallback: string) => {
    const value = approval && typeof approval === "object" ? (approval as Record<string, unknown>)[key] : undefined;
    return typeof value === "string" ? value : fallback;
  };
  return { id, version: "1.0.0", operations: [...ops, named("prepare", `${id}.order.prepare`), named("card", `${id}.order.confirm`)], skills: [id], approval };
}
/** Stage, check the receipt's invariants (as install_miniapps_generic.test.ts staged()), and verify recomputes it. */
function staged(projection: { version: number; apps: Record<string, unknown>[] }, root: string, delivery: Delivery = bundle()): Receipt {
  const receipt = reconcileMiniApps(projection, root, undefined, false, delivery) as Receipt;
  const refusedIds = (receipt.refused ?? []).map(r => r.id);
  for (const r of receipt.refused ?? []) expect(REFUSAL_CODES).toContain(r.code as typeof REFUSAL_CODES[number]);
  const accepted = projection.apps.filter(a => !refusedIds.includes(a.id as string));
  expect(receipt.apps.map(a => a.id)).toEqual(accepted.map(a => a.id as string));
  // Byte for byte: the staged authority file is the cp's projection minus the refused ids, so the cp's sha matches.
  const subset = JSON.stringify({ version: 1, apps: accepted });
  expect(receipt.projectionSha256).toBe(sha(subset));
  expect(onDisk(root)).toBe(subset);
  expect(reconcileMiniApps(projection, root, undefined, true, delivery)).toEqual(receipt);
  return receipt;
}
function refusedAlone(app: Record<string, unknown>, code: string, delivery: Delivery = bundle()): void {
  const root = home();
  const receipt = staged({ version: 1, apps: [gold(), dizko(), app] }, root, delivery);
  expect(receipt.refused).toEqual([{ id: app.id as string, code }]);
  expect(existsSync(join(root, "skills", app.id as string, "SKILL.md"))).toBe(false);
  expect(JSON.parse(onDisk(root)).apps.map((a: { id: string }) => a.id)).toEqual(["gold-stars", "dizko"]);
}
const BRIDGE = "import importlib.util, json, pathlib, sys\n" +
  "spec = importlib.util.spec_from_file_location('village_bridge', sys.argv[1])\n" +
  "bridge = importlib.util.module_from_spec(spec); sys.modules[spec.name] = bridge; spec.loader.exec_module(bridge)\n" +
  "mini, mc = sys.modules['village_bridge._mini_apps'], sys.modules['village_bridge._mini_app_card']\n";
/** The bridge over each job: `entry` -> its own generic-entry check; `home` -> the staged card op's declaration and its card. */
function bridge(jobs: unknown[]): Record<string, unknown>[] {
  const code = BRIDGE + "out = []\n" +
    "for job in json.load(sys.stdin):\n" +
    "    if 'entry' in job:\n" +
    "        out.append({'accepted': mini._generic_entry_ok(job['entry'])}); continue\n" +
    "    found = mc.projected_operation(pathlib.Path(job['home']), job['card'])\n" +
    "    record = found and found[2]\n" +
    "    if not record or 'card' not in record:\n" +
    "        out.append({'declared': None}); continue\n" +
    "    r = {'declared': record['card']}\n" +
    "    try:\n" +
    "        r['card'] = mc.card_fields(record['card'], job['preview'], job['request'] if 'request' in job else None)\n" +
    "        r['payloadHash'] = mc.payload_hash(r['card'])\n" +
    "        r['summary'] = mc.card_summary(r['card'])\n" +
    "    except ValueError as error:\n" +
    "        r['summaryError' if 'card' in r else 'error'] = str(error)\n" +
    "    out.append(r)\n" +
    "print(json.dumps(out, ensure_ascii=False))\n";
  const run = spawnSync("python3", ["-I", "-c", code, join(REPO, "plugins", "village-bridge", "__init__.py")],
    { input: JSON.stringify(jobs), encoding: "utf8", env: { PATH: process.env.PATH, HOME: home() }, maxBuffer: 64 << 20 });
  expect([run.status, run.stderr]).toEqual([0, ""]);
  return JSON.parse(run.stdout);
}

test("the rule's constants are the shared validator's and the bridge's (CARD_FIELDS, CARD_OPERATION, the accepted lists)", () => {
  const validator = createRequire(import.meta.url)("../../scripts/mini-apps-manifests.cjs");
  expect([...CARD_FIELDS]).toEqual([...validator.CARD_FIELDS]);
  const plugin = readFileSync(join(REPO, "plugins", "village-bridge", "_mini_apps.py"), "utf8");
  expect(plugin).toContain('CARD_OPERATION = re.compile(r"[a-z][a-z0-9-]*(?:\\.[a-z][a-z0-9-]*){1,3}")');
  expect(plugin).toContain('CARD_FIELD_KEYS = frozenset({"item", "total", "when", "shared"})');
  expect(plugin).toContain("0 < len(v) <= 200");
  expect(plugin).toContain("len(bind) > 32");
  expect(plugin).toContain("return any(app[\"operations\"] == [*ops, prepare, card] for ops in (*APP_OPERATIONS_ACCEPTED, ()))");
});

test("a card app's entry is staged byte for byte with its key, for each accepted list or none; the bridge takes its card op", () => {
  for (const ops of [[], ...GENERIC_OPERATIONS_ACCEPTED.map(list => [...list])]) {
    const root = home();
    const projection = { version: 1, apps: [gold(), dizko(), cardApp(keyFor(DECLARATION), ops)] };
    const receipt = staged(projection, root);
    expect(receipt).not.toHaveProperty("refused");
    // Nothing refused: mini-apps.json IS the cp's projection, so projectionSha256 equals the cp's sha of what it sent.
    expect(onDisk(root)).toBe(JSON.stringify(projection));
    expect(receipt.projectionSha256).toBe(sha(JSON.stringify(projection)));
    expect(Object.keys(JSON.parse(onDisk(root)).apps[2])).toEqual(["id", "version", "operations", "skills", "approval"]);
    expect(receipt.skills.served).toEqual([ID]);
    expect(validateProjection(projection, bundle())).toEqual(projection);
    const [read] = bridge([{ home: root, card: CONFIRM, preview: {} }]);
    expect(read.declared).toEqual(DECLARATION);
  }
  // A plain generic entry (no key) is exactly as before.
  const root = home();
  const plain = { id: ID, version: "1.0.0", operations: [READ], skills: [ID] };
  expect(staged({ version: 1, apps: [plain] }, root)).not.toHaveProperty("refused");
  expect(onDisk(root)).toBe(JSON.stringify({ version: 1, apps: [plain] }));
});

test("the exact command the cp runs: stdin with the key in, the key byte for byte in mini-apps.json and the receipt's sha", () => {
  const projection = { version: 1, apps: [gold(), cardApp(keyFor(DECLARATION), [READ])] };
  const input = JSON.stringify(projection);
  const box = home();
  for (const args of [[], ["--verify"]]) {
    const run = spawnSync("bun", ["--no-env-file", "--no-install", "install/install_miniapps.ts", ...args], {
      cwd: REPO, input, encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: box, HERMES_HOME: box, MINI_APPS_SKILLS_OFFER: OFFER, MINI_APPS_SKILLS: bundle().skills },
    });
    expect([run.status, run.stderr]).toEqual([0, ""]);
    const receipt = JSON.parse(run.stdout);
    expect(receipt.projectionSha256).toBe(sha(input));
    expect(receipt).not.toHaveProperty("refused");
  }
  expect(onDisk(box)).toBe(input);
});

test("shared vectors mini-app-card.json (89, sha 5f7e6113): staged by the installer, every card or code the bridge renders from the staged key", () => {
  const bytes = readFileSync(join(VECTORS_DIR, "mini-app-card.json"));
  expect(sha(bytes)).toBe("5f7e61131ec778024fc9d0dba4ebf98e8a61595a7b5a3305c994d4988863754c");
  type Vector = { name: string; declaration: unknown; preview: unknown; request?: unknown; card?: unknown; payloadHash?: string; summary?: string; summaryError?: string; error?: string };
  const vectors: Vector[] = JSON.parse(bytes.toString("utf8")).vectors;
  expect(vectors.length).toBe(89);
  expect(vectors.filter(v => v.name.startsWith("cp: ")).length).toBe(23);
  const jobs: unknown[] = [];
  const outcome: Record<string, string[]> = { accepted: [], refused: [] };
  for (const v of vectors) {
    const root = home();
    const receipt = staged({ version: 1, apps: [gold(), dizko(), cardApp(keyFor(v.declaration))] }, root);
    if (receipt.refused) {
      // Only a key outside the box shape is refused at install, and the card engine refuses that declaration too.
      expect([v.name, receipt.refused]).toEqual([v.name, [{ id: ID, code: "operations_not_generic" }]]);
      expect([v.name, v.error]).toEqual([v.name, "approval_card_invalid"]);
      outcome.refused.push(v.name);
      continue;
    }
    outcome.accepted.push(v.name);
    jobs.push({ home: root, card: CONFIRM, preview: v.preview, ...(Object.hasOwn(v, "request") ? { request: v.request } : {}) });
  }
  // The three declarations whose key is not in the box shape (a missing field, no bind, a bind entry that is no pair).
  expect(outcome.refused).toEqual(["declaration missing a field (shared) -> invalid", "declaration without bind -> invalid", "declaration bind entry not a pair -> invalid"]);
  const rendered = bridge(jobs);
  const accepted = vectors.filter(v => outcome.accepted.includes(v.name));
  accepted.forEach((v, i) => {
    const got = rendered[i];
    // The bridge reads back exactly the declaration the vector names (the key survived the installer unchanged).
    expect([v.name, got.declared]).toEqual([v.name, v.declaration]);
    const want = v.card !== undefined
      ? { card: v.card, payloadHash: v.payloadHash, ...(v.summary !== undefined ? { summary: v.summary } : { summaryError: v.summaryError }) }
      : { error: v.error };
    const { declared: _, ...out } = got;
    expect([v.name, out]).toEqual([v.name, want]);
  });
  expect([accepted.filter(v => v.card !== undefined).length, accepted.filter(v => v.error !== undefined).length, outcome.refused.length]).toEqual([20, 66, 3]);
});

test("shared vectors mini-app-projection-entry.json (13, sha 25c5358f): the installer's answer is the cp's and the bridge's", () => {
  const bytes = readFileSync(join(VECTORS_DIR, "mini-app-projection-entry.json"));
  expect(sha(bytes)).toBe("25c5358fc846f98f4f64efbb7b397f72b29b4f1f7b2545095c2c549843359816");
  type Case = { name: string; cp: string; box: string; entry: Record<string, unknown> | null; legacyEntry?: Record<string, unknown> };
  const cases: Case[] = JSON.parse(bytes.toString("utf8")).cases;
  expect(cases.length).toBe(13);
  for (const c of cases) {
    const given = (c.entry ?? c.legacyEntry)!;
    // As the cp's own run of these vectors: `approval` names prepare and card; the declaration rides with it (commit 4),
    // in the cp's key order (catalog.boxEntry).
    const approval = given.approval as { prepare: string; card: string } | undefined;
    const app = { id: given.id, version: given.version, operations: given.operations, skills: given.skills, ...(approval ? { approval: keyFor(DECLARATION, given.id as string, approval.prepare, approval.card) } : {}) };
    if (c.name === "digit-first-id") {
      // ov#455: an id outside GENERIC_ID (a digit first) fails the whole stage, nothing written; the cp never serves one
      // (its validator refuses the skill name) and drops the entry besides (cp "dropped").
      const root = home();
      expect(() => reconcileMiniApps({ version: 1, apps: [gold(), app] }, root, undefined, false, bundle("2acme"))).toThrow("mini_apps_invalid_entry");
      expect(existsSync(join(root, "mini-apps.json"))).toBe(false);
      continue;
    }
    const root = home();
    const receipt = staged({ version: 1, apps: [gold(), dizko(), app] }, root);
    expect([c.name, receipt.refused ?? "accepted"]).toEqual([c.name, c.box === "accepted" ? "accepted" : [{ id: ID, code: "operations_not_generic" }]]);
    expect([c.name, c.cp === "dropped"]).toEqual([c.name, c.box === "refused"]);
    if (c.box === "accepted" && approval) expect(bridge([{ home: root, card: approval.card, preview: {} }])[0].declared).toEqual(DECLARATION);
  }
});

test("a malformed `approval` refuses that app alone (operations_not_generic), exactly where the bridge refuses it too", () => {
  const key = keyFor(DECLARATION) as { prepare: string; card: string; fields: Record<string, string>; bind: string[][] };
  const fields = key.fields;
  const astral = "\u{1F600}".repeat(200);
  const malformed: [string, unknown][] = [
    ["null", null], ["a list", [PREPARE, CONFIRM]], ["a string", PREPARE], ["empty", {}],
    ["no bind", { prepare: PREPARE, card: CONFIRM, fields }], ["no fields", { prepare: PREPARE, card: CONFIRM, bind: [] }],
    ["an extra key", { ...key, title: "Acme" }],
    ["prepare equals card", { ...key, card: PREPARE }],
    ["prepare of another app", { ...key, prepare: "other.order.prepare" }],
    ["prepare not a string", { ...key, prepare: 7 }],
    ["an underscore op", { ...key, prepare: "acme.order_prepare" }],
    ["a digit-first segment", { ...key, prepare: "acme.2fa.prepare" }],
    ["an upper-case op", { ...key, card: "acme.Order.confirm" }],
    ["one segment", { ...key, card: "acme" }],
    ["five segments", { ...key, card: "acme.a.b.c.d" }],
    ["a trailing newline", { ...key, card: CONFIRM + "\n" }],
    ["fields missing shared", { ...key, fields: { item: fields.item, total: fields.total, when: fields.when } }],
    ["fields with a fifth", { ...key, fields: { ...fields, note: "note" } }],
    ["fields a list", { ...key, fields: Object.values(fields) }],
    ["an empty field", { ...key, fields: { ...fields, total: "" } }],
    // review-b N3: every one of the four fields is bounded, not only `when` (201 code points, ASCII and astral).
    ...CARD_FIELDS.flatMap(field => [
      [`${field} over 200 code points`, { ...key, fields: { ...fields, [field]: "a".repeat(201) } }],
      [`${field} over 200 astral code points`, { ...key, fields: { ...fields, [field]: "\u{1F600}".repeat(201) } }],
    ] as [string, unknown][]),
    ["a field not a string", { ...key, fields: { ...fields, item: 7 } }],
    ["a null field", { ...key, fields: { ...fields, shared: null } }],
    ["bind not a list", { ...key, bind: {} }],
    ["bind 33 pairs", { ...key, bind: Array.from({ length: 33 }, (_, i) => [`k${i}`, `request.k${i}`]) }],
    ["a bind entry of one", { ...key, bind: [["kayakId"]] }],
    ["a bind entry of three", { ...key, bind: [["kayakId", "request.kayakId", "x"]] }],
    ["a bind path empty", { ...key, bind: [["", "request.kayakId"]] }],
    ["a bind path over 200 code points", { ...key, bind: [["kayakId", "r".repeat(201)]] }],
    ["a bind path not a string", { ...key, bind: [["hours", 2]] }],
    // review-b N2: `__proto__` and `constructor` as JSON.parse makes them (own keys, as stdin is parsed), on the key
    // and inside fields: inOrder sees them as a fifth key.
    ["__proto__ on the key", JSON.parse(`{"prepare":"${PREPARE}","card":"${CONFIRM}","fields":${JSON.stringify(fields)},"bind":[],"__proto__":{"card":"x"}}`)],
    ["constructor on the key", JSON.parse(`{"prepare":"${PREPARE}","card":"${CONFIRM}","fields":${JSON.stringify(fields)},"bind":[],"constructor":"x"}`)],
    ["__proto__ in fields", JSON.parse(`{"prepare":"${PREPARE}","card":"${CONFIRM}","fields":{"item":"a","total":"a","when":"a","shared":"a","__proto__":"a"},"bind":[]}`)],
    ["constructor in fields", JSON.parse(`{"prepare":"${PREPARE}","card":"${CONFIRM}","fields":{"item":"a","total":"a","when":"a","shared":"a","constructor":"a"},"bind":[]}`)],
  ];
  // The JSON.parse'd keys really carry the name as an own key (an object literal's `__proto__:` would set the prototype).
  for (const [name, approval] of malformed.filter(([name]) => /__proto__|constructor/.test(name))) {
    const own = name.endsWith("fields") ? (approval as { fields: object }).fields : approval as object;
    expect([name, Object.keys(own).at(-1)]).toEqual([name, name.split(" ")[0]]);
  }
  // The two places the installer is stricter than the bridge (which ignores key order and takes {prepare, card}
  // alone): the cp emits neither (boxEntry: the four in contract order; fields and bind always present).
  const stricter: [string, unknown][] = [
    ["declaration-less", { prepare: PREPARE, card: CONFIRM }],
    ["keys out of order", { card: CONFIRM, prepare: PREPARE, fields, bind: key.bind }],
    ["fields out of order", { ...key, fields: { total: fields.total, item: fields.item, when: fields.when, shared: fields.shared } }],
  ];
  const opsWrong: [string, unknown][] = [
    ["card before prepare", [CONFIRM, PREPARE]], ["the read after the card ops", [PREPARE, CONFIRM, READ]], ["no card op", [READ, PREPARE]],
    ["prepare twice", [PREPARE, PREPARE, CONFIRM]], ["no accepted list", [READ, CTX_READ, PREPARE, CONFIRM]], ["the read alone", [READ]],
    ["an own op beside", [READ, "acme.status", PREPARE, CONFIRM]], ["context out of order", [CTX_READ, READ, CTX_WRITE, PREPARE, CONFIRM]],
  ];
  // review-b N4: a malformed key beside PLAIN ops (an accepted list, no card op) is refused, never staged as a plain
  // generic app with the key dropped (the `card === null` refusal in checkApp).
  const plainOps: [string, unknown][] = [
    ["a malformed key with [read]", { ...cardApp({ ...key, card: PREPARE }), operations: [READ] }],
    ["a malformed key with the context list", { ...cardApp({ ...key, fields: { ...fields, total: "" } }), operations: [READ, CTX_READ, CTX_WRITE] }],
    ["a null key with [read]", { ...cardApp(null), operations: [READ] }],
  ];
  const entries: [string, Record<string, unknown>, boolean][] = [
    ...malformed.map(([name, approval]) => [name, cardApp(approval), false] as [string, Record<string, unknown>, boolean]),
    ...opsWrong.map(([name, operations]) => [name, { ...cardApp(), operations }, false] as [string, Record<string, unknown>, boolean]),
    ...plainOps.map(([name, app]) => [name, app as Record<string, unknown>, false] as [string, Record<string, unknown>, boolean]),
    ...stricter.map(([name, approval]) => [name, cardApp(approval), true] as [string, Record<string, unknown>, boolean]),
  ];
  for (const [, app] of entries) refusedAlone(app, "operations_not_generic");
  // The bridge's own _generic_entry_ok refuses each of these too, except the three stricter forms it accepts.
  const verdicts = bridge(entries.map(([, entry]) => ({ entry })));
  expect(entries.map(([name], i) => [name, verdicts[i].accepted])).toEqual(entries.map(([name, , strict]) => [name, strict]));
  // The bounds themselves are accepted: 200 code points (astral too: Python's len), 32 bind pairs, an empty bind.
  for (const approval of [{ ...key, fields: { ...fields, item: astral } }, { ...key, bind: Array.from({ length: 32 }, (_, i) => [`k${i}`, `request.k${i}`]) },
    { ...key, bind: [] }, { ...key, card: "acme.a.b.c" }]) {
    expect(cardKey(approval, ID)).toEqual(approval as never);
    const root = home();
    expect(staged({ version: 1, apps: [gold(), cardApp(approval)] }, root)).not.toHaveProperty("refused");
    expect(bridge([{ entry: cardApp(approval) }])[0].accepted).toBe(true);
  }
});

test("ov#466 S1: a card op that is a platform generic op, duplicated in operations, refuses that app alone (the cp's prepare-and-card-once rule)", () => {
  // Only app id `mini-app` can name one (a card op starts with `<id>.`, and every accepted op starts with `mini-app.`).
  // cp#352 boxRefusal (control-plane/src/mini-apps-catalog.js:403-404) takes operations [an accepted list or none,
  // prepare, card] with prepare and card ONCE each, so it never emits these; the installer now answers as the cp does.
  const id = "mini-app", delivery = bundle(id);
  const key = (prepare: string, card: string) => keyFor(DECLARATION, id, prepare, card);
  const duplicated: [string, Record<string, unknown>][] = [
    ["prepare is the read, after [read]", cardApp(key(READ, "mini-app.order.confirm"), [READ], id)],
    ["prepare is the read, after the context list", cardApp(key(READ, "mini-app.order.confirm"), [READ, CTX_READ, CTX_WRITE], id)],
    ["prepare is the context read, after the context list", cardApp(key(CTX_READ, "mini-app.order.confirm"), [READ, CTX_READ, CTX_WRITE], id)],
    ["card is the read, after [read]", cardApp(key("mini-app.order.prepare", READ), [READ], id)],
    ["card is the context write, after the context list", cardApp(key("mini-app.order.prepare", CTX_WRITE), [READ, CTX_READ, CTX_WRITE], id)],
  ];
  for (const [name, app] of duplicated) {
    expect([name, (app.operations as string[]).length - new Set(app.operations as string[]).size]).toEqual([name, 1]);
    refusedAlone(app, "operations_not_generic", delivery);
    expect(() => validateProjection({ version: 1, apps: [app] }, delivery)).toThrow("operations_not_generic");
  }
  // The bridge's _card_entry_ok still takes these (`[*ops, prepare, card]`, no once-each check): the installer is the
  // stricter side here, as the cp is, so the box never stages one.
  expect(bridge(duplicated.map(([, entry]) => ({ entry }))).map(v => v.accepted)).toEqual(duplicated.map(() => true));
  // Each op once is the cp's accepted shape and stays accepted, byte for byte (fail-closed only on the duplicate).
  for (const app of [cardApp(key(READ, "mini-app.order.confirm"), [], id), cardApp(key(CTX_WRITE, "mini-app.order.confirm"), [READ], id)]) {
    const root = home();
    const projection = { version: 1, apps: [gold(), app] };
    expect(staged(projection, root, delivery)).not.toHaveProperty("refused");
    expect(onDisk(root)).toBe(JSON.stringify(projection));
  }
});

test("rule 5 still holds with the key; a reviewed id never takes it (the whole stage fails, as today)", () => {
  for (const app of [{ ...cardApp(), version: "1.0.0-beta.1" }, { ...cardApp(), skills: ["other"] }, { ...cardApp(), hooks: ["sh"] }]) refusedAlone(app, "bundle_invalid");
  const root = home();
  reconcileMiniApps({ version: 1, apps: [gold()] }, root);
  const before = onDisk(root);
  const forkicks = { ...REVIEWED_MINI_APPS[2], operations: [...REVIEWED_MINI_APPS[2].operations], skills: [...REVIEWED_MINI_APPS[2].skills], approval: keyFor(DECLARATION, "forkicks", "forkicks.order.prepare", "forkicks.order.confirm") };
  expect(() => reconcileMiniApps({ version: 1, apps: [gold(), forkicks] }, root)).toThrow("mini_apps_unreviewed_bundle");
  expect(onDisk(root)).toBe(before);
  // The all-or-nothing check keeps its contract: a malformed key is its first refusal.
  expect(() => validateProjection({ version: 1, apps: [cardApp({ prepare: PREPARE, card: CONFIRM })] }, bundle())).toThrow("operations_not_generic");
});
