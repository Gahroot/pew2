/**
 * Mint the short-lived secret the phone uses to talk to OpenAI Realtime.
 *
 * The API key never leaves this process: the phone gets only an ephemeral
 * client secret. `fetch` is injected so tests never touch the network, and no
 * error path ever includes the key.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { redactSecrets } from "./safety.js";

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

/** Environment wins over the prefs file. */
export function resolveApiKey(env: NodeJS.ProcessEnv, prefs: VoicePrefs): string | undefined {
  const key = env.OPENAI_API_KEY?.trim() || prefs.openaiApiKey?.trim();
  return key || undefined;
}

export type MintResult =
  | { ok: true; secret: string; expiresAt: number; model: string }
  | { ok: false; code: "no_api_key" | "mint_failed"; message: string };

export interface MintOptions {
  apiKey: string | undefined;
  model?: string;
  /** The session config (instructions, tools, audio...) to bake into the secret. */
  session: Record<string, unknown>;
  ttlSeconds?: number;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

export async function mintRealtimeSecret(options: MintOptions): Promise<MintResult> {
  const key = options.apiKey;
  if (!key) {
    return {
      ok: false,
      code: "no_api_key",
      message: "Sign in with `codex login` on this computer, or set OPENAI_API_KEY where the pew2 daemon runs, then restart it.",
    };
  }
  const model = options.model ?? DEFAULT_MODEL;
  const doFetch = options.fetch ?? fetch;
  const scrub = (text: string) => redactSecrets(text).split(key).join("[redacted]");
  try {
    const response = await doFetch(MINT_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        expires_after: { anchor: "created_at", seconds: options.ttlSeconds ?? 600 },
        session: { ...options.session, type: "realtime", model },
      }),
      signal: options.signal ?? AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      const detail = scrub((await response.text().catch(() => "")).slice(0, 200));
      return {
        ok: false,
        code: "mint_failed",
        message: `OpenAI refused the voice session (HTTP ${response.status}).${detail ? ` ${detail}` : ""}`,
      };
    }
    const body = (await response.json()) as { value?: unknown; expires_at?: unknown };
    if (typeof body.value !== "string" || !body.value) {
      return { ok: false, code: "mint_failed", message: "OpenAI sent no client secret." };
    }
    const expiresAt =
      typeof body.expires_at === "number" ? Math.floor(body.expires_at) : Math.floor(Date.now() / 1000) + 600;
    return { ok: true, secret: body.value, expiresAt, model };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, code: "mint_failed", message: `Could not reach OpenAI: ${scrub(message)}` };
  }
}
