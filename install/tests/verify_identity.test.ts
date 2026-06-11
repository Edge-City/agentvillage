import { describe, expect, test } from "bun:test";

import {
  IdentityVerificationError,
  normalizeTelegramHandle,
  verifyIndexIdentity,
} from "../install_index";

// ---------------------------------------------------------------------------
// normalizeTelegramHandle
// ---------------------------------------------------------------------------

describe("normalizeTelegramHandle", () => {
  test("strips leading @", () => {
    expect(normalizeTelegramHandle("@alice")).toBe("alice");
  });

  test("strips https://t.me/ prefix", () => {
    expect(normalizeTelegramHandle("https://t.me/alice")).toBe("alice");
  });

  test("strips http://t.me/ prefix", () => {
    expect(normalizeTelegramHandle("http://t.me/bob")).toBe("bob");
  });

  test("strips telegram.me prefix", () => {
    expect(normalizeTelegramHandle("https://telegram.me/carol")).toBe("carol");
  });

  test("lowercases the handle", () => {
    expect(normalizeTelegramHandle("@AlIcE")).toBe("alice");
  });

  test("strips trailing path/query/hash", () => {
    expect(normalizeTelegramHandle("https://t.me/alice/extra?q=1#foo")).toBe("alice");
  });

  test("trims whitespace", () => {
    expect(normalizeTelegramHandle("  @alice  ")).toBe("alice");
  });

  test("returns empty string for empty input", () => {
    expect(normalizeTelegramHandle("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// verifyIndexIdentity — five branches
// ---------------------------------------------------------------------------

describe("verifyIndexIdentity", () => {
  const ME_USER = {
    id: "u1",
    name: "Alice",
    email: "alice@example.com",
    socials: [{ label: "telegram", value: "@alice" }],
  };

  function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
      handler(String(input), init)) as typeof fetch;
    return () => { globalThis.fetch = original; };
  }

  // Branch 1: HTTP 401/403 → IdentityVerificationError kind='rejected'
  test("throws rejected error on HTTP 401", async () => {
    const restore = mockFetch(() => new Response("Unauthorized", { status: 401 }));
    try {
      await expect(verifyIndexIdentity("bad-key", "alice")).rejects.toThrow(IdentityVerificationError);
      await expect(verifyIndexIdentity("bad-key", "alice")).rejects.toMatchObject({ kind: "rejected" });
    } finally {
      restore();
    }
  });

  test("throws rejected error on HTTP 403", async () => {
    const restore = mockFetch(() => new Response("Forbidden", { status: 403 }));
    try {
      await expect(verifyIndexIdentity("bad-key", "alice")).rejects.toThrow(IdentityVerificationError);
      await expect(verifyIndexIdentity("bad-key", "alice")).rejects.toMatchObject({ kind: "rejected" });
    } finally {
      restore();
    }
  });

  // Branch 2: HTTP 5xx → warn-continue (no throw)
  test("resolves on HTTP 503 (warn-continue)", async () => {
    const restore = mockFetch(() => new Response("Service Unavailable", { status: 503 }));
    try {
      await expect(verifyIndexIdentity("key", "alice")).resolves.toBeUndefined();
    } finally {
      restore();
    }
  });

  // Branch 3: network/timeout error → warn-continue (no throw)
  test("resolves on network error (warn-continue)", async () => {
    const restore = mockFetch(() => { throw new Error("ECONNREFUSED"); });
    try {
      await expect(verifyIndexIdentity("key", "alice")).resolves.toBeUndefined();
    } finally {
      restore();
    }
  });

  test("resolves on timeout error (warn-continue)", async () => {
    const restore = mockFetch(() => { throw Object.assign(new Error("timeout"), { name: "TimeoutError" }); });
    try {
      await expect(verifyIndexIdentity("key", "alice")).resolves.toBeUndefined();
    } finally {
      restore();
    }
  });

  // Branch 4: missing telegram social on profile → warn-continue
  test("resolves when profile has no telegram social", async () => {
    const restore = mockFetch(() => Response.json({
      user: { id: "u1", name: "Alice", email: null, socials: [] },
    }));
    try {
      await expect(verifyIndexIdentity("key", "alice")).resolves.toBeUndefined();
    } finally {
      restore();
    }
  });

  // Branch 5: telegram handle mismatch → IdentityVerificationError kind='mismatch'
  test("throws mismatch error when handles differ", async () => {
    const restore = mockFetch(() => Response.json({ user: ME_USER }));
    try {
      await expect(verifyIndexIdentity("key", "bob")).rejects.toThrow(IdentityVerificationError);
      await expect(verifyIndexIdentity("key", "bob")).rejects.toMatchObject({ kind: "mismatch" });
    } finally {
      restore();
    }
  });

  // Happy path: matching handle → resolves
  test("resolves when handle matches", async () => {
    const restore = mockFetch(() => Response.json({ user: ME_USER }));
    try {
      await expect(verifyIndexIdentity("key", "alice")).resolves.toBeUndefined();
    } finally {
      restore();
    }
  });

  // Happy path: no expected handle → resolves (no comparison)
  test("resolves when no expected handle is provided", async () => {
    const restore = mockFetch(() => Response.json({ user: ME_USER }));
    try {
      await expect(verifyIndexIdentity("key", "")).resolves.toBeUndefined();
    } finally {
      restore();
    }
  });

  // Empty user response → warn-continue
  test("resolves when /me returns empty user", async () => {
    const restore = mockFetch(() => Response.json({}));
    try {
      await expect(verifyIndexIdentity("key", "alice")).resolves.toBeUndefined();
    } finally {
      restore();
    }
  });
});
