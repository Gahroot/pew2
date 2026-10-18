/**
 * Mint the short-lived secret the phone uses to talk to OpenAI Realtime.
 *
 * The connected account token stays in this process. Only an ephemeral secret
 * reaches the phone. Provider failures are mapped, never echoed.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { boundedJson } from "./accountHttp.js";

export const MINT_URL = "https://api.openai.com/v1/realtime/client_secrets";
export const DEFAULT_MODEL = "gpt-realtime-2.1";
export const DEFAULT_VOICE = "marin";

export interface VoicePrefs {
  openaiApiKey?: string;
  model?: string;
  voice?: string;
  /** Set false to turn voice off on this machine. */
  enabled?: boolean;
}

export async function readVoicePrefs(dataDir: string): Promise<VoicePrefs> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(dataDir, "voice-prefs.json"), "utf8"));
    if (!parsed || typeof parsed !== "object") return {};
    const p = parsed as Record<string, unknown>;
    return {
      ...(typeof p.openaiApiKey === "string" ? { openaiApiKey: p.openaiApiKey } : null),
      ...(typeof p.model === "string" ? { model: p.model } : null),
      ...(typeof p.voice === "string" ? { voice: p.voice } : null),
      ...(typeof p.enabled === "boolean" ? { enabled: p.enabled } : null),
    };
  } catch {
    return {};
  }
}

export const MINT_MESSAGES = {
  "account-required":
    "Open Connection → Voice account and connect ChatGPT on this computer. Existing API keys are not used for voice.",
  "reconnect-required": "Reconnect ChatGPT in Connection → Voice account.",
  "not-entitled": "Voice is not available on this ChatGPT account.",
  "rate-limited": "OpenAI is limiting voice sessions. Try again later.",
  mint_failed: "Could not start voice with OpenAI. Try again.",
} as const;
export type MintCode = keyof typeof MINT_MESSAGES;
export type MintResult =
  | { ok: true; secret: string; expiresAt: number; model: string }
  | { ok: false; code: MintCode; message: string };
const failure = (code: MintCode): MintResult => ({ ok: false, code, message: MINT_MESSAGES[code] });
const Secret = z.object({
  value: z.string().min(1).max(24000),
  expires_at: z.number().int().positive(),
});

export interface MintOptions {
  accessToken: string | undefined;
  model?: string;
  /** The session config (instructions, tools, audio...) to bake into the secret. */
  session: Record<string, unknown>;
  ttlSeconds?: number;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

export async function mintRealtimeSecret(options: MintOptions): Promise<MintResult> {
  const token = options.accessToken;
  if (!token) return failure("account-required");
  const model = options.model ?? DEFAULT_MODEL;
  const doFetch = options.fetch ?? fetch;
  const timeout = AbortSignal.timeout(10_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  try {
    const response = await doFetch(MINT_URL, {
      method: "POST",
      redirect: "error",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        expires_after: { anchor: "created_at", seconds: options.ttlSeconds ?? 600 },
        session: { ...options.session, type: "realtime", model },
      }),
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      return failure(
        response.status === 401
          ? "reconnect-required"
          : response.status === 403
            ? "not-entitled"
            : response.status === 429
              ? "rate-limited"
              : "mint_failed",
      );
    }
    const body = Secret.parse(await boundedJson(response, signal));
    signal.throwIfAborted();
    return { ok: true, secret: body.value, expiresAt: body.expires_at, model };
  } catch {
    return failure("mint_failed");
  }
}
