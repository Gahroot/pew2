/**
 * Where voice calls get an OpenAI token from.
 *
 * Found, not configured: a login an agent on this machine already holds is
 * used first, and pew2's own sign-in exists only for when there is none.
 *
 * The rule that matters: **never refresh a token owned by GG Coder or Codex.**
 * Their refresh tokens rotate, so a refresh by pew2 would sign the agent out.
 * An expired agent token is skipped, not repaired. Only pew2's own
 * `voice-auth.json` is ever refreshed here.
 *
 * Nothing in this module logs a token, and no error message carries one.
 */
import { mkdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { wire } from "@pew2/protocol";
import { writeFileAtomic } from "../atomic-file.js";
import { userProvidersDir } from "../providers/registry.js";

export const OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const OPENAI_TOKEN_URL = "https://auth.openai.com/oauth/token";

/** Treat a token this close to expiry as already gone: a call outlives a mint. */
const EXPIRY_SKEW_MS = 60_000;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Every path the chain reads, injectable so tests run against temp dirs. */
export interface VoicePaths {
  /** `~/.gg/auth.json` */
  ggAuth: string;
  /** `$CODEX_HOME/auth.json` */
  codexAuth: string;
  /** pew2's own login, beside `pairing.json`. */
  voiceAuth: string;
  /** Call policy settings, beside `pairing.json`. */
  voicePrefs: string;
  apiKey?: string;
}

export function voicePaths(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): VoicePaths {
  const configDir = dirname(userProvidersDir(env));
  return {
    ggAuth: join(env.GG_AGENT_DIR || join(home, ".gg"), "auth.json"),
    codexAuth: join(env.CODEX_HOME || join(home, ".codex"), "auth.json"),
    voiceAuth: join(configDir, "voice-auth.json"),
    voicePrefs: join(configDir, "voice-prefs.json"),
    ...(env.OPENAI_API_KEY ? { apiKey: env.OPENAI_API_KEY } : {}),
  };
}

export interface VoiceCredential {
  source: wire.VoiceSource;
  token: string;
  account?: string;
}

export type CredentialResult =
  | { ok: true; credential: VoiceCredential }
  | { ok: false; reason: string; canLogin: true };

/** pew2's own stored login. */
export interface StoredVoiceAuth {
  accessToken?: string;
  refreshToken?: string;
  idToken?: string;
  /** Epoch ms. */
  expiresAt?: number;
  account?: string;
  apiKey?: string;
}

/** No agent here has an OpenAI login (a Claude Code-only machine, say): one sign-in fixes it. */
export const REASON_SIGN_IN = "None of your agents on this computer has an OpenAI login. Sign in once to talk to Pew.";
export const REASON_EXPIRED =
  "Your OpenAI login on this computer expired. Open GG Coder or Codex once, or sign in here.";

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** The JWT payload, unverified: only read for `exp` and an email label. */
export function jwtClaims(token: string | undefined): Record<string, unknown> | undefined {
  const part = token?.split(".")[1];
  if (!part) return undefined;
  try {
    const json = Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const claims = JSON.parse(json) as unknown;
    return claims && typeof claims === "object" ? (claims as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function jwtExpiryMs(token: string): number | undefined {
  const exp = jwtClaims(token)?.exp;
  return typeof exp === "number" ? exp * 1000 : undefined;
}

function jwtEmail(token: string | undefined): string | undefined {
  const claims = jwtClaims(token);
  const email = claims?.email ?? (claims?.["https://api.openai.com/profile"] as { email?: unknown } | undefined)?.email;
  return typeof email === "string" ? email : undefined;
}

const live = (expiresAt: number | undefined, now: number) =>
  expiresAt === undefined || expiresAt - EXPIRY_SKEW_MS > now;

const str = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : undefined);

export async function readVoiceAuth(path: string): Promise<StoredVoiceAuth | undefined> {
  const raw = (await readJson(path)) as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== "object") return undefined;
  return {
    accessToken: str(raw.accessToken),
    refreshToken: str(raw.refreshToken),
    idToken: str(raw.idToken),
    expiresAt: typeof raw.expiresAt === "number" ? raw.expiresAt : undefined,
    account: str(raw.account),
    apiKey: str(raw.apiKey),
  };
}

export async function writeVoiceAuth(path: string, auth: StoredVoiceAuth): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFileAtomic(path, `${JSON.stringify(auth, null, 2)}\n`, 0o600);
}

/** Refresh pew2's OWN token. Never call this with an agent's refresh token. */
async function refreshOwn(
  path: string,
  auth: StoredVoiceAuth,
  now: number,
  fetchImpl: FetchLike,
): Promise<StoredVoiceAuth | undefined> {
  if (!auth.refreshToken) return undefined;
  try {
    const response = await fetchImpl(OPENAI_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: auth.refreshToken,
        client_id: OPENAI_CLIENT_ID,
      }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as Record<string, unknown>;
    const accessToken = str(body.access_token);
    if (!accessToken) return undefined;
    const next: StoredVoiceAuth = {
      ...auth,
      accessToken,
      refreshToken: str(body.refresh_token) ?? auth.refreshToken,
      idToken: str(body.id_token) ?? auth.idToken,
      expiresAt:
        typeof body.expires_in === "number" ? now + body.expires_in * 1000 : jwtExpiryMs(accessToken),
    };
    next.account = jwtEmail(next.idToken) ?? auth.account;
    await writeVoiceAuth(path, next);
    return next;
  } catch {
    return undefined;
  }
}

/**
 * The first usable token: GG Coder, Codex, pew2's own, then an API key.
 */
export async function resolveCredential(
  paths: VoicePaths,
  options: { now?: number; fetchImpl?: FetchLike } = {},
): Promise<CredentialResult> {
  const now = options.now ?? Date.now();
  const fetchImpl = options.fetchImpl ?? fetch;
  let sawExpired = false;

  // 1. GG Coder.
  const gg = ((await readJson(paths.ggAuth)) as { openai?: Record<string, unknown> } | undefined)?.openai;
  const ggToken = str(gg?.accessToken);
  if (ggToken) {
    const expiresAt = typeof gg?.expiresAt === "number" ? gg.expiresAt : jwtExpiryMs(ggToken);
    if (live(expiresAt, now)) return { ok: true, credential: { source: "ggcoder", token: ggToken } };
    sawExpired = true;
  }

  // 2. Codex.
  const codex = ((await readJson(paths.codexAuth)) as { tokens?: Record<string, unknown> } | undefined)?.tokens;
  const codexToken = str(codex?.access_token);
  if (codexToken) {
    if (live(jwtExpiryMs(codexToken), now)) {
      const account = jwtEmail(str(codex?.id_token));
      return { ok: true, credential: { source: "codex", token: codexToken, ...(account ? { account } : {}) } };
    }
    sawExpired = true;
  }

  // 3. pew2's own login, the only one this daemon may refresh.
  const own = await readVoiceAuth(paths.voiceAuth);
  if (own?.accessToken) {
    const current = live(own.expiresAt, now) ? own : await refreshOwn(paths.voiceAuth, own, now, fetchImpl);
    if (current?.accessToken) {
      return {
        ok: true,
        credential: {
          source: "pew2",
          token: current.accessToken,
          ...(current.account ? { account: current.account } : {}),
        },
      };
    }
    sawExpired = true;
  }

  // 4. An API key.
  const apiKey = paths.apiKey ?? own?.apiKey;
  if (apiKey) return { ok: true, credential: { source: "apikey", token: apiKey } };

  return { ok: false, reason: sawExpired ? REASON_EXPIRED : REASON_SIGN_IN, canLogin: true };
}

/** Forget pew2's own login, keeping an API key if one was stored. Agents' files are untouched. */
export async function forgetOwnLogin(path: string): Promise<void> {
  const own = await readVoiceAuth(path);
  if (!own) return;
  if (own.apiKey) {
    await writeVoiceAuth(path, { apiKey: own.apiKey });
    return;
  }
  await rm(path, { force: true });
}
