import { expect, test } from "bun:test";
import { MINT_URL, mintRealtimeSecret } from "./mint.js";

const fakeFetch = (response: Response, seen: { url?: string; init?: RequestInit } = {}) =>
  (async (url: string | URL | Request, init?: RequestInit) => {
    seen.url = typeof url === "string" ? url : "other";
    seen.init = init;
    return response;
  }) as unknown as typeof fetch;

test("a missing connected account never fetches", async () => {
  let called = false;
  const result = await mintRealtimeSecret({
    accessToken: undefined,
    session: {},
    fetch: (async () => {
      called = true;
      return new Response("{}");
    }) as unknown as typeof fetch,
  });
  expect(result).toMatchObject({ ok: false, code: "account-required" });
  expect(called).toBe(false);
});

test("mints with the key in the header only", async () => {
  const seen: { url?: string; init?: RequestInit } = {};
  const result = await mintRealtimeSecret({
    accessToken: "sk-testtesttesttesttest",
    session: { instructions: "hi" },
    fetch: fakeFetch(new Response(JSON.stringify({ value: "ek_abc", expires_at: 1234 })), seen),
  });
  expect(result).toEqual({
    ok: true,
    secret: "ek_abc",
    expiresAt: 1234,
    model: "gpt-realtime-2.1",
  });
  expect(seen.url).toBe(MINT_URL);
  const body = JSON.parse(seen.init?.body as string);
  expect(body.session).toMatchObject({
    type: "realtime",
    model: "gpt-realtime-2.1",
    instructions: "hi",
  });
  expect(seen.init?.body as string).not.toContain("sk-test");
});

test("failures never echo the key", async () => {
  const key = "sk-secretsecretsecret123";
  const http = await mintRealtimeSecret({
    accessToken: key,
    session: {},
    fetch: fakeFetch(new Response(`bad key ${key}`, { status: 401 })),
  });
  expect(http.ok).toBe(false);
  expect(JSON.stringify(http)).not.toContain(key);
  const thrown = await mintRealtimeSecret({
    accessToken: key,
    session: {},
    fetch: (async () => {
      throw new Error(`boom ${key}`);
    }) as unknown as typeof fetch,
  });
  expect(thrown).toMatchObject({ ok: false, code: "mint_failed" });
  expect(JSON.stringify(thrown)).not.toContain(key);
  const empty = await mintRealtimeSecret({
    accessToken: key,
    session: {},
    fetch: fakeFetch(new Response("{}")),
  });
  expect(empty).toMatchObject({ ok: false, code: "mint_failed" });
});

test("provider failures are mapped without echoing remote bodies", async () => {
  for (const [status, code] of [
    [401, "reconnect-required"],
    [403, "not-entitled"],
    [429, "rate-limited"],
    [500, "mint_failed"],
  ] as const) {
    const result = await mintRealtimeSecret({
      accessToken: "private-token",
      session: {},
      fetch: fakeFetch(new Response("private-provider-data", { status })),
    });
    expect(result).toMatchObject({ ok: false, code });
    expect(JSON.stringify(result)).not.toContain("private");
  }
});

test("mint rejects missing expiry and oversized responses and cancels a stalled body", async () => {
  for (const body of [JSON.stringify({ value: "ek_only" }), "x".repeat(64001)]) {
    expect(
      await mintRealtimeSecret({
        accessToken: "token",
        session: {},
        fetch: fakeFetch(new Response(body)),
      }),
    ).toMatchObject({ ok: false, code: "mint_failed" });
  }
  const controller = new AbortController();
  const response = new Response(new ReadableStream({ start() {} }));
  const result = mintRealtimeSecret({
    accessToken: "token",
    session: {},
    signal: controller.signal,
    fetch: fakeFetch(response),
  });
  await Promise.resolve();
  controller.abort();
  expect(await result).toMatchObject({ ok: false, code: "mint_failed" });
});
