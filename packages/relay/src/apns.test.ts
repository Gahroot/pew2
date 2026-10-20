import { describe, expect, test } from "bun:test";
import {
  base64url,
  handleVoip,
  JWT_TTL_MS,
  JwtCache,
  MAX_PAYLOAD_BYTES,
  RATE_LIMIT,
  RATE_WINDOW_MS,
  RateLimiter,
  signJwt,
  validateVoip,
  type FetchLike,
  type VoipDeps,
} from "./apns.js";

const TOKEN = "ab".repeat(32);

async function keyPair(): Promise<{ pem: string; publicKey: CryptoKey }> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  const b64 = btoa(String.fromCharCode(...der));
  const lines = b64.match(/.{1,64}/g) ?? [];
  const pem = `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----\n`;
  return { pem, publicKey: pair.publicKey };
}

function fromB64url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function decodePart(s: string): unknown {
  return JSON.parse(new TextDecoder().decode(fromB64url(s)));
}

describe("base64url", () => {
  test("no padding, url alphabet", () => {
    expect(base64url(new Uint8Array([0xfb, 0xff]))).toBe("-_8");
    expect(base64url("a")).toBe("YQ");
  });
});

describe("signJwt", () => {
  test("header, claims and a verifiable ES256 signature", async () => {
    const { pem, publicKey } = await keyPair();
    const jwt = await signJwt({ key: pem, keyId: "KID", teamId: "TEAM" }, 1_700_000_000_500);
    const [h, c, s] = jwt.split(".") as [string, string, string];
    expect(decodePart(h)).toEqual({ alg: "ES256", kid: "KID" });
    expect(decodePart(c)).toEqual({ iss: "TEAM", iat: 1_700_000_000 });
    const sig = fromB64url(s);
    expect(sig.length).toBe(64);
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      sig,
      new TextEncoder().encode(`${h}.${c}`),
    );
    expect(ok).toBe(true);
  });

  test("cache reuses for 45 minutes, then refreshes", async () => {
    const { pem } = await keyPair();
    const cfg = { key: pem, keyId: "KID", teamId: "TEAM" };
    const cache = new JwtCache();
    const t0 = 1_700_000_000_000;
    const a = await cache.get(cfg, t0);
    expect(await cache.get(cfg, t0 + JWT_TTL_MS - 1)).toBe(a);
    const b = await cache.get(cfg, t0 + JWT_TTL_MS);
    expect(b).not.toBe(a);
    expect((decodePart(b.split(".")[1] ?? "") as { iat: number }).iat).toBe(
      Math.floor((t0 + JWT_TTL_MS) / 1000),
    );
  });
});

describe("validateVoip", () => {
  test("token regex, lowercased", () => {
    const r = validateVoip({ token: TOKEN.toUpperCase(), env: "sandbox", payload: {} });
    expect(r.ok && r.value.token).toBe(TOKEN);
    expect(validateVoip({ token: "ab".repeat(31), env: "sandbox", payload: {} }).ok).toBe(false);
    expect(validateVoip({ token: "a".repeat(201), env: "sandbox", payload: {} }).ok).toBe(false);
    expect(validateVoip({ token: `${TOKEN}zz`, env: "sandbox", payload: {} }).ok).toBe(false);
  });
  test("env and payload shape", () => {
    expect(validateVoip({ token: TOKEN, env: "dev", payload: {} }).ok).toBe(false);
    expect(validateVoip({ token: TOKEN, env: "production", payload: [] }).ok).toBe(false);
    expect(validateVoip({ token: TOKEN, env: "production", payload: "x" }).ok).toBe(false);
    expect(validateVoip([]).ok).toBe(false);
  });
  test("payload size", () => {
    const fits = { p: "x".repeat(MAX_PAYLOAD_BYTES - 8) }; // {"p":"…"} adds 8
    expect(validateVoip({ token: TOKEN, env: "sandbox", payload: fits }).ok).toBe(true);
    const over = { p: "x".repeat(MAX_PAYLOAD_BYTES - 7) };
    expect(validateVoip({ token: TOKEN, env: "sandbox", payload: over }).ok).toBe(false);
  });
});

describe("RateLimiter", () => {
  test("6 per token per 10 minutes", () => {
    const rl = new RateLimiter();
    for (let i = 0; i < RATE_LIMIT; i++) expect(rl.allow(TOKEN, 1000 + i)).toBe(true);
    expect(rl.allow(TOKEN, 2000)).toBe(false);
    expect(rl.allow("cd".repeat(32), 2000)).toBe(true);
    expect(rl.allow(TOKEN, 1000 + RATE_WINDOW_MS)).toBe(true);
  });
});

describe("handleVoip", () => {
  async function deps(fake: FetchLike, key?: string): Promise<VoipDeps> {
    return {
      config: {
        key: key ?? (await keyPair()).pem,
        keyId: "KID",
        teamId: "TEAM",
        bundleId: "io.example.app",
      },
      fetch: fake,
      now: () => 1_700_000_000_000,
      jwt: new JwtCache(),
      limiter: new RateLimiter(),
    };
  }
  const post = (body: unknown) =>
    new Request("https://relay/voip", { method: "POST", body: JSON.stringify(body) });
  const apns = (status: number, body?: unknown, headers?: Record<string, string>) =>
    (async () =>
      new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers,
      })) as unknown as FetchLike;

  test("forwards the right request and maps 200", async () => {
    let seen: { url: string; init?: RequestInit } | null = null;
    const fake = (async (url: string, init?: RequestInit) => {
      seen = { url, init };
      return new Response(null, { status: 200, headers: { "apns-id": "ID-1" } });
    }) as unknown as FetchLike;
    const res = await handleVoip(
      post({ token: TOKEN, env: "sandbox", payload: { a: 1 } }),
      await deps(fake),
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toEqual({ ok: true, apnsId: "ID-1" });
    const s = seen as unknown as { url: string; init: RequestInit };
    expect(s.url).toBe(`https://api.sandbox.push.apple.com/3/device/${TOKEN}`);
    const h = s.init.headers as Record<string, string>;
    expect(h["apns-topic"]).toBe("io.example.app.voip");
    expect(h["apns-push-type"]).toBe("voip");
    expect(h["apns-priority"]).toBe("10");
    expect(h["apns-expiration"]).toBe("1700000030");
    expect(h.authorization?.startsWith("bearer ")).toBe(true);
    expect(s.init.body).toBe('{"a":1}');
  });

  test("410 Unregistered passes through as 410", async () => {
    const res = await handleVoip(
      post({ token: TOKEN, env: "production", payload: {} }),
      await deps(apns(410, { reason: "Unregistered" })),
    );
    expect(res.status).toBe(410);
    expect((await res.json()) as unknown).toEqual({ ok: false, status: 410, reason: "Unregistered" });
  });

  test("APNs 400 becomes 502 with its reason", async () => {
    const res = await handleVoip(
      post({ token: TOKEN, env: "production", payload: {} }),
      await deps(apns(400, { reason: "BadDeviceToken" })),
    );
    expect(res.status).toBe(502);
    expect((await res.json()) as unknown).toEqual({ ok: false, status: 400, reason: "BadDeviceToken" });
  });

  test("bad input is 400 and never reaches APNs", async () => {
    let called = false;
    const fake = (async () => {
      called = true;
      return new Response(null);
    }) as unknown as FetchLike;
    const d = await deps(fake);
    for (const req of [
      post({ token: "nope", env: "sandbox", payload: {} }),
      new Request("https://relay/voip", { method: "POST", body: "{" }),
      new Request("https://relay/voip", { method: "POST", body: "x".repeat(9000) }),
    ]) {
      const res = await handleVoip(req, d);
      expect(res.status).toBe(400);
      expect((await res.json()) as unknown).toEqual({ ok: false, status: 400, reason: "bad_request" });
    }
    expect(called).toBe(false);
  });

  test("405, 503 and 429", async () => {
    const d = await deps(apns(200));
    expect((await handleVoip(new Request("https://relay/voip"), d)).status).toBe(405);
    const unconfigured = { ...d, config: { ...d.config, key: undefined } };
    const r503 = await handleVoip(post({ token: TOKEN, env: "sandbox", payload: {} }), unconfigured);
    expect(r503.status).toBe(503);
    expect((await r503.json()) as unknown).toEqual({ ok: false, status: 503, reason: "not_configured" });
    for (let i = 0; i < RATE_LIMIT; i++) {
      expect((await handleVoip(post({ token: TOKEN, env: "sandbox", payload: {} }), d)).status).toBe(200);
    }
    const r429 = await handleVoip(post({ token: TOKEN, env: "sandbox", payload: {} }), d);
    expect(r429.status).toBe(429);
    expect((await r429.json()) as unknown).toEqual({ ok: false, status: 429, reason: "rate_limited" });
  });
});
