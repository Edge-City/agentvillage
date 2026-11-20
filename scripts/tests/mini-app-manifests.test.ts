import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REVIEWED_MINI_APPS, validateProjection } from "../../install/install_miniapps";

// Mini-apps v2 Phase 0, P0-1 (MINIAPPS-PLATFORM-v2-design.md §1.1, §1.3, §8): the CI check over
// mini-apps/**. Every published manifest (mini-apps/catalog.json) is a valid v2 manifest by the ONE
// validator the control plane serves the catalog with, and its skill hash is the skill's bytes.
//
// 1. scripts/mini-apps-manifests.cjs and mini-apps/manifest.v2.schema.json are the control plane's
//    (control-plane/src/mini-apps-manifests.js, control-plane/src/mini-apps/manifest.v2.schema.json)
//    and the app's (src/lib/server/mini-apps/manifests/) byte for byte, pinned twice as the visibility
//    vocabulary is: by mini-apps/manifests.pins.json (byte-identical in the three repos) and by the
//    constants below (each repo's test holds the same three). With AV_CONTROLPLANE_DIR set to a
//    controlplane checkout, the shared files and the cp's vendored manifests are compared as bytes.
// 2. catalog.json lists every mini-apps/<id>/ that holds a manifest, and only those.
// 3. Every listed manifest validates; skills[0].sha256 is sha256(skills/<id>/SKILL.md) and its version
//    the skill's frontmatter version (§1.3: a skill edit is a manifest edit).
// 4. The v1 entries the cp serves from them are the ones this overlay's installer accepts.
// Nothing on a box reads these files yet (no skill, plugin or installer step): data only, no roll.
//   bun test scripts/tests/mini-app-manifests.test.ts

const MODULE_SHA256 = "777542ef0eb3145be81badb8a1383638a0a000dc3b725d307239f3c52f55df88";
const SCHEMA_SHA256 = "13de632e759feb71a02694b9a10335b2662ab6e5d27393927623fab0757f8a92";
const PINS_SHA256 = "108a8598fb8fe95afa012fbc812b6caa42960a10cef0bfa5342ad67f85fec0e1";
const REPO = join(import.meta.dir, "..", "..");
const DIR = join(REPO, "mini-apps");
const m = createRequire(import.meta.url)("../mini-apps-manifests.cjs");
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const bytes = (path: string) => readFileSync(join(REPO, path));
const index = JSON.parse(bytes("mini-apps/catalog.json").toString("utf8"));
const manifest = (id: string) => JSON.parse(bytes(`mini-apps/${id}/manifest.json`).toString("utf8"));
/**
 * Fail closed on anything under mini-apps/ that is not a reviewed catalog file (security review
 * "authorization-reserved-namespace", shape a): the tree is a closed list, never "whatever manifest.json files exist".
 * Allowed: README.md, catalog.json, manifest.v2.schema.json, manifests.pins.json at the top; one directory
 * per catalog.json id holding manifest.json and optionally README.md. No symlink anywhere, no other name,
 * extension or case variant, no directory catalog.json does not list (and none it lists may be missing).
 */
const TOP_FILES = ["README.md", "catalog.json", "manifest.v2.schema.json", "manifests.pins.json"];
function treeViolations(dir: string, ids: string[]): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const st = lstatSync(join(dir, name));
    if (st.isSymbolicLink()) out.push(`${name}: symlink`);
    else if (st.isFile()) { if (!TOP_FILES.includes(name)) out.push(`${name}: unknown file`); }
    else if (!st.isDirectory()) out.push(`${name}: not a file or directory`);
    else if (!ids.includes(name)) out.push(`${name}/: not in catalog.json`);
    else {
      const inner = readdirSync(join(dir, name)).sort();
      for (const file of inner) {
        const fst = lstatSync(join(dir, name, file));
        if (fst.isSymbolicLink()) out.push(`${name}/${file}: symlink`);
        else if (!fst.isFile() || !["manifest.json", "README.md"].includes(file)) out.push(`${name}/${file}: unknown entry`);
      }
      if (!inner.includes("manifest.json")) out.push(`${name}/manifest.json: missing`);
    }
  }
  for (const id of ids) if (!readdirSync(dir).includes(id)) out.push(`${id}/: listed but missing`);
  return out;
}
const reasons = (result: { ok: boolean; errors?: { path: string; reason: string }[] }) =>
  result.ok ? [] : result.errors!.map(e => `${e.path} ${e.reason}`);

describe("the shared files", () => {
  test("module and schema hold the sha256 the cp and app also pin, in the pin file and in this test", () => {
    const pins = JSON.parse(bytes("mini-apps/manifests.pins.json").toString("utf8"));
    expect(sha256(bytes("scripts/mini-apps-manifests.cjs"))).toBe(MODULE_SHA256);
    expect(sha256(bytes("mini-apps/manifest.v2.schema.json"))).toBe(SCHEMA_SHA256);
    expect(pins.manifest).toBe(m.MANIFEST_VERSION);
    expect(pins.sha256).toEqual({ module: MODULE_SHA256, schema: SCHEMA_SHA256 });
    expect(sha256(bytes("mini-apps/manifests.pins.json"))).toBe(PINS_SHA256);
  });

  test("the schema file is the module SCHEMA, serialized", () => {
    expect(bytes("mini-apps/manifest.v2.schema.json").toString("utf8")).toBe(JSON.stringify(m.SCHEMA, null, 2) + "\n");
  });

  // cp#337 N4 (generic apps are cp-sourced): the cp's index may hold generic apps that never enter this repo, so
  // catalog.json is compared as "this index == the cp's index filtered to the reviewed ids, in the cp's order";
  // the validator, the schema, the pins and every reviewed manifest stay byte for byte.
  test.skipIf(!process.env.AV_CONTROLPLANE_DIR)("cmp: the control plane's copies and vendored manifests, byte for byte; its index filtered to the reviewed ids is this index (AV_CONTROLPLANE_DIR)", () => {
    const cp = join(process.env.AV_CONTROLPLANE_DIR!, "control-plane", "src");
    const pairs = [["scripts/mini-apps-manifests.cjs", "mini-apps-manifests.js"],
      ...["manifest.v2.schema.json", "manifests.pins.json", ...index.apps.map((id: string) => `${id}/manifest.json`)]
        .map(file => [`mini-apps/${file}`, `mini-apps/${file}`])];
    for (const [mine, theirs] of pairs) expect([mine, Buffer.compare(readFileSync(join(cp, theirs)), bytes(mine))]).toEqual([mine, 0]);
    const theirs = JSON.parse(readFileSync(join(cp, "mini-apps", "catalog.json"), "utf8"));
    const reviewed = new Set(REVIEWED_MINI_APPS.map(app => app.id));
    expect([theirs.catalog, theirs.apps.filter((id: string) => reviewed.has(id))]).toEqual([index.catalog, index.apps]);
    for (const id of theirs.apps.filter((id: string) => !reviewed.has(id))) expect([id, lstatSync(join(cp, "mini-apps", "skills", id, "SKILL.md")).isFile()]).toEqual([id, true]);
  });
});

describe("mini-apps/: the published catalog", () => {
  test("catalog.json is a valid index, in the order the cp serves, and mini-apps/ holds only reviewed catalog files", () => {
    expect(m.checkSchema(index, m.INDEX_SCHEMA)).toEqual([]);
    expect(index.apps).toEqual(["gold-stars", "dizko", "zzzbot", "slopfolio", "forkicks", "mosaic", "dreamstarter", "kismet", "library", "favorloop", "eci-volunteers"]);
    expect(treeViolations(DIR, index.apps)).toEqual([]);
  });

  test("the closed tree refuses every stray form (fail closed, never skipped)", () => {
    const root = mkdtempSync(join(tmpdir(), "mini-app-tree-"));
    try {
      for (const file of TOP_FILES) writeFileSync(join(root, file), "{}");
      mkdirSync(join(root, "acme"));
      writeFileSync(join(root, "acme", "manifest.json"), "{}");
      expect(treeViolations(root, ["acme"])).toEqual([]);
      const cases: [string, () => void, string][] = [
        ["an unlisted app directory", () => { mkdirSync(join(root, "evil")); writeFileSync(join(root, "evil", "manifest.json"), "{}"); }, "evil/: not in catalog.json"],
        ["another extension", () => writeFileSync(join(root, "acme", "manifest.v3.json"), "{}"), "acme/manifest.v3.json: unknown entry"],
        // A name absent from the directory, so the variant is a file of its own on a case-insensitive disk too.
        ["a case variant", () => writeFileSync(join(root, "acme", "Readme.md"), "x"), "acme/Readme.md: unknown entry"],
        ["a top-level manifest", () => writeFileSync(join(root, "manifest.json"), "{}"), "manifest.json: unknown file"],
        ["a nested directory", () => mkdirSync(join(root, "acme", "sub")), "acme/sub: unknown entry"],
        ["a symlinked manifest", () => { rmSync(join(root, "acme", "manifest.json")); symlinkSync(join(root, "catalog.json"), join(root, "acme", "manifest.json")); }, "acme/manifest.json: symlink"],
        ["a symlinked app directory", () => symlinkSync(join(root, "acme"), join(root, "other")), "other: symlink"],
        ["a listed app with no directory", () => {}, "gone/: listed but missing"],
      ];
      for (const [why, plant, want] of cases) {
        plant();
        expect([why, treeViolations(root, ["acme", "gone"].slice(0, why.startsWith("a listed") ? 2 : 1)).includes(want)]).toEqual([why, true]);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("every listed manifest is a valid v2 manifest, and the catalog builds with none dropped", () => {
    for (const id of index.apps) expect([id, reasons(m.validateManifest(manifest(id)))]).toEqual([id, []]);
    const built = m.buildCatalog(index, Object.fromEntries(index.apps.map((id: string) => [id, manifest(id)])));
    expect([built.ok, built.dropped]).toEqual([true, []]);
  });

  test("each manifest's skill is its skills/<id>/SKILL.md: sha256 of the bytes, and the frontmatter version", () => {
    for (const id of index.apps) {
      const [skill] = manifest(id).skills;
      const file = bytes(skill.path);
      const version = /^---\n(?:.*\n)*?version: (\S+)\n(?:.*\n)*?---\n/.exec(file.toString("utf8"))?.[1];
      expect([id, skill.path, skill.sha256, skill.version]).toEqual([id, `skills/${id}/SKILL.md`, sha256(file), version]);
    }
  });

  test("the v1 entries the cp serves from them are the ones this overlay's installer accepts", () => {
    const entry = (opts: object) => (id: string) => {
      const { version, operations, skills } = m.v1Entry(manifest(id), opts);
      return { id, version, operations, skills };
    };
    for (const opts of [{}, { person: true }, { person: true, context: true }]) {
      const projection = { version: 1, apps: index.apps.map(entry(opts)) };
      expect(validateProjection(projection)).toEqual(projection);
    }
  });

  test("service.kind none: Mosaic's manifest serves the installer's two Mosaic lists, no mcp block; every other form is refused", () => {
    const mosaic = manifest("mosaic");
    expect(mosaic).toMatchObject({ service: { kind: "none" }, operations: [], data: { context: { maxEntries: 12 } } });
    expect(m.FIRST_PARTY.mosaic).toEqual({ none: true });
    expect(Object.entries(m.FIRST_PARTY).filter(([, grant]: [string, any]) => Object.hasOwn(grant, "none")).map(([id]) => id)).toEqual(["mosaic"]);
    const base = m.v1Entry(mosaic), context = m.v1Entry(mosaic, { person: true, context: true });
    expect([base.operations, context.operations]).toEqual([["mini-app.read"], ["mini-app.read", "mini-app.context.read", "mini-app.context.write"]]);
    for (const entry of [base, context]) {
      expect([entry.restricted, entry.data, Object.hasOwn(entry, "mcp")]).toEqual([true, { context: { maxEntries: 12 } }, false]);
      const projection = { version: 1, apps: [{ id: entry.id, version: entry.version, operations: entry.operations, skills: entry.skills }] };
      expect(validateProjection(projection)).toEqual(projection);
    }
    const as = (id: string) => (x: any) => { x.id = id; x.skills = [{ ...x.skills[0], name: id, path: `skills/${id}/SKILL.md` }]; };
    const cases: [string, (x: any) => void, string[]][] = [
      ["a third party", as("acme-notes"), ["/service/kind none_first_party_only"]],
      ["dizko (first party, not granted)", as("dizko"), ["/service/kind none_first_party_only"]],
      ["an op of its own", x => { x.operations = [{ name: "mosaic.summary", class: "read" }]; }, ["/operations none_has_operations"]],
      ["no data.context", x => { delete x.data; }, ["/data/context none_without_context"]],
      ["a baseUrl", x => { x.service.baseUrl = "https://agents.edgecity.live/"; }, ["/service/baseUrl none_has_endpoint"]],
      ["auth", x => { x.service.auth = { mode: "none" }; }, ["/service/auth none_has_auth"]],
      ["an mcp block", x => { x.mcp = { url: "https://agents.edgecity.live/mcp", tools: [] }; }, ["/mcp additionalProperties"]],
    ];
    for (const [why, mutate, want] of cases) {
      const x = manifest("mosaic");
      mutate(x);
      expect([why, reasons(m.validateManifest(x))]).toEqual([why, want]);
    }
    // Every other kind still needs an op of its own.
    for (const id of index.apps.filter((id: string) => id !== "mosaic" && id !== "gold-stars")) {
      const x = manifest(id);
      x.operations = [];
      expect([id, reasons(m.validateManifest(x))]).toEqual([id, ["/operations operations_required"]]);
    }
  });

  test("the validator refuses what the schema closes (a sample; the cp's test holds the full corpus)", () => {
    const fk = () => manifest("forkicks");
    const cases: [string, (x: any) => void, string][] = [
      ["missing visibility", x => { delete x.visibility; }, "/ required:visibility"],
      ["unknown key", x => { x.restricted = true; }, "/restricted additionalProperties"],
      ["wrong type", x => { x.operations[0].maxRequestBytes = "4096"; }, "/operations/0/maxRequestBytes type"],
      ["op of another app", x => { x.operations[0].name = "gold-stars.menu"; }, "/operations/0/name prefix"],
      ["an http: URL", x => { x.description = "http://example.com"; }, "/description http_url"],
      ["a code field", x => { x.operations[0].command = "bun run x.ts"; }, "/operations/0/command additionalProperties"],
      // Reserved namespaces: what an app may claim is pinned in the validator (FIRST_PARTY, RESERVED_IDS).
      ["a third party claiming a core prefix", x => { x.id = "acme"; x.skills[0] = { ...x.skills[0], name: "acme", path: "skills/acme/SKILL.md" };
        x.legacy = { prefixes: ["rolodex"] }; x.operations = [{ name: "rolodex.person", class: "read" }]; }, "/legacy first_party_only"],
      ["a reserved id", x => { x.id = "rolodex"; x.skills[0] = { ...x.skills[0], name: "rolodex", path: "skills/rolodex/SKILL.md" };
        x.operations = [{ name: "rolodex.person", class: "read" }]; }, "/id reserved"],
      ["internal kind for a non-core app", x => { x.service = { kind: "internal" }; }, "/service/kind internal_first_party_only"],
    ];
    for (const [why, mutate, want] of cases) {
      const value = fk();
      mutate(value);
      expect([why, reasons(m.validateManifest(value)).includes(want)]).toEqual([why, true]);
    }
  });

  // review-b N3: JSON.parse keeps the last of two equal keys, so a diff can show one value and serve
  // another. One serialization per document closes that: a duplicate key is never canonical.
  test("every manifest and catalog.json is in canonical form (so a duplicate key cannot hide in a diff)", () => {
    const canonical = (text: string) => text === JSON.stringify(JSON.parse(text), null, 2) + "\n";
    for (const file of ["mini-apps/catalog.json", ...index.apps.map((id: string) => `mini-apps/${id}/manifest.json`)])
      expect([file, canonical(bytes(file).toString("utf8"))]).toEqual([file, true]);
    const zzz = bytes("mini-apps/zzzbot/manifest.json").toString("utf8");
    const dup = zzz.replace('  "visibility": "sandbox",\n', '  "visibility": "sandbox",\n  "visibility": "everyone",\n');
    expect(dup).not.toBe(zzz);
    expect(JSON.parse(dup).visibility).toBe("everyone");
    expect(canonical(dup)).toBe(false);
  });
});

// baseUrl: [url, refusal or null] (review-b N8; security reviews "ssrf-denylist-incomplete" and
// "ssrf-parser-differential"). The same table in the cp, app and overlay tests.
const ENDPOINTS: [string, string | null][] = [
  // IPv4 private and special space, by parsed address, and the public neighbours (any IP literal is refused).
  ["https://0.1.2.3/", "internal_host"], ["https://10.0.0.1/", "internal_host"], ["https://100.64.0.1/", "internal_host"],
  ["https://100.127.255.255/", "internal_host"], ["https://127.0.0.1/", "internal_host"], ["https://169.254.169.254/", "internal_host"],
  ["https://172.16.0.1/", "internal_host"], ["https://172.31.255.255/", "internal_host"], ["https://192.0.0.8/", "internal_host"],
  ["https://192.168.1.1/", "internal_host"], ["https://198.18.0.1/", "internal_host"], ["https://198.19.255.255/", "internal_host"],
  ["https://224.0.0.1/", "internal_host"], ["https://240.0.0.1/", "internal_host"], ["https://255.255.255.255/", "internal_host"],
  ["https://100.128.0.1/", "ip_literal"], ["https://172.32.0.1/", "ip_literal"], ["https://198.20.0.1/", "ip_literal"], ["https://8.8.8.8/", "ip_literal"],
  // Every form the WHATWG parser turns into a dotted quad.
  ["https://2130706433/", "internal_host"], ["https://0x7f.1/", "internal_host"], ["https://0177.0.0.1/", "internal_host"],
  ["https://127.1", "internal_host"], ["https://0x7f.1", "internal_host"], ["https://0xa9fea9fe/", "internal_host"],
  // IPv6, IPv4-mapped (by the IPv4 rules), NAT64, ULA, link-local, multicast; public literals.
  ["https://[::]/", "internal_host"], ["https://[::1]/", "internal_host"], ["https://[::ffff:127.0.0.1]", "internal_host"],
  ["https://[::ffff:10.1.2.3]/", "internal_host"], ["https://[::ffff:169.254.169.254]/", "internal_host"], ["https://[64:ff9b::8.8.8.8]/", "internal_host"],
  ["https://[fc00::1]/", "internal_host"], ["https://[fd12::1]/", "internal_host"], ["https://[fe80::1]/", "internal_host"],
  ["https://[febf::1]/", "internal_host"], ["https://[ff02::1]/", "internal_host"],
  ["https://[::ffff:8.8.8.8]/", "ip_literal"], ["https://[2001:4860:4860::8888]/", "ip_literal"], ["https://[fec0::1]/", "ip_literal"],
  // Names: lower-cased, one trailing dot stripped; single-label and the private suffixes.
  ["https://localhost/mcp", "internal_host"], ["https://LOCALHOST./mcp", "internal_host"], ["https://a.localhost/", "internal_host"],
  ["https://x.internal/", "internal_host"], ["https://controlplane.railway.internal/x", "internal_host"], ["https://printer.local/", "internal_host"],
  ["https://nas.lan/", "internal_host"], ["https://router.home.arpa/", "internal_host"], ["https://home.arpa/", "internal_host"],
  ["https://wiki.intranet/", "internal_host"], ["https://ad.corp/", "internal_host"], ["https://intranet/", "internal_host"],
  ["https://a.local../", "internal_host"],
  // Scheme, userinfo, port.
  ["http://example.com/", "url"], ["https://", "url"], ["https:///x", "url"], ["https://u:p@example.com/", "userinfo"],
  ["https://u@example.com/", "userinfo"], ["https://example.com:8443/", "port"],
  // Parser differentials: what another parser (urllib, httpx, fetch) could read as another host.
  ["https://evil.example\\@169.254.169.254/", "url_chars"], ["https://a.example%2f@127.0.0.1", "userinfo"],
  ["https://a.exa\tmple.com/", "url_chars"], ["https://a.example.com\n/", "url_chars"], ["https://a.exa\rmple.com/", "url_chars"],
  ["https://example.com/a b", "url_chars"], ["https://%31%32%37.0.0.1/", "url_chars"], ["https://exa%6dple.com/", "url_chars"],
  ["https://bücher.example/", "url_chars"], ["https://xn--bcher-kva.example/", "idn"],
  // Canonical: new URL(s).href === s exactly (an empty path is written "/").
  ["https://MCP.dizko.app/mcp", "not_canonical"], ["https://mcp.dizko.app./mcp", "not_canonical"], ["https://example.com:443", "not_canonical"],
  ["https://example.com:443/", "not_canonical"], ["https://example.com", "not_canonical"], ["https://example.com/a/../b", "not_canonical"],
  ["https://example.com/%2e%2e/b", "not_canonical"], ["https://example.com/a?x=1", "not_canonical"], ["https://example.com/#f", "not_canonical"],
  // Accepted: the real three, a bare origin, every path character the allowlist takes.
  ["https://mcp.dizko.app/mcp", null], ["https://zzz.bot/mcp", null], ["https://slopfolio.com/mcp", null], ["https://example.com/", null],
  ["https://example.com/a-b_c.d~e!$&'()*+,;=:@%20/", null],
];

// review-b fold 1 (S1, N2, N8): what a manifest may name beyond its own namespace.
describe("the validator: secretRef, baseUrl hosts, nesting depth", () => {
  // 'acme': a third party of For Kicks' shape (https-json, app-token) under its own id.
  const acme = () => {
    const x = manifest("forkicks");
    x.id = "acme";
    for (const op of x.operations) {
      op.name = op.name.replace(/^forkicks\./, "acme.");
      if (op.approval) op.approval.prepare = op.approval.prepare.replace(/^forkicks\./, "acme.");
    }
    x.skills = [{ ...x.skills[0], name: "acme", path: "skills/acme/SKILL.md" }];
    x.service.auth.secretRef = "MINI_APP_ACME_TOKEN";
    return x;
  };

  test("S1: secretRef is the app's pinned grant or MINI_APP_<ID>_<NAME>, never another app's or the platform's", () => {
    expect(m.FIRST_PARTY.forkicks.secretRef).toBe("FORKICKS_AV_TOKEN");
    expect(reasons(m.validateManifest(manifest("forkicks")))).toEqual([]);
    expect(reasons(m.validateManifest(acme()))).toEqual([]);
    for (const name of ["DATABASE_URL", "FORKICKS_AV_TOKEN", "CP_ADMIN_TOKEN", "ANTHROPIC_API_KEY", "MINI_APP_ACME_CORP_TOKEN", "MINI_APP_ACME_", "MINI_APP_ACMETOKEN", "MINI_APP_FORKICKS_TOKEN"]) {
      const x = acme();
      x.service.auth.secretRef = name;
      expect([name, reasons(m.validateManifest(x))]).toEqual([name, ["/service/auth/secretRef not_granted"]]);
    }
  });

  test("N8: baseUrl: every private or special address, internal name and parser differential is refused by its rule", () => {
    for (const [url, want] of ENDPOINTS) expect([url, m.endpointRefusal(url)]).toEqual([url, want]);
    for (const [url, want] of ENDPOINTS) {
      const x = manifest("dizko");
      x.service.baseUrl = url;
      // The schema's own https pattern refuses some first (whitespace, http:); those are never accepted.
      if (m.checkSchema(x).length) { expect([url, want]).not.toEqual([url, null]); continue; }
      expect([url, reasons(m.validateManifest(x))]).toEqual([url, want ? [`/service/baseUrl ${want}`] : []]);
    }
    expect(index.apps.filter((id: string) => manifest(id).service.baseUrl).length).toBe(8); // ov#556: Favor Loop is the seventh; ov#450: Edge City Volunteers the eighth
  });

  test("N2: deep nesting is a dropped manifest with a code, never a throw; the catalog serves the rest", () => {
    // n object schemas, each the one property of the next: 2n + 4 containers deep in the manifest.
    const nest = (n: number) => { let v: any = { type: "object" }; for (let i = 0; i < n; i++) v = { type: "object", properties: { a: v } }; return v; };
    const deep = (n: number) => { const x = manifest("dizko"); x.operations[0].input = nest(n); return x; };
    expect(reasons(m.validateManifest(deep(20000)))).toEqual(["/operations/0/input too_large"]);
    const small = reasons(m.validateManifest(deep(40)));
    expect([small.length, small[0]!.endsWith(" too_deep"), small[0]!.startsWith("/operations/0/input/properties/a/")]).toEqual([1, true, true]);
    expect(reasons(m.validateManifest(deep(29)))).toEqual([]);
    const byId = Object.fromEntries(index.apps.map((id: string) => [id, manifest(id)]));
    byId.dizko = deep(20000);
    const built = m.buildCatalog(index, byId);
    expect(built.manifests.map((x: { id: string }) => x.id)).toEqual(["gold-stars", "zzzbot", "slopfolio", "forkicks", "mosaic", "dreamstarter", "kismet", "library", "favorloop", "eci-volunteers"]);
    expect(built.dropped).toEqual([{ id: "dizko", code: m.CODE, errors: [{ path: "/operations/0/input", reason: "too_large" }] }]);
  });

  test("review-a S1: a relay app (mcp, auth none) with any op but a read has no v1 entry (never served as mini-app.read)", () => {
    const relay = (mutate: (x: any) => void) => { const x = manifest("dizko"); mutate(x); expect(reasons(m.validateManifest(x))).toEqual([]); return x; };
    const write = relay(x => { x.operations[0].class = "write"; });
    const card = relay(x => { x.operations[0].class = "prepare"; x.operations[1].class = "needs-card"; x.operations[1].approval = { prepare: x.operations[0].name }; });
    for (const [why, x] of [["write", write], ["prepare + needs-card", card]] as const)
      for (const opts of [{}, { person: true, context: true }])
        expect([why, (() => { try { m.v1Entry(x, opts); return "served"; } catch (e: any) { return `${e.code} ${e.reason}`; } })()])
          .toEqual([why, "mini_apps_manifest_v1_unrepresentable relay_non_read_op"]);
    expect(m.v1Entry(manifest("dizko")).operations).toEqual(["mini-app.read"]);
  });

  test("review-a N1: a validator throw is a drop with a code, never a throw out of buildCatalog", () => {
    const byId: Record<string, any> = Object.fromEntries(index.apps.map((id: string) => [id, manifest(id)]));
    Object.defineProperty(byId.zzzbot, "name", { enumerable: true, get() { throw new RangeError("Maximum call stack size exceeded"); } });
    const built = m.buildCatalog(index, byId);
    expect(built.manifests.map((x: { id: string }) => x.id)).toEqual(["gold-stars", "dizko", "slopfolio", "forkicks", "mosaic", "dreamstarter", "kismet", "library", "favorloop", "eci-volunteers"]);
    expect(built.dropped).toEqual([{ id: "zzzbot", code: m.CODE, errors: [{ path: "/", reason: "unvalidatable" }] }]);
  });
});

// Fold 2 (release S1 and N1, review-a N-a and N-c): the two catalog marks, every fetched endpoint, linear text scan.
describe("the validator, fold 2: staff and listed, every endpoint field, linear text scan", () => {
  const at = (x: any, pointer: string, value: unknown) => {
    const keys = pointer.split("/").slice(1);
    const parent = keys.slice(0, -1).reduce((o, k) => o[k], x);
    parent[keys[keys.length - 1]!] = value;
    return x;
  };
  const json = (value: unknown) => JSON.stringify(value);
  // S-d1: every base below is a real manifest with both marks STRIPPED, so a correct rebase that marks a real
  // manifest (ov#411: gold-stars "staff": true) leaves these tests passing; what a real manifest may say is pinned below.
  const plain = (id: string) => { const { staff: _s, listed: _l, ...rest } = manifest(id); return rest; };

  test("S1: staff: true and listed: false validate and reach the v1 entry (after restricted), never the box projection", () => {
    for (const opts of [{}, { person: true }, { person: true, context: true }]) {
      const base = m.v1Entry(plain("gold-stars"), opts);
      const staff = { ...plain("gold-stars"), staff: true };
      expect(reasons(m.validateManifest(staff))).toEqual([]);
      const entry = m.v1Entry(staff, opts);
      expect(Object.keys(entry).slice(0, 6)).toEqual(["id", "name", "description", "version", "homepage", "staff"]);
      expect(entry.staff).toBe(true);
      const { staff: _s, ...rest } = entry;
      expect(json(rest)).toBe(json(base));
      const listed = { ...plain("zzzbot"), listed: false };
      expect(reasons(m.validateManifest(listed))).toEqual([]);
      const unlisted = m.v1Entry(listed, opts);
      expect(Object.keys(unlisted).slice(5, 9)).toEqual(["provenance", "auth", "restricted", "listed"]);
      expect(unlisted.listed).toBe(false);
      const { listed: _l, ...kept } = unlisted;
      expect(json(kept)).toBe(json(m.v1Entry(plain("zzzbot"), opts)));
      // The box projection is id, version, operations, skills: the installer takes it, and neither mark rides it.
      const projection = { version: 1, apps: [entry, unlisted].map(({ id, version, operations, skills }: any) => ({ id, version, operations, skills })) };
      expect(validateProjection(projection)).toEqual(projection);
    }
  });

  test("S1: absent (or the default value) changes nothing; anything but a boolean is refused by the schema", () => {
    for (const id of index.apps) {
      const today = json(m.v1Entry(plain(id), { person: true, context: true }));
      for (const marks of [{ staff: false }, { listed: true }, { staff: false, listed: true }])
        expect([id, json(m.v1Entry({ ...plain(id), ...marks }, { person: true, context: true }))]).toEqual([id, today]);
      // Only gold-stars may say staff, and only staff: true (the pinned grant); listed, if present, is false.
      const real = manifest(id);
      if (Object.hasOwn(real, "staff")) expect([id, real.staff]).toEqual(["gold-stars", true]);
      if (Object.hasOwn(real, "listed")) expect([id, real.listed]).toEqual([id, false]);
      expect(reasons(m.validateManifest(real))).toEqual([]);
    }
    for (const value of ["true", 1, 0, null, {}, [], "false"])
      for (const key of ["staff", "listed"])
        expect([key, json(value), reasons(m.validateManifest({ ...plain("gold-stars"), [key]: value }))]).toEqual([key, json(value), [`/${key} type`]]);
  });

  test("S1 (security finding): staff comes from the pinned grant alone; listed: false is open to any app and never raises visibility", () => {
    expect(Object.entries(m.FIRST_PARTY).filter(([, grant]: [string, any]) => grant.staff === true).map(([id]) => id)).toEqual(["gold-stars"]);
    const acme = plain("forkicks");
    acme.id = "acme";
    for (const op of acme.operations) { op.name = op.name.replace(/^forkicks\./, "acme."); if (op.approval) op.approval.prepare = op.approval.prepare.replace(/^forkicks\./, "acme."); }
    acme.skills = [{ ...acme.skills[0], name: "acme", path: "skills/acme/SKILL.md" }];
    acme.service.auth.secretRef = "MINI_APP_ACME_TOKEN";
    expect(reasons(m.validateManifest(acme))).toEqual([]);
    expect(reasons(m.validateManifest({ ...acme, staff: true }))).toEqual(["/staff staff_reserved"]);
    for (const id of index.apps.filter((id: string) => id !== "gold-stars"))
      expect([id, reasons(m.validateManifest({ ...plain(id), staff: true }))]).toEqual([id, ["/staff staff_reserved"]]);
    expect(m.v1Entry({ ...plain("gold-stars"), staff: true }).staff).toBe(true);
    expect(Object.hasOwn(m.v1Entry(plain("gold-stars")), "staff")).toBe(false);
    expect(Object.hasOwn(m.v1Entry(manifest("gold-stars")), "staff")).toBe(manifest("gold-stars").staff === true);
    // Nothing adds it: v1Entry on a manifest that never passed the validator writes no staff either.
    for (const x of [{ ...acme, staff: true }, { ...plain("forkicks"), staff: true }]) expect(Object.hasOwn(m.v1Entry(x), "staff")).toBe(false);
    for (const x of [{ ...acme, listed: false }, ...index.apps.map((id: string) => ({ ...plain(id), listed: false }))])
      expect([x.id, reasons(m.validateManifest(x)), m.v1Entry(x).listed]).toEqual([x.id, [], false]);
    for (const visibility of ["sandbox", "admins"]) {
      const x = { ...plain("forkicks"), visibility, listed: true };
      expect(reasons(m.validateManifest(x))).toEqual([]);
      expect(json(m.v1Entry(x))).toBe(json(m.v1Entry({ ...plain("forkicks"), visibility })));
      expect([m.v1Entry(x).restricted, Object.hasOwn(m.v1Entry(x), "listed")]).toEqual([true, false]);
    }
  });

  test("N-a: the schema's URL fields are homepage plus ENDPOINT_FIELDS, and every endpoint field goes through endpointRefusal", () => {
    const urls: string[] = [];
    const walk = (schema: any, where: string) => {
      if (!schema || typeof schema !== "object") return;
      if (typeof schema.pattern === "string" && schema.pattern.startsWith("^https://")) urls.push(where);
      for (const [key, child] of Object.entries(schema.properties || {})) walk(child, `${where}/${key}`);
    };
    walk(m.SCHEMA, "");
    expect(urls).toEqual(["/homepage", "/service/baseUrl", "/service/auth/oauth/resource", "/service/auth/oauth/discovery"]);
    expect([...m.ENDPOINT_FIELDS]).toEqual(urls.slice(1));
    // The real values pass: zzz.bot and Slopfolio carry all three.
    for (const id of ["zzzbot", "slopfolio"]) expect([id, reasons(m.validateManifest(manifest(id)))]).toEqual([id, []]);
    for (const field of m.ENDPOINT_FIELDS as string[]) {
      for (const host of ["127.0.0.1", "[::1]", "169.254.169.254", "localhost"]) {
        const x = at(manifest("zzzbot"), field, `https://${host}/mcp`);
        expect([field, host, reasons(m.validateManifest(x))]).toEqual([field, host, [`${field} internal_host`]]);
      }
      for (const [url, want] of ENDPOINTS) {
        const x = at(manifest("zzzbot"), field, url);
        if (m.checkSchema(x).length) { expect([url, want]).not.toEqual([url, null]); continue; }
        expect([field, url, reasons(m.validateManifest(x))]).toEqual([field, url, want ? [`${field} ${want}`] : []]);
      }
    }
  });

  test("review-b N7: a target path never changes the host or leaves the base: every refused form, and new URL(P, B).origin is B's", () => {
    const tp = (p: string) => {
      const x = manifest("forkicks");
      x.service.baseUrl = "https://api.acme.example/agent/";
      x.operations[0].target = { method: "GET", path: p };
      return reasons(m.validateManifest(x));
    };
    const refused: [string, string][] = [
      ["//evil.example/x", "path_escape"], ["//169.254.169.254/", "path_escape"], ["/a//b", "path_escape"], ["//", "path_escape"],
      ["/../admin", "path_escape"], ["/a/../b", "path_escape"], ["/..", "path_escape"], ["/a..b", "path_escape"], ["/./a", "path_escape"],
      ["/a/./b", "path_escape"], ["/.", "path_escape"], ["/a/.", "path_escape"],
      ["/\\evil.example/x", "path_chars"], ["\\evil", "path_chars"], ["/a\\b", "path_chars"], ["/%2f/evil", "path_chars"], ["/%2F", "path_chars"],
      ["/%5c", "path_chars"], ["/%5C", "path_chars"], ["/u@evil.example", "path_chars"], ["/a:b", "path_chars"], ["https:evil", "path_chars"],
      ["https://evil.example/", "path_escape"], ["javascript:x", "path_chars"], ["/a b", "path_chars"], ["/a\tb", "path_chars"], ["/a\nb", "path_chars"],
      ["/a?x=1", "path_chars"], ["/a#f", "path_chars"], ["/é", "path_chars"], ["/a~b", "path_chars"], ["a/b", "path_chars"], ["", "path_chars"],
    ];
    for (const [p, why] of refused) {
      expect([p, m.targetPathRefusal(p)]).toEqual([p, why]);
      // Through the validator: refused by the schema pattern, or past it by targetPathRefusal (never accepted).
      expect([p, tp(p).length > 0]).toEqual([p, true]);
    }
    expect(tp("//evil.example/x")).toEqual(["/operations/0/target/path path_escape"]);
    for (const p of ["/", "/menu", "/api/v1/menu.json", "/.well-known/x", "/a.", "/a/", "/A-b_C.9"]) expect([p, m.targetPathRefusal(p), tp(p)]).toEqual([p, null, []]);
    // The five real manifests pass, and any target path they carry is accepted (none carries one today).
    for (const x of index.apps.map((id: string) => manifest(id))) {
      expect([x.id, reasons(m.validateManifest(x))]).toEqual([x.id, []]);
      for (const op of x.operations) if (op.target?.path) expect([op.name, m.targetPathRefusal(op.target.path)]).toEqual([op.name, null]);
    }
    // Property: for every accepted P and every accepted B, new URL(P, B).origin === new URL(B).origin; on the
    // real baseUrls plus fixed ones, over a fuzzed set built from the forms above (a fixed seed).
    const bases = [...index.apps.map((id: string) => manifest(id).service.baseUrl).filter(Boolean), "https://api.acme.example/agent/", "https://example.com/", "https://a.example/b/c"].filter((b: string) => m.endpointRefusal(b) === null);
    expect(bases.length).toBeGreaterThanOrEqual(6);
    const tokens = ["/", "//", "\\", ".", "..", "./", "%2f", "%5C", "@", ":", "?", "#", " ", "\t", "a", "B", "0", "_", "-", "~", "http:", "evil.example", "169.254.169.254", "é"];
    let seed = 20261020;
    const next = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
    let accepted = 0;
    for (let i = 0; i < 20000; i++) {
      let p = next() % 2 ? "/" : "";
      for (let n = 1 + (next() % 8); n > 0; n--) p += tokens[next() % tokens.length];
      if (m.targetPathRefusal(p) !== null) continue;
      accepted++;
      for (const b of bases) expect([p, b, new URL(p, b).origin]).toEqual([p, b, new URL(b).origin]);
    }
    expect(accepted).toBeGreaterThan(500);
  });
  test("N1 / N-c: the text scan is linear: an adversarial eyJ- run at the 16 KiB input cap and at 1 MB, with a generous bound", () => {
    const adversarial = (n: number) => "eyJ-".repeat(Math.ceil(n / 4)).slice(0, n);
    const ms = (f: () => unknown) => { const t = performance.now(); f(); return performance.now() - t; };
    // At the cap, through the validator (the quadratic form took about 100 ms here; 32 such ops about 3 s).
    const x = manifest("dizko");
    for (const op of x.operations) if (op.input) op.input = { type: "object", description: adversarial(16000) };
    let out: string[] = [];
    expect(ms(() => { out = reasons(m.validateManifest(x)); })).toBeLessThan(500);
    expect(out).toEqual([]);
    // 64 KiB first: the quadratic form takes over a second here, so it fails before the 1 MB run.
    expect(ms(() => m.textRefusal(adversarial(65536)))).toBeLessThan(250);
    expect(ms(() => m.textRefusal(adversarial(1 << 20)))).toBeLessThan(1000);
    // Still a secret where a token starts a run of its class.
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2ln";
    for (const before of ["", " ", '"', "Bearer ", "token=", "\n"]) expect([before, m.textRefusal(before + jwt)]).toEqual([before, "secret"]);
    expect(m.textRefusal(adversarial(1 << 20))).toBe(null);
  });
});
