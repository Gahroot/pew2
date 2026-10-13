import { expect, test } from "bun:test";
import { MINT_URL, mintRealtimeSecret, resolveApiKey } from "./mint.js";

const fakeFetch = (response: Response, seen: { url?: string; init?: RequestInit } = {}) =>
  (async (url: string | URL | Request, init?: RequestInit) => {
    seen.url = typeof url === "string" ? url : "other";
    seen.init = init;
    return response;
  }) as unknown as typeof fetch;

test("a missing key is no_api_key and nothing is fetched", async () => {
  let called = false;
  const result = await mintRealtimeSecret({
    apiKey: undefined,
    session: {},
    fetch: (async () => {
      called = true;
      return new Response("{}");
    }) as unknown as typeof fetch,
  });
  expect(result).toMatchObject({ ok: false, code: "no_api_key" });
  expect(called).toBe(false);
});

test("mints with the key in the header only", async () => {
  const seen: { url?: string; init?: RequestInit } = {};
  const result = await mintRealtimeSecret({
    apiKey: "sk-testtesttesttesttest",
    session: { instructions: "hi" },
    fetch: fakeFetch(new Response(JSON.stringify({ value: "ek_abc", expires_at: 1234 })), seen),
  });
  expect(result).toEqual({ ok: true, secret: "ek_abc", expiresAt: 1234, model: "gpt-realtime-2.1" });
  expect(seen.url).toBe(MINT_URL);
  const body = JSON.parse((seen.init?.body as string));
  expect(body.session).toMatchObject({ type: "realtime", model: "gpt-realtime-2.1", instructions: "hi" });
  expect((seen.init?.body as string)).not.toContain("sk-test");
});

test("failures never echo the key", async () => {
  const key = "sk-secretsecretsecret123";
  const http = await mintRealtimeSecret({
    apiKey: key,
    session: {},
    fetch: fakeFetch(new Response(`bad key ${key}`, { status: 401 })),
  });
  expect(http.ok).toBe(false);
  expect(JSON.stringify(http)).not.toContain(key);
  const thrown = await mintRealtimeSecret({
    apiKey: key,
    session: {},
    fetch: (async () => {
      throw new Error(`boom ${key}`);
    }) as unknown as typeof fetch,
  });
  expect(thrown).toMatchObject({ ok: false, code: "mint_failed" });
  expect(JSON.stringify(thrown)).not.toContain(key);
  const empty = await mintRealtimeSecret({ apiKey: key, session: {}, fetch: fakeFetch(new Response("{}")) });
  expect(empty).toMatchObject({ ok: false, code: "mint_failed" });
});

test("environment beats the prefs file", () => {
  expect(resolveApiKey({ OPENAI_API_KEY: "a" }, { openaiApiKey: "b" })).toBe("a");
  expect(resolveApiKey({}, { openaiApiKey: "b" })).toBe("b");
  expect(resolveApiKey({ OPENAI_API_KEY: " " }, {})).toBeUndefined();
});
