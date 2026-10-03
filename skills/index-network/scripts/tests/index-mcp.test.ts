import { afterEach, describe, expect, test } from "bun:test";

import {
  DEFAULT_INDEX_MCP_URL,
  INDEX_MCP_PROTOCOL_VERSION,
  INDEX_MCP_TIMEOUT_MS,
  IndexMcpError,
  callIndexTool,
  indexMcpRequest,
  indexMcpUrl,
  toolJsonArray,
  toolJsonObject,
} from "../index-mcp";
import { FAKE_API_KEY, FIXTURE, INDEX_TOOLS, PROTOCOL, eventStream, indexMcpFake } from "./index-mcp-fake";

const originalMcpUrl = process.env.INDEX_MCP_URL;

afterEach(() => {
  if (originalMcpUrl === undefined) delete process.env.INDEX_MCP_URL;
  else process.env.INDEX_MCP_URL = originalMcpUrl;
});

/** Codes are short and fixed-shape; nothing from the request or response leaks into them. */
const CODE = /^mcp-[a-z0-9-]+(?::-?\d+)?$/;

async function failure(promise: Promise<unknown>): Promise<IndexMcpError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(IndexMcpError);
    return err as IndexMcpError;
  }
  throw new Error("expected the call to fail");
}

/** A well-formed request body for the given method, built by hand (not by the client). */
function wellFormed(method: string, params: Record<string, unknown> = {}) {
  return {
    jsonrpc: "2.0",
    id: 7,
    method,
    params: { ...params, _meta: { ...FIXTURE.request.envelopeRequired } },
  };
}

function wellFormedHeaders(method: string, name?: string): Record<string, string> {
  const headers: Record<string, string> = {
    ...FIXTURE.request.headers,
    "x-api-key": FAKE_API_KEY,
    "mcp-method": method,
  };
  if (name !== undefined) headers["mcp-name"] = name;
  return headers;
}

describe("the pinned contract", () => {
  test("the client's revision is the fixture's, and the fixture lists exactly 14 tools", () => {
    expect(INDEX_MCP_PROTOCOL_VERSION).toBe("2026-07-28");
    expect(INDEX_MCP_PROTOCOL_VERSION).toBe(PROTOCOL);
    expect(INDEX_TOOLS).toHaveLength(14);
    expect(new Set(INDEX_TOOLS).size).toBe(14);
  });

  test("the fixture's list texts are a markdown lead, a blank line, then one JSON object", () => {
    for (const reply of [FIXTURE.responses.listIntents, FIXTURE.responses.listOpportunities]) {
      expect(reply.result.resultType).toBe("complete");
      expect("structuredContent" in reply.result).toBe(false);
      expect("isError" in reply.result).toBe(false);
      const text = reply.result.content[0].text;
      const [lead, json] = [text.slice(0, text.indexOf("\n\n")), text.slice(text.indexOf("\n\n") + 2)];
      expect(lead.split("\n")[0].endsWith(":")).toBe(true);
      for (const bullet of lead.split("\n").slice(1)) {
        expect(bullet).toMatch(/^- \[[^\]]+\]\(https:\/\/index\.network\/[io]\/[0-9a-f-]{36}\) — /);
      }
      const parsed = JSON.parse(json) as Record<string, unknown>;
      expect(typeof Object.values(parsed)[0]).toBe("boolean");
    }
  });
});

describe("the fake enforces the contract the way Index does", () => {
  async function send(headers: Record<string, string>, body: unknown) {
    const fake = indexMcpFake();
    const res = await fake.fetch(fake.url, { method: "POST", headers, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as { error?: { code: number; data?: unknown } } };
  }

  test("accepts a well-formed tools/list and tools/call", async () => {
    expect((await send(wellFormedHeaders("tools/list"), wellFormed("tools/list"))).status).toBe(200);
    const call = await send(
      wellFormedHeaders("tools/call", "list_intents"),
      wellFormed("tools/call", { name: "list_intents", arguments: {} }),
    );
    expect(call.status).toBe(200);
  });

  test("refuses initialize for every version, this one included, with -32022", async () => {
    for (const protocolVersion of ["2024-11-05", "2025-06-18", PROTOCOL]) {
      const res = await send(
        wellFormedHeaders("initialize"),
        wellFormed("initialize", { protocolVersion, capabilities: {}, clientInfo: { name: "x", version: "1" } }),
      );
      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe(-32022);
      expect(res.body.error?.data).toEqual({ supported: [PROTOCOL] });
    }
  });

  test("refuses a missing or different protocol-version header with -32022", async () => {
    const headers = wellFormedHeaders("tools/list");
    delete headers["mcp-protocol-version"];
    expect((await send(headers, wellFormed("tools/list"))).body.error?.code).toBe(-32022);
    expect(
      (await send({ ...wellFormedHeaders("tools/list"), "mcp-protocol-version": "2025-06-18" }, wellFormed("tools/list"))).body.error?.code,
    ).toBe(-32022);
  });

  test("refuses a missing or different Mcp-Method, or Mcp-Name on tools/call, with -32020", async () => {
    const callBody = wellFormed("tools/call", { name: "list_intents", arguments: {} });
    const noMethod = wellFormedHeaders("tools/call", "list_intents");
    delete noMethod["mcp-method"];
    const noName = wellFormedHeaders("tools/call");
    for (const [headers, body] of [
      [noMethod, callBody],
      [wellFormedHeaders("tools/list", "list_intents"), callBody],
      [noName, callBody],
      [wellFormedHeaders("tools/call", "list_opportunities"), callBody],
    ] as const) {
      const res = await send(headers, body);
      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe(-32020);
    }
  });

  test("refuses a missing envelope key with -32602 and names it", async () => {
    for (const key of Object.keys(FIXTURE.request.envelopeRequired)) {
      const body = wellFormed("tools/list");
      delete (body.params._meta as Record<string, unknown>)[key];
      const res = await send(wellFormedHeaders("tools/list"), body);
      expect(res.status).toBe(400);
      expect(res.body.error?.code).toBe(-32602);
      expect(res.body.error?.data).toEqual({ envelope: { missing: [key] } });
    }
  });

  test("never reaches past its own URL", async () => {
    const fake = indexMcpFake();
    await expect(fake.fetch("https://protocol.index.network/mcp", { method: "POST" })).rejects.toThrow("refusing");
  });
});

describe("indexMcpRequest / callIndexTool against the fake", () => {
  test("tools/list sends no handshake and returns the 14 tools", async () => {
    const fake = indexMcpFake();
    const result = await indexMcpRequest({ apiKey: FAKE_API_KEY, mcpUrl: fake.url, fetch: fake.fetch }, "tools/list");
    expect((result.tools as Array<{ name: string }>).map((tool) => tool.name)).toEqual(INDEX_TOOLS);
    expect(fake.calls.map((call) => [call.method, call.status])).toEqual([["tools/list", 200]]);
  });

  test("a tool call carries every header and envelope key, and header and body agree", async () => {
    const fake = indexMcpFake();
    const text = await callIndexTool(
      { apiKey: FAKE_API_KEY, mcpUrl: fake.url, fetch: fake.fetch },
      "list_opportunities",
      { statuses: ["pending"], limit: 20 },
    );
    expect(text).toBe(FIXTURE.responses.listOpportunities.result.content[0].text);
    expect(fake.calls).toHaveLength(1);
    const [call] = fake.calls;
    expect(call.status).toBe(200);
    expect(call.headers).toMatchObject({
      ...FIXTURE.request.headers,
      "x-api-key": FAKE_API_KEY,
      "x-index-surface": "telegram",
      "mcp-method": "tools/call",
      "mcp-name": "list_opportunities",
    });
    expect(call.body).toMatchObject({ jsonrpc: "2.0", method: "tools/call" });
    expect(call.arguments).toEqual({ statuses: ["pending"], limit: 20 });
    const meta = (call.body?.params as { _meta: Record<string, unknown> })._meta;
    expect(meta).toMatchObject(FIXTURE.request.envelopeRequired);
    expect(meta["io.modelcontextprotocol/clientInfo"]).toEqual({ name: "agentvillage-index-scripts", version: "1.0.0" });
  });

  test("every request has a 20 s timeout signal and refuses redirects", async () => {
    let init: RequestInit | undefined;
    const fake = indexMcpFake();
    const spy = (async (input: RequestInfo | URL, given?: RequestInit) => {
      init = given;
      return fake.fetch(input, given);
    }) as typeof fetch;
    await callIndexTool({ apiKey: FAKE_API_KEY, mcpUrl: fake.url, fetch: spy }, "list_intents");
    expect(INDEX_MCP_TIMEOUT_MS).toBe(20_000);
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.signal?.aborted).toBe(false);
  });

  test("tools/list carries no Mcp-Name", async () => {
    const fake = indexMcpFake();
    await indexMcpRequest({ apiKey: FAKE_API_KEY, mcpUrl: fake.url, fetch: fake.fetch }, "tools/list");
    expect(fake.calls[0].headers["mcp-name"]).toBeUndefined();
  });

  test("uses the global fetch when none is injected", async () => {
    const fake = indexMcpFake();
    const restore = fake.install();
    try {
      expect(await callIndexTool({ apiKey: FAKE_API_KEY, mcpUrl: fake.url }, "list_intents")).toContain("Your signals:");
    } finally {
      restore();
    }
    expect(fake.calls).toHaveLength(1);
  });

  test("reads a text/event-stream answer carrying one JSON-RPC message", async () => {
    const fake = indexMcpFake({
      tools: {
        list_intents: (_args, { id }) => ({
          response: eventStream(
            { jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } },
            { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "from the stream" }], resultType: "complete" } },
          ),
        }),
      },
    });
    expect(await callIndexTool({ apiKey: FAKE_API_KEY, mcpUrl: fake.url, fetch: fake.fetch }, "list_intents")).toBe("from the stream");
  });

  test("a stream whose only answer has another id is not this request's answer", async () => {
    const fake = indexMcpFake({
      tools: { list_intents: () => ({ response: eventStream({ jsonrpc: "2.0", id: -1, result: { content: [], resultType: "complete" } }) }) },
    });
    expect((await failure(callIndexTool({ apiKey: FAKE_API_KEY, mcpUrl: fake.url, fetch: fake.fetch }, "list_intents"))).code).toBe(
      "mcp-bad-response",
    );
  });

  test("reads data: lines without a space after the colon", async () => {
    const fake = indexMcpFake({
      tools: {
        list_intents: (_args, { id }) => {
          const message = { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "tight" }], resultType: "complete" } };
          return { response: new Response(`data:${JSON.stringify(message)}\n`, { headers: { "content-type": "text/event-stream" } }) };
        },
      },
    });
    expect(await callIndexTool({ apiKey: FAKE_API_KEY, mcpUrl: fake.url, fetch: fake.fetch }, "list_intents")).toBe("tight");
  });

  test("an SSE event whose JSON spans several data: lines is one message", async () => {
    const fake = indexMcpFake({
      tools: {
        list_intents: (_args, { id }) => {
          const pretty = JSON.stringify(
            { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "multi-line" }], resultType: "complete" } },
            null,
            2,
          );
          const event = pretty.split("\n").map((line) => `data: ${line}`).join("\n");
          const note = `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } })}`;
          return { response: new Response(`${note}\n\nevent: message\n${event}\n\n`, { headers: { "content-type": "text/event-stream" } }) };
        },
      },
    });
    expect(await callIndexTool({ apiKey: FAKE_API_KEY, mcpUrl: fake.url, fetch: fake.fetch }, "list_intents")).toBe("multi-line");
  });

  test("a result without a text item is mcp-bad-response, never an empty text", async () => {
    for (const result of [
      { content: [], resultType: "complete" },
      { resultType: "complete" },
      { content: "text", resultType: "complete" },
      { content: { type: "text", text: "not in an array" }, resultType: "complete" },
      // Has a text field but is not a text item.
      { content: [{ type: "resource", text: "looks like text" }], resultType: "complete" },
      { content: [{ text: "no type" }], resultType: "complete" },
      { content: [{ type: "text", text: 42 }], resultType: "complete" },
    ]) {
      const fake = indexMcpFake({ tools: { list_intents: () => ({ result }) } });
      const err = await failure(callIndexTool({ apiKey: FAKE_API_KEY, mcpUrl: fake.url, fetch: fake.fetch }, "list_intents"));
      expect(err.code).toBe("mcp-bad-response");
    }
  });

  test("the first text item wins over a non-text item before it", async () => {
    const fake = indexMcpFake({
      tools: { list_intents: () => ({ result: { content: [{ type: "image", data: "x", text: "no" }, { type: "text", text: "yes" }], resultType: "complete" } }) },
    });
    expect(await callIndexTool({ apiKey: FAKE_API_KEY, mcpUrl: fake.url, fetch: fake.fetch }, "list_intents")).toBe("yes");
  });

  test("a result without resultType is accepted", async () => {
    const fake = indexMcpFake({ tools: { list_intents: () => ({ result: { content: [{ type: "text", text: "ok" }] } }) } });
    expect(await callIndexTool({ apiKey: FAKE_API_KEY, mcpUrl: fake.url, fetch: fake.fetch }, "list_intents")).toBe("ok");
  });
});

describe("failures are short codes", () => {
  const SECRET = "resident-said-something-private";
  const target = (f: typeof fetch) => ({ apiKey: FAKE_API_KEY, mcpUrl: "https://index-mcp.fake.test/mcp", fetch: f });

  async function codeFor(f: typeof fetch): Promise<string> {
    const err = await failure(callIndexTool(target(f), "list_intents"));
    expect(err.message).toBe(err.code);
    expect(err.code).toMatch(CODE);
    expect(err.message).not.toContain(FAKE_API_KEY);
    expect(err.message).not.toContain(SECRET);
    return err.code;
  }

  test("a request that outlives the timeout is mcp-unreachable", async () => {
    const fake = indexMcpFake({ tools: { list_intents: () => ({ hang: true }) } });
    const err = await failure(callIndexTool({ apiKey: FAKE_API_KEY, mcpUrl: fake.url, fetch: fake.fetch, timeoutMs: 20 }, "list_intents"));
    expect(err.code).toBe("mcp-unreachable");
  }, 2_000);

  test("a redirect is mcp-unreachable and is never followed", async () => {
    for (const status of [301, 302, 307, 308]) {
      const fake = indexMcpFake({
        tools: {
          list_opportunities: () => ({
            response: new Response(null, { status, headers: { location: "https://elsewhere.fake.test/mcp" } }),
          }),
        },
      });
      const err = await failure(callIndexTool({ apiKey: FAKE_API_KEY, mcpUrl: fake.url, fetch: fake.fetch }, "list_opportunities"));
      expect(err.code).toBe("mcp-unreachable");
      expect(fake.calls[0].followedRedirect).toBeUndefined();
    }
  });

  test("a transport failure is mcp-unreachable", async () => {
    expect(await codeFor((async () => { throw new Error(`connect failed ${SECRET}`); }) as typeof fetch)).toBe("mcp-unreachable");
  });

  test("a non-200 status is mcp-http-<status>, with the JSON-RPC code when the body has one", async () => {
    expect(await codeFor((async () => new Response(SECRET, { status: 503 })) as typeof fetch)).toBe("mcp-http-503");
    expect(await codeFor((async () => Response.json(FIXTURE.refusals.initialize.body, { status: 400 })) as typeof fetch)).toBe(
      "mcp-http-400:-32022",
    );
    expect(await codeFor((async () => new Response(null, { status: 202 })) as typeof fetch)).toBe("mcp-http-202");
  });

  test("the old protocol's handshake refusal surfaces as a code, end to end", async () => {
    const fake = indexMcpFake();
    const res = await fake.fetch(fake.url, {
      method: "POST",
      headers: wellFormedHeaders("initialize"),
      body: JSON.stringify(wellFormed("initialize")),
    });
    expect(res.status).toBe(400);
    expect(await codeFor((async () => Response.json(await res.clone().json(), { status: 400 })) as typeof fetch)).toBe("mcp-http-400:-32022");
  });

  test("a JSON-RPC error on a 200 is mcp-rpc-error:<code>", async () => {
    expect(
      await codeFor((async () => Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: SECRET } })) as typeof fetch),
    ).toBe("mcp-rpc-error:-32601");
    expect(await codeFor((async () => Response.json({ jsonrpc: "2.0", id: 1, error: { message: SECRET } })) as typeof fetch)).toBe(
      "mcp-rpc-error",
    );
  });

  test("result.isError is mcp-tool-error, never an empty list", async () => {
    const fake = indexMcpFake({
      tools: { list_intents: () => ({ result: { content: [{ type: "text", text: SECRET }], isError: true, resultType: "complete" } }) },
    });
    expect(await codeFor(fake.fetch)).toBe("mcp-tool-error");
  });

  test("a resultType other than complete is mcp-result-type", async () => {
    const fake = indexMcpFake({
      tools: { list_intents: () => ({ result: { content: [{ type: "text", text: SECRET }], resultType: "incomplete" } }) },
    });
    expect(await codeFor(fake.fetch)).toBe("mcp-result-type");
  });

  test("a body that is not one JSON-RPC answer is mcp-bad-response", async () => {
    expect(await codeFor((async () => new Response(`not json ${SECRET}`, { status: 200 })) as typeof fetch)).toBe("mcp-bad-response");
    expect(await codeFor((async () => Response.json([1, 2])) as typeof fetch)).toBe("mcp-bad-response");
    expect(await codeFor((async () => Response.json({ jsonrpc: "2.0", id: 1, result: "text" })) as typeof fetch)).toBe("mcp-bad-response");
    expect(
      await codeFor((async () => new Response(": keepalive\n\n", { headers: { "content-type": "text/event-stream" } })) as typeof fetch),
    ).toBe("mcp-bad-response");
    // A well-formed answer to some other request.
    expect(
      await codeFor((async () => Response.json({ jsonrpc: "2.0", id: -1, result: { content: [], resultType: "complete" } })) as typeof fetch),
    ).toBe("mcp-bad-response");
  });
});

describe("indexMcpUrl", () => {
  test("defaults to production when INDEX_MCP_URL is unset or blank", () => {
    delete process.env.INDEX_MCP_URL;
    expect(indexMcpUrl()).toBe(DEFAULT_INDEX_MCP_URL);
    process.env.INDEX_MCP_URL = "  ";
    expect(indexMcpUrl()).toBe(DEFAULT_INDEX_MCP_URL);
    process.env.INDEX_MCP_URL = " https://index-mcp.fake.test/mcp ";
    expect(indexMcpUrl()).toBe("https://index-mcp.fake.test/mcp");
  });
});

describe("toolJsonObject / toolJsonArray", () => {
  const OBJECT = JSON.stringify({ success: true, opportunities: [{ id: "a" }] }, null, 2);

  test("finds the object after a markdown lead, past a lead line that starts with {", () => {
    const text = `Waiting on you:\n{not json} a lead line\n  {also not json\n- [A](https://index.network/o/a) — x\n\n${OBJECT}`;
    expect(toolJsonObject(text)).toEqual({ success: true, opportunities: [{ id: "a" }] });
    expect(toolJsonArray(text, "opportunities")).toEqual([{ id: "a" }]);
  });

  test("the fixture's empty list is [], not a failure", () => {
    expect(toolJsonArray(FIXTURE.responses.listOpportunitiesEmpty.result.content[0].text, "opportunities")).toEqual([]);
  });

  test("success:false is mcp-tool-error", () => {
    const code = (() => {
      try {
        toolJsonArray(`Could not list:\n\n${JSON.stringify({ success: false, error: "x", opportunities: [] })}`, "opportunities");
      } catch (err) {
        return (err as IndexMcpError).code;
      }
    })();
    expect(code).toBe("mcp-tool-error");
  });

  test("no object, text after the object, or no array under the key is mcp-unparsed", () => {
    for (const text of [
      "",
      FIXTURE.responses.toolError.result.content[0].text,
      `Waiting on you:\n\n${OBJECT}\n\nUse get_opportunity for more.`,
      `Waiting on you: ${OBJECT}`,
      `Waiting:\n\n${JSON.stringify({ success: true })}`,
      `Waiting:\n\n${JSON.stringify({ success: true, opportunities: { id: "a" } })}`,
      `Waiting:\n\n${JSON.stringify({ success: true, opportunities: null })}`,
      `Waiting:\n\n[${OBJECT}]`,
    ]) {
      let code: string | undefined;
      try {
        toolJsonArray(text, "opportunities");
      } catch (err) {
        code = (err as IndexMcpError).code;
      }
      expect(code).toBe("mcp-unparsed");
    }
  });

  test("the fixture's tool error reaches the caller as mcp-tool-error through the fake", async () => {
    const fake = indexMcpFake({ tools: { list_opportunities: () => ({ result: FIXTURE.responses.toolError.result }) } });
    const err = await failure(callIndexTool({ apiKey: FAKE_API_KEY, mcpUrl: fake.url, fetch: fake.fetch }, "list_opportunities"));
    expect(err.code).toBe("mcp-tool-error");
  });
});
