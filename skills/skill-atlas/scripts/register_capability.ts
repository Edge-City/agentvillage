#!/usr/bin/env bun
/**
 * Register a generated skill as a capability on the user's Edge Book agent.
 *
 * Usage:
 *   bun scripts/register_capability.ts register path/to/skill-card.yaml
 *   bun scripts/register_capability.ts sync
 *   bun scripts/register_capability.ts status
 *
 * Stdout: JSON with { ok, action, registered, pending, failed, messages }.
 *
 * Behavior:
 *   - `register` upserts (by slug) a capability record into ~/.agentvillage/capability-registry.json,
 *     then runs `edge-book capability advertise --name <slug> --version <v> --summary <s>` if the
 *     Edge Book CLI is installed and the agent identity is initialized. The advertisement is a
 *     signed capability_advertisement post (schema edge-book/capability/0.1) on the user's agent.
 *   - `sync` retries every record whose registration is "pending" — so a skill minted before the
 *     user installs Edge Book (npm i -g edge-book) registers automatically later.
 *   - Only PUBLIC fields are ever shared: the skill's slug (name), version, and a one-line summary
 *     built from the card's title and task. Never the expertise map or examples.
 *
 * Environment:
 *   EDGE_BOOK_CLI   optional — command to invoke the CLI (default: "edge-book" on PATH).
 *                   Supports a multi-word value, e.g. "node /path/to/dist/edge-book.js".
 *   EDGE_BOOK_HOME  optional — passed through to the CLI; selects the agent directory
 *                   (Edge Book's own default is ~/.openclaw/edge-book).
 *
 * Exit codes:
 *   0 - command completed (records remaining pending is a normal state).
 *   2 - file read error or bad arguments.
 *   3 - skill card parse error or card missing required public fields.
 *
 * Zero dependencies; runs on Bun or Node 22.18+ (native TypeScript).
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const REGISTRY_DIR = join(homedir(), ".agentvillage");
const REGISTRY_PATH = join(REGISTRY_DIR, "capability-registry.json");
// Card fields required to build the public advertisement. Nothing else is read for transmission.
const REQUIRED_CARD_FIELDS = ["slug", "title", "task", "status"] as const;
const SUMMARY_MAX = 200; // keep the advertisement summary one line, feed-friendly

interface Capability {
  slug: string;
  title: string;
  version: string;
  summary: string;
  card_status: string;
  skill_card_path: string;
  created_at: string;
  registration: "pending" | "registered" | "failed";
  registered_at: string | null;
  capability_id: string | null; // Edge Book cap_… id, kept for a future `capability deprecate`
}

interface Registry {
  version: number;
  capabilities: Capability[];
}

function loadRegistry(): Registry {
  if (!existsSync(REGISTRY_PATH)) return { version: 1, capabilities: [] };
  return JSON.parse(readFileSync(REGISTRY_PATH, "utf-8"));
}

function saveRegistry(registry: Registry): void {
  mkdirSync(REGISTRY_DIR, { recursive: true });
  writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2) + "\n", "utf-8");
}

/** Minimal flat-YAML reader for the scalar fields of a skill card. */
function readCardFields(path: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of readFileSync(path, "utf-8").split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    fields[match[1]] = value;
  }
  return fields;
}

function edgeBookCommand(): string[] {
  const override = process.env.EDGE_BOOK_CLI?.trim();
  return override ? override.split(/\s+/) : ["edge-book"];
}

/** True when the Edge Book CLI is callable AND the agent identity is initialized. */
function edgeBookReady(): { ready: boolean; reason: string } {
  const [cmd, ...prefix] = edgeBookCommand();
  const probe = spawnSync(cmd, [...prefix, "capability", "list"], { encoding: "utf-8", timeout: 30_000 });
  if (probe.error) return { ready: false, reason: "Edge Book CLI not installed (npm i -g edge-book)" };
  if (probe.status !== 0) return { ready: false, reason: `Edge Book not initialized (run: edge-book init): ${(probe.stderr || "").trim().slice(0, 120)}` };
  return { ready: true, reason: "" };
}

/**
 * Advertise one capability via the Edge Book CLI. The advertisement becomes a signed
 * capability_advertisement post on the user's agent, governed by Edge Book's grant model.
 */
function advertiseToEdgeBook(cap: Capability): { state: Capability["registration"]; capability_id: string | null; message: string } {
  const readiness = edgeBookReady();
  if (!readiness.ready) {
    return { state: "pending", capability_id: null, message: `${cap.slug}: queued — ${readiness.reason}.` };
  }
  const [cmd, ...prefix] = edgeBookCommand();
  const result = spawnSync(
    cmd,
    [...prefix, "capability", "advertise", "--name", cap.slug, "--version", cap.version, "--summary", cap.summary],
    { encoding: "utf-8", timeout: 60_000 },
  );
  if (result.error || result.status !== 0) {
    const detail = (result.stderr || result.error?.message || "unknown error").trim().slice(0, 200);
    // CLI present and initialized but the advertise itself failed — payload-level, needs a human.
    return { state: "failed", capability_id: null, message: `${cap.slug}: edge-book capability advertise failed — ${detail}. Review the card and re-run register.` };
  }
  const id = result.stdout.match(/cap_[A-Za-z0-9_-]+/)?.[0] ?? null;
  return { state: "registered", capability_id: id, message: `${cap.slug}: advertised on your Edge Book agent${id ? ` (${id})` : ""} — visible to your friends per your grant settings.` };
}

function summarize(registry: Registry) {
  return {
    registered: registry.capabilities.filter((c) => c.registration === "registered").length,
    pending: registry.capabilities.filter((c) => c.registration === "pending").length,
    failed: registry.capabilities.filter((c) => c.registration === "failed").length,
  };
}

// process.exitCode (not process.exit) — hard exit after console output trips a libuv assertion on Windows.
class Done extends Error {}
function emit(result: object, code: number): never {
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = code;
  throw new Done();
}

async function main(): Promise<void> {
  const [, , command, cardArg] = process.argv;
  const registry = loadRegistry();
  const messages: string[] = [];

  if (command === "status") {
    emit({ ok: true, action: "status", ...summarize(registry), capabilities: registry.capabilities }, 0);
  }

  if (command === "register") {
    if (!cardArg) {
      emit({ ok: false, action: "register", messages: ["Missing card path. Run: bun scripts/register_capability.ts register path/to/skill-card.yaml"] }, 2);
    }
    const cardPath = resolve(cardArg);
    let fields: Record<string, string>;
    try {
      fields = readCardFields(cardPath);
    } catch (exc) {
      emit({ ok: false, action: "register", messages: [`Could not read skill card: ${exc}`] }, 2);
    }
    const missing = REQUIRED_CARD_FIELDS.filter((f) => !fields[f]);
    if (missing.length > 0) {
      emit({ ok: false, action: "register", messages: [`Skill card missing public fields: ${missing.join(", ")}. Validate the card first.`] }, 3);
    }

    const summary = `${fields.title}: ${fields.task}`.slice(0, SUMMARY_MAX);
    const existing = registry.capabilities.find((c) => c.slug === fields.slug);
    const cap: Capability = {
      slug: fields.slug,
      title: fields.title,
      version: fields.version || "1.0.0",
      summary,
      card_status: fields.status,
      skill_card_path: cardPath,
      created_at: existing?.created_at ?? new Date().toISOString(),
      registration: "pending",
      registered_at: null,
      capability_id: existing?.capability_id ?? null,
    };
    const result = advertiseToEdgeBook(cap);
    cap.registration = result.state;
    cap.capability_id = result.capability_id ?? cap.capability_id;
    if (result.state === "registered") cap.registered_at = new Date().toISOString();
    messages.push(result.message);

    if (existing) Object.assign(existing, cap);
    else registry.capabilities.push(cap);
    saveRegistry(registry);
    emit({ ok: true, action: "register", ...summarize(registry), messages }, 0);
  }

  if (command === "sync") {
    const queue = registry.capabilities.filter((c) => c.registration === "pending");
    if (queue.length === 0) {
      emit({ ok: true, action: "sync", ...summarize(registry), messages: ["Nothing pending."] }, 0);
    }
    const readiness = edgeBookReady();
    if (!readiness.ready) {
      emit({ ok: true, action: "sync", ...summarize(registry), messages: [`${queue.length} capability record(s) queued — ${readiness.reason}.`] }, 0);
    }
    for (const cap of queue) {
      const result = advertiseToEdgeBook(cap);
      cap.registration = result.state;
      cap.capability_id = result.capability_id ?? cap.capability_id;
      if (result.state === "registered") cap.registered_at = new Date().toISOString();
      messages.push(result.message);
    }
    saveRegistry(registry);
    emit({ ok: true, action: "sync", ...summarize(registry), messages }, 0);
  }

  emit({ ok: false, action: command ?? "none", messages: ["Unknown command. Use: register <card.yaml> | sync | status"] }, 2);
}

main().catch((exc) => {
  if (!(exc instanceof Done)) {
    console.log(JSON.stringify({ ok: false, action: "error", messages: [String(exc)] }, null, 2));
    process.exitCode = 2;
  }
});
