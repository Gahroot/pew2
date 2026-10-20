/**
 * VoIP push via Apple PushKit, as pure, injectable pieces.
 *
 * The Apple signing key cannot live on users' machines, so the relay holds it
 * as a secret and signs APNs requests on the daemon's behalf. The relay still
 * authenticates nobody: possession of a VoIP token — which only ever travels
 * inside sealed frames — is the credential, and the limits below bound what a
 * holder of one can do. Nothing is stored and nothing identifying is logged:
 * tokens and payloads never reach a log line, only status and reason.
 *
 * Split out of `index.ts` so it can be tested under bun without a Workers
 * runtime; the Worker supplies the clock, `fetch` and the long-lived state.
 */

export interface ApnsConfig {
  /** The .p8 file's PEM text (PKCS#8, P-256). */
  key: string;
  keyId: string;
  teamId: string;
  bundleId: string;
}

/** APNs rejects refreshing more than once per 20 min and tokens older than 60. */
export const JWT_TTL_MS = 45 * 60_000;
export const MAX_BODY_BYTES = 8 * 1024;
/** APNs' VoIP limit is 5 KB; this keeps a margin. */
export const MAX_PAYLOAD_BYTES = 3500;
export const RATE_LIMIT = 6;
export const RATE_WINDOW_MS = 10 * 60_000;
/** A ring that arrives late is worse than none. */
export const EXPIRATION_S = 30;

const TOKEN = /^[0-9a-f]{64,200}$/;

export function base64url(input: Uint8Array | string): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function pemToDer(pem: string): Uint8Array {
  const body = pem.replace(/-----(BEGIN|END)[^-]*-----/g, "").replace(/\s+/g, "");
  const binary = atob(body);
  const der = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) der[i] = binary.charCodeAt(i);
  return der;
}

export async function signJwt(
  config: Pick<ApnsConfig, "key" | "keyId" | "teamId">,
  nowMs: number,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(config.key),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const head = base64url(JSON.stringify({ alg: "ES256", kid: config.keyId }));
  const claims = base64url(
    JSON.stringify({ iss: config.teamId, iat: Math.floor(nowMs / 1000) }),
  );
  const input = `${head}.${claims}`;
  // WebCrypto's ECDSA output is raw r||s — exactly what JWS ES256 wants.
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(input),
  );
  return `${input}.${base64url(new Uint8Array(sig))}`;
}

/** Reuses one provider token for {@link JWT_TTL_MS}. */
export class JwtCache {
  private token: string | null = null;
  private issuedAt = 0;
  private cacheKey = "";

  async get(config: Pick<ApnsConfig, "key" | "keyId" | "teamId">, nowMs: number): Promise<string> {
    const id = `${config.keyId}:${config.teamId}:${config.key.length}`;
    if (this.token && this.cacheKey === id && nowMs - this.issuedAt < JWT_TTL_MS) {
      return this.token;
    }
    this.token = await signJwt(config, nowMs);
    this.issuedAt = nowMs;
    this.cacheKey = id;
    return this.token;
  }
}

/** Best effort per isolate: at most {@link RATE_LIMIT} per token per window. */
export class RateLimiter {
  private hits = new Map<string, number[]>();

  allow(token: string, nowMs: number): boolean {
    const recent = (this.hits.get(token) ?? []).filter((t) => nowMs - t < RATE_WINDOW_MS);
    if (recent.length >= RATE_LIMIT) {
      this.hits.set(token, recent);
      return false;
    }
    recent.push(nowMs);
    this.hits.set(token, recent);
    // Keep the map from growing without bound across many tokens.
    if (this.hits.size > 10_000) {
      for (const [k, v] of this.hits) {
        if (v.every((t) => nowMs - t >= RATE_WINDOW_MS)) this.hits.delete(k);
      }
    }
    return true;
  }
}

export interface VoipRequest {
  token: string;
  env: "sandbox" | "production";
  payload: Record<string, unknown>;
}

export type Validated = { ok: true; value: VoipRequest } | { ok: false };

export function validateVoip(body: unknown): Validated {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false };
  const { token, env, payload } = body as Record<string, unknown>;
  if (typeof token !== "string") return { ok: false };
  const lower = token.toLowerCase();
  if (!TOKEN.test(lower)) return { ok: false };
  if (env !== "sandbox" && env !== "production") return { ok: false };
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { ok: false };
  }
  const size = new TextEncoder().encode(JSON.stringify(payload)).length;
  if (size > MAX_PAYLOAD_BYTES) return { ok: false };
  return { ok: true, value: { token: lower, env, payload: payload as Record<string, unknown> } };
}

/** The slice of `fetch` the handler uses, so tests can pass a fake. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface VoipDeps {
  config: Partial<ApnsConfig>;
  fetch: FetchLike;
  now: () => number;
  jwt: JwtCache;
  limiter: RateLimiter;
  log?: (line: string) => void;
}

function reply(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status });
}

async function readCapped(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

export async function handleVoip(request: Request, deps: VoipDeps): Promise<Response> {
  const log = deps.log ?? (() => {});
  if (request.method !== "POST") {
    return reply(405, { ok: false, status: 405, reason: "method_not_allowed" });
  }
  const { key, keyId, teamId, bundleId } = deps.config;
  if (!key || !keyId || !teamId || !bundleId) {
    return reply(503, { ok: false, status: 503, reason: "not_configured" });
  }

  const text = await readCapped(request);
  if (text === null) return reply(400, { ok: false, status: 400, reason: "bad_request" });
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return reply(400, { ok: false, status: 400, reason: "bad_request" });
  }
  const checked = validateVoip(parsed);
  if (!checked.ok) return reply(400, { ok: false, status: 400, reason: "bad_request" });
  const { token, env, payload } = checked.value;

  const now = deps.now();
  if (!deps.limiter.allow(token, now)) {
    return reply(429, { ok: false, status: 429, reason: "rate_limited" });
  }

  let jwt: string;
  try {
    jwt = await deps.jwt.get({ key, keyId, teamId }, now);
  } catch {
    log("voip: key import/sign failed");
    return reply(503, { ok: false, status: 503, reason: "not_configured" });
  }

  const host = env === "production" ? "api.push.apple.com" : "api.sandbox.push.apple.com";
  let res: Response;
  try {
    res = await deps.fetch(`https://${host}/3/device/${token}`, {
      method: "POST",
      headers: {
        authorization: `bearer ${jwt}`,
        "apns-topic": `${bundleId}.voip`,
        "apns-push-type": "voip",
        "apns-priority": "10",
        "apns-expiration": String(Math.floor(now / 1000) + EXPIRATION_S),
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch {
    log("voip: apns unreachable");
    return reply(502, { ok: false, status: 502, reason: "apns_unreachable" });
  }

  if (res.status === 200) {
    const apnsId = res.headers.get("apns-id") ?? undefined;
    log("voip: 200");
    return reply(200, apnsId ? { ok: true, apnsId } : { ok: true });
  }
  let reason = "unknown";
  try {
    const body = (await res.json()) as { reason?: unknown };
    if (typeof body.reason === "string") reason = body.reason;
  } catch {
    // No JSON body; keep "unknown".
  }
  log(`voip: ${res.status} ${reason}`);
  // 410 means the token is dead: pass it through so the daemon drops it.
  return reply(res.status === 410 ? 410 : 502, { ok: false, status: res.status, reason });
}
