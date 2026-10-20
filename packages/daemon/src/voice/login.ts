/**
 * pew2's own OpenAI sign-in, by device code, started from the phone.
 *
 * Used only when no agent on this machine already holds a login. Nothing is
 * typed on the computer: the phone shows the code and opens the verification
 * page, and this polls in the background until the code is redeemed.
 *
 * Cloudflare in front of auth.openai.com rejects unknown User-Agents, hence
 * the Codex CLI's.
 */
import type { wire } from "@pew2/protocol";
import {
  OPENAI_CLIENT_ID,
  OPENAI_TOKEN_URL,
  forgetOwnLogin,
  jwtClaims,
  writeVoiceAuth,
  type FetchLike,
} from "./credentials.js";

export const DEVICE_USERCODE_URL = "https://auth.openai.com/api/accounts/deviceauth/usercode";
export const DEVICE_TOKEN_URL = "https://auth.openai.com/api/accounts/deviceauth/token";
export const DEVICE_VERIFICATION_URL = "https://auth.openai.com/codex/device";
export const DEVICE_REDIRECT_URI = "https://auth.openai.com/deviceauth/callback";
export const DEVICE_USER_AGENT = "codex_cli_rs/0.146.0";

const DEFAULT_LIFETIME_MS = 15 * 60_000;

export const REASON_NEVER_REDEEMED =
  "The sign-in code expired before it was used. If you entered it, turn on \"Device code authorization\" in ChatGPT Settings → Security and try again.";

export interface LoginDeps {
  voiceAuthPath: string;
  fetchImpl?: FetchLike;
  now?: () => number;
  /** Resolves after `ms`, or early when aborted. Injected so tests don't wait. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** A login finished, failed, or was cancelled. */
  onChange: (outcome: { ok: boolean; reason?: string }) => void;
}

const defaultSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });

function parseExpiry(value: unknown, now: number): number {
  if (typeof value === "number") return value < 1e12 ? value * 1000 : value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return now + DEFAULT_LIFETIME_MS;
}

export class DeviceLogin {
  private pending?: { login: wire.VoiceLoginPending; abort: AbortController };
  private lastFailure?: string;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Settles when the background poll ends; for tests. */
  polling: Promise<void> = Promise.resolve();

  constructor(private readonly deps: LoginDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? defaultSleep;
  }

  /** The code on screen, while one is pending. */
  get current(): wire.VoiceLoginPending | undefined {
    return this.pending?.login;
  }

  /** Why the last attempt failed, until the next one starts. */
  get failure(): string | undefined {
    return this.lastFailure;
  }

  /** Ask for a code and start polling. A second start while pending returns the same code. */
  async start(): Promise<wire.VoiceLoginPending> {
    if (this.pending) return this.pending.login;
    this.lastFailure = undefined;
    const response = await this.fetchImpl(DEVICE_USERCODE_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": DEVICE_USER_AGENT },
      body: JSON.stringify({ client_id: OPENAI_CLIENT_ID }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`OpenAI sign-in is unavailable right now (${response.status}).`);
    const body = (await response.json()) as Record<string, unknown>;
    const deviceAuthId = body.device_auth_id;
    const userCode = body.user_code ?? body.usercode;
    if (typeof deviceAuthId !== "string" || typeof userCode !== "string") {
      throw new Error("OpenAI sign-in returned no code.");
    }
    const interval = Math.max(1, Number(body.interval) || 5) * 1000;
    const login: wire.VoiceLoginPending = {
      userCode,
      verificationUrl: DEVICE_VERIFICATION_URL,
      expiresAt: Math.round(parseExpiry(body.expires_at, this.now())),
    };
    const abort = new AbortController();
    this.pending = { login, abort };
    this.polling = this.poll(deviceAuthId, userCode, interval, login.expiresAt ?? 0, abort.signal);
    return login;
  }

  cancel(): void {
    if (!this.pending) return;
    this.pending.abort.abort();
    this.pending = undefined;
  }

  async logout(): Promise<void> {
    this.cancel();
    this.lastFailure = undefined;
    await forgetOwnLogin(this.deps.voiceAuthPath);
  }

  private finish(signal: AbortSignal, outcome: { ok: boolean; reason?: string }) {
    if (signal.aborted) return;
    this.pending = undefined;
    this.lastFailure = outcome.ok ? undefined : outcome.reason;
    this.deps.onChange(outcome);
  }

  private async poll(
    deviceAuthId: string,
    userCode: string,
    interval: number,
    expiresAt: number,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      while (!signal.aborted) {
        await this.sleep(interval, signal);
        if (signal.aborted) return;
        if (this.now() >= expiresAt) {
          this.finish(signal, { ok: false, reason: REASON_NEVER_REDEEMED });
          return;
        }
        let response: Response;
        try {
          response = await this.fetchImpl(DEVICE_TOKEN_URL, {
            method: "POST",
            headers: { "content-type": "application/json", "user-agent": DEVICE_USER_AGENT },
            body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
            signal: AbortSignal.timeout(15_000),
          });
        } catch {
          continue; // A blip offline; keep polling until the code expires.
        }
        if (response.status === 403 || response.status === 404) continue;
        if (!response.ok) {
          this.finish(signal, { ok: false, reason: `OpenAI sign-in failed (${response.status}).` });
          return;
        }
        const grant = (await response.json()) as Record<string, unknown>;
        if (typeof grant.authorization_code !== "string" || typeof grant.code_verifier !== "string") {
          this.finish(signal, { ok: false, reason: "OpenAI sign-in returned no authorization." });
          return;
        }
        await this.exchange(grant.authorization_code, grant.code_verifier, signal);
        return;
      }
    } catch {
      this.finish(signal, { ok: false, reason: "OpenAI sign-in failed. Try again." });
    }
  }

  private async exchange(code: string, verifier: string, signal: AbortSignal) {
    const response = await this.fetchImpl(OPENAI_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": DEVICE_USER_AGENT },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        client_id: OPENAI_CLIENT_ID,
        redirect_uri: DEVICE_REDIRECT_URI,
      }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      this.finish(signal, { ok: false, reason: `OpenAI sign-in failed (${response.status}).` });
      return;
    }
    const body = (await response.json()) as Record<string, unknown>;
    if (typeof body.access_token !== "string") {
      this.finish(signal, { ok: false, reason: "OpenAI sign-in returned no token." });
      return;
    }
    if (signal.aborted) return;
    const idToken = typeof body.id_token === "string" ? body.id_token : undefined;
    const email = jwtClaims(idToken)?.email;
    await writeVoiceAuth(this.deps.voiceAuthPath, {
      accessToken: body.access_token,
      ...(typeof body.refresh_token === "string" ? { refreshToken: body.refresh_token } : {}),
      ...(idToken ? { idToken } : {}),
      ...(typeof body.expires_in === "number" ? { expiresAt: this.now() + body.expires_in * 1000 } : {}),
      ...(typeof email === "string" ? { account: email } : {}),
    });
    this.finish(signal, { ok: true });
  }
}
