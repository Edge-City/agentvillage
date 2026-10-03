/**
 * Answers from a list tool that are failures even though they arrive as an
 * HTTP 200 "complete" result. Every path that reads a list must treat each one
 * as an Index failure, never as "nothing listed".
 */

import { FIXTURE, type ToolHandler } from "./index-mcp-fake";

export interface FailureInput {
  label: string;
  handler: ToolHandler;
  /** The code the shared client or parser throws. */
  code: string;
}

const row = { id: "opp-x", url: "https://index.network/o/opp-x", status: "pending", peer: { name: "X" } };

export function failureInputs(key: "opportunities" | "intents"): FailureInput[] {
  const lead = "Listed:\n\n";
  return [
    { label: "success:false after the lead", handler: () => `${lead}${JSON.stringify({ success: false, error: "internal" })}`, code: "mcp-tool-error" },
    { label: "prose with no JSON object", handler: () => "Something went wrong while listing.", code: "mcp-unparsed" },
    { label: "an empty text", handler: () => "", code: "mcp-unparsed" },
    { label: `an object without ${key}`, handler: () => `${lead}${JSON.stringify({ success: true })}`, code: "mcp-unparsed" },
    { label: `${key} not an array`, handler: () => `${lead}${JSON.stringify({ success: true, [key]: row })}`, code: "mcp-unparsed" },
    { label: "text after the JSON", handler: () => `${lead}${JSON.stringify({ success: true, [key]: [row] })}\n\nMore below.`, code: "mcp-unparsed" },
    { label: "result.content missing", handler: () => ({ result: { resultType: "complete" } }), code: "mcp-bad-response" },
    { label: "result.content not an array", handler: () => ({ result: { content: "text", resultType: "complete" } }), code: "mcp-bad-response" },
    {
      label: "a non-text item carrying a text field",
      handler: () => ({ result: { content: [{ type: "resource", text: `${lead}${JSON.stringify({ success: true, [key]: [row] })}` }], resultType: "complete" } }),
      code: "mcp-bad-response",
    },
    { label: "the fixture's isError tool error", handler: () => ({ result: FIXTURE.responses.toolError.result }), code: "mcp-tool-error" },
  ];
}
