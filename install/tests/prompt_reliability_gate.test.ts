import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const gateLines = [
  "Answer the visible ask first.",
  "A short Telegram/support prompt gets a short answer by default",
  "Ask at most one primary question.",
  "Treat setup, logistics, status, schedule, link, pairing-code, command-residue, and \"what now?\" fragments as support",
  "Do not expose plumbing:",
  "Do not put templates, generic welcome copy, capability lists, or profile synthesis before a direct answer",
  "Silence or no reply is neutral.",
];

function read(path: string): string {
  return readFileSync(path, "utf8");
}

test("real-channel behavior gate is mirrored into loaded prompt surfaces", () => {
  for (const path of [
    "workspace/real-channel-behavior.md",
    "workspace/AGENTS.md",
    "skills/index-network/bootstrap.md",
    "skills/index-network/tools.md",
    "skills/index-network/heartbeat.md",
  ]) {
    const text = read(path);
    for (const line of gateLines) expect(text).toContain(line);
  }
});

test("Index capture rules exclude support-only fragments", () => {
  const tools = read("skills/index-network/tools.md");

  for (const fragment of [
    "setup fragment",
    "pairing code",
    "command residue",
    "profile/link/status question",
    "schedule-only ask",
    "\"what now?\"",
    "silence/no reply",
  ]) {
    expect(tools).toContain(fragment);
  }
});

test("exemplars do not instruct URL mutation for greetings", () => {
  const exemplars = read("skills/index-network/exemplars.md");

  expect(exemplars).toContain("Action URLs must be emitted exactly as returned by tools.");
  expect(exemplars).not.toMatch(/append (?:it|the greeting|.*message parameter)/i);
  expect(exemplars).not.toContain("&msg=");
  expect(exemplars).not.toContain("?text=");
});
