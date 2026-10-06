import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, expect, test } from "bun:test";

import { SyncRefused, readSnapshot, syncReferences } from "../sync-india-references";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Doc {
  path: string;
  body: string;
  title?: string;
}

const WIKI: Doc = { path: "wiki-content.md", body: "# Edge City India 2026 Wiki\n\nSource: https://edgecity.notion.site/x\n\n#### 🛏 Accommodation\nRiva.\n" };
const WEBSITE: Doc = { path: "website-content.md", body: "# Edge City India 2026\n\nMandrem, Goa.\n" };
const HOUSING: Doc = { path: "newsletter/housing-for-edge-city-india.md", body: "# Housing for Edge City India\n\nRiva is the community hub.\n" };
const TRAVEL: Doc = { path: "newsletter/getting-to-edge-city-india.md", body: "# Getting to Edge City India\n\nTaxi to Riva.\n" };
const ABOUT: Doc = { path: "website/about.md", body: "# About Edge City\n" };

function upstream(docs: Doc[], options: { event?: string; index?: string | null } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "india-upstream-"));
  temps.push(root);
  const refs = join(root, "references");
  for (const doc of docs) {
    mkdirSync(dirname(join(refs, doc.path)), { recursive: true });
    writeFileSync(join(refs, doc.path), doc.body);
  }
  mkdirSync(refs, { recursive: true });
  writeFileSync(
    join(refs, "manifest.json"),
    JSON.stringify({
      version: 1,
      event: options.event ?? "edge-india-2026",
      documents: docs.map((doc) => ({ path: doc.path, title: doc.title ?? doc.path, url: `https://example.org/${doc.path}`, kind: "newsletter" })),
    }),
  );
  if (options.index !== null) writeFileSync(join(refs, "index.md"), options.index ?? "# Edge City India 2026 — Public Reference Index\n");
  return root;
}

function target(): string {
  const root = mkdtempSync(join(tmpdir(), "india-target-"));
  temps.push(root);
  return join(root, "skills", "edge-india", "references");
}

const BASE = [WIKI, WEBSITE, HOUSING, TRAVEL, ABOUT];

test("a complete upstream tree lands whole, nested documents and index included, with a provenance record", () => {
  const dest = target();
  const result = syncReferences({
    source: upstream(BASE),
    target: dest,
    sourceCommit: "abc123",
    sourceCommitDate: "2026-10-05T10:00:00.000Z",
    now: () => new Date("2026-10-05T10:05:00.000Z"),
  });

  expect(result.changed).toBe(true);
  expect(result.documents).toBe(5);
  expect(readFileSync(join(dest, "newsletter", "housing-for-edge-city-india.md"), "utf8")).toContain("community hub");
  expect(existsSync(join(dest, "website", "about.md"))).toBe(true);
  expect(existsSync(join(dest, "index.md"))).toBe(true);
  const snapshot = readSnapshot(dest)!;
  expect(snapshot.event).toBe("edge-india-2026");
  expect(snapshot.source.commit).toBe("abc123");
  expect(snapshot.synced_at).toBe("2026-10-05T10:05:00.000Z");
  expect(snapshot.files.map((file) => file.path)).toContain("newsletter/getting-to-edge-city-india.md");
  expect(snapshot.files.every((file) => /^[0-9a-f]{64}$/.test(file.sha256))).toBe(true);
});

test("an unchanged rerun changes nothing, not even the timestamp", () => {
  const dest = target();
  const source = upstream(BASE);
  syncReferences({ source, target: dest, now: () => new Date("2026-10-05T10:00:00Z") });
  const result = syncReferences({ source, target: dest, now: () => new Date("2026-10-05T11:00:00Z") });
  expect(result.changed).toBe(false);
  expect(readSnapshot(dest)!.synced_at).toBe("2026-10-05T10:00:00.000Z");
});

test("a document the upstream manifest drops is removed here; an edited one is updated", () => {
  const dest = target();
  syncReferences({ source: upstream(BASE), target: dest });
  const edited = { ...HOUSING, body: "# Housing for Edge City India\n\nRiva and nearby villas.\n" };
  const result = syncReferences({ source: upstream([WIKI, WEBSITE, edited, ABOUT]), target: dest });

  expect(result.removed).toEqual(["newsletter/getting-to-edge-city-india.md"]);
  expect(result.updated).toContain("newsletter/housing-for-edge-city-india.md");
  expect(existsSync(join(dest, "newsletter", "getting-to-edge-city-india.md"))).toBe(false);
  expect(readFileSync(join(dest, "newsletter", "housing-for-edge-city-india.md"), "utf8")).toContain("villas");
});

test("files outside the manifest are not copied", () => {
  const dest = target();
  const source = upstream(BASE);
  writeFileSync(join(source, "references", "private-notes.md"), "# not listed\n");
  syncReferences({ source, target: dest });
  expect(existsSync(join(dest, "private-notes.md"))).toBe(false);
});

function expectRefusal(code: string, fn: () => unknown): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(SyncRefused);
    expect((error as SyncRefused).code).toBe(code);
    return;
  }
  throw new Error(`expected refusal ${code}`);
}

test("failed or partial upstream runs keep the last complete snapshot byte for byte", () => {
  const dest = target();
  syncReferences({ source: upstream(BASE), target: dest });
  const before = readFileSync(join(dest, "SNAPSHOT.json"), "utf8");
  const housing = readFileSync(join(dest, "newsletter", "housing-for-edge-city-india.md"), "utf8");

  // A listed document is missing (an interrupted indexer run).
  const partial = upstream(BASE);
  rmSync(join(partial, "references", HOUSING.path));
  expectRefusal("document_missing", () => syncReferences({ source: partial, target: dest }));

  // No manifest at all.
  const noManifest = upstream(BASE);
  rmSync(join(noManifest, "references", "manifest.json"));
  expectRefusal("manifest_missing", () => syncReferences({ source: noManifest, target: dest }));

  // No index.
  expectRefusal("index_missing", () => syncReferences({ source: upstream(BASE, { index: null }), target: dest }));

  // An empty document.
  expectRefusal("empty_document", () => syncReferences({ source: upstream([WIKI, WEBSITE, { ...HOUSING, body: "" }]), target: dest }));

  // The wiki is missing from the manifest.
  expectRefusal("required_document_missing", () => syncReferences({ source: upstream([WEBSITE, HOUSING, TRAVEL]), target: dest }));

  // Half the documents vanish at once.
  expectRefusal("snapshot_shrank", () => syncReferences({ source: upstream([WIKI, WEBSITE]), target: dest }));

  expect(readFileSync(join(dest, "SNAPSHOT.json"), "utf8")).toBe(before);
  expect(readFileSync(join(dest, "newsletter", "housing-for-edge-city-india.md"), "utf8")).toBe(housing);
});

test("a deliberate large removal goes through with allowShrink", () => {
  const dest = target();
  syncReferences({ source: upstream(BASE), target: dest });
  const result = syncReferences({ source: upstream([WIKI, WEBSITE]), target: dest, allowShrink: true });
  expect(result.removed.length).toBe(3);
});

test("an Esmeralda-era or half-migrated tree is refused", () => {
  const dest = target();
  expectRefusal("wrong_event", () => syncReferences({ source: upstream(BASE, { event: "edge-esmeralda-2026" }), target: dest }));
  const esmeraldaWiki = { ...WIKI, body: "# Edge Esmeralda 2026 Wiki\n" };
  expectRefusal("wrong_event", () => syncReferences({ source: upstream([esmeraldaWiki, WEBSITE, HOUSING]), target: dest }));
  expectRefusal("wrong_event", () => syncReferences({ source: upstream(BASE, { index: "# Edge Esmeralda index\n" }), target: dest }));
  expect(existsSync(dest)).toBe(false);
});

test("unsafe manifest paths and symlinks are refused", () => {
  const dest = target();
  const traversal = upstream(BASE);
  const manifestPath = join(traversal, "references", "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.documents.push({ path: "../../etc/passwd.md" });
  writeFileSync(manifestPath, JSON.stringify(manifest));
  expectRefusal("unsafe_path", () => syncReferences({ source: traversal, target: dest }));

  const linked = upstream(BASE);
  rmSync(join(linked, "references", TRAVEL.path));
  symlinkSync("/etc/hosts", join(linked, "references", TRAVEL.path));
  expectRefusal("not_a_regular_file", () => syncReferences({ source: linked, target: dest }));
});

test("the sync never writes into the Esmeralda references, and the old Esmeralda workflow is gone", () => {
  const workflow = readFileSync(join(REPO_ROOT, ".github", "workflows", "sync-edge-india-references.yml"), "utf8");
  expect(workflow).toContain("--target skills/edge-india/references");
  const commands = workflow.split("\n").filter((line) => !line.trim().startsWith("#")).join("\n");
  expect(commands).not.toContain("skills/edge-esmeralda/references");
  expect(existsSync(join(REPO_ROOT, ".github", "workflows", "sync-edge-esmeralda-references.yml"))).toBe(false);
  // The frozen Esmeralda snapshot is still Esmeralda content.
  const esmeraldaWiki = readFileSync(join(REPO_ROOT, "skills", "edge-esmeralda", "references", "wiki-content.md"), "utf8");
  expect(esmeraldaWiki.split("\n", 1)[0]).toContain("Edge Esmeralda 2026");
});

function withDoc(root: string, doc: { path: string; body: string | Buffer }): string {
  const refs = join(root, "references");
  mkdirSync(dirname(join(refs, doc.path)), { recursive: true });
  writeFileSync(join(refs, doc.path), doc.body);
  const manifestPath = join(refs, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.documents.push({ path: doc.path, title: doc.path, url: `https://example.org/${doc.path}`, kind: "newsletter" });
  writeFileSync(manifestPath, JSON.stringify(manifest));
  return root;
}

test("a tree the agents' knowledge-sync job would refuse is refused here, and nothing is published", () => {
  const dest = target();
  // A name the job's documentPathValid refuses although it is lowercase: over 121 characters, or a "..".
  expectRefusal("unsafe_path", () => syncReferences({ source: withDoc(upstream(BASE), { path: `newsletter/${"a".repeat(130)}.md`, body: "# Long\n" }), target: dest }));
  expectRefusal("unsafe_path", () => syncReferences({ source: withDoc(upstream(BASE), { path: "newsletter/a..b.md", body: "# Dots\n" }), target: dest }));
  // Bytes the job's textOk refuses: invalid UTF-8, a NUL, a Markdown file that opens like an HTML page.
  expectRefusal("not_text", () => syncReferences({ source: withDoc(upstream(BASE), { path: "newsletter/latin1.md", body: Buffer.from([0x23, 0x20, 0xe9, 0x0a]) }), target: dest }));
  expectRefusal("not_text", () => syncReferences({ source: withDoc(upstream(BASE), { path: "newsletter/nul.md", body: "# a\u0000b\n" }), target: dest }));
  expectRefusal("not_text", () => syncReferences({ source: withDoc(upstream(BASE), { path: "newsletter/page.md", body: "<!DOCTYPE html><html></html>\n" }), target: dest }));
  // More documents than the job takes.
  const many = upstream(BASE);
  const manifestPath = join(many, "references", "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  for (let i = 0; i < 500; i++) manifest.documents.push({ path: `newsletter/n${i}.md` });
  writeFileSync(manifestPath, JSON.stringify(manifest));
  expectRefusal("too_many_documents", () => syncReferences({ source: many, target: dest }));
  expect(existsSync(dest)).toBe(false);
});

test("the sync writes only under its target: no staging or retired copy survives a run, refused or not", () => {
  const dest = target();
  const parent = dirname(dest);
  syncReferences({ source: upstream(BASE), target: dest });
  expect(readdirSync(parent)).toEqual(["references"]);
  syncReferences({ source: upstream([...BASE.slice(0, 4)]), target: dest });
  expect(readdirSync(parent)).toEqual(["references"]);
  expectRefusal("not_text", () => syncReferences({ source: withDoc(upstream(BASE), { path: "newsletter/nul.md", body: "# a\u0000b\n" }), target: dest }));
  expect(readdirSync(parent)).toEqual(["references"]);
  // The workflow stages only the target directory for its commit.
  const workflow = readFileSync(join(REPO_ROOT, ".github", "workflows", "sync-edge-india-references.yml"), "utf8");
  const adds = workflow.split("\n").filter((line) => /\bgit add\b/.test(line)).map((line) => line.trim());
  expect(adds).toEqual(["git add -A skills/edge-india/references/"]);
});
