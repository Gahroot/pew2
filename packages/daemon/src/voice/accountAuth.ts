/**
 * Daemon-owned device authorization, following OpenAI Codex's public protocol.
 * Protocol evidence: docs/VOICE-ACCOUNT-EVIDENCE.md. Login is NOT Realtime entitlement.
 * No reference application source is copied; no shared CLI refresh token is used.
 */
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { VoiceAccountStatus } from "../../../protocol/src/voice.js";
import { boundedJson } from "./accountHttp.js";
import { accountStorage, type AccountCredentials, type AccountStorage } from "./accountStorage.js";

const AUTH = "https://auth.openai.com";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const VERIFICATION_URL = "https://auth.openai.com/codex/device";
const MAX_ATTEMPT_MS = 15 * 60_000;
const Token = z.object({
  access_token: z.string().min(1).max(24000),
  refresh_token: z.string().min(1).max(24000).optional(),
  expires_in: z
    .number()
    .int()
    .positive()
    .max(365 * 86400),
});
const UserCode = z.object({
  device_auth_id: z.string().min(1).max(2048),
  user_code: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9-]+$/),
  interval: z
    .union([z.number(), z.string().regex(/^\d+$/)])
    .transform(Number)
    .pipe(z.number().int().min(1).max(60)),
});
const Authorization = z.object({
  authorization_code: z.string().min(1).max(8000),
  code_verifier: z.string().min(1).max(2048),
});
type AccountError = NonNullable<VoiceAccountStatus["error"]>;
type Snapshot = Omit<VoiceAccountStatus, "t" | "requestId" | "supported">;
export type AccountTokenResult =
  | { ok: true; token: string }
  | { ok: false; code: "account-required" | "reconnect-required" | "mint_failed"; message: string };
export interface VoiceAccount {
  status(owner: string, attemptId?: string): Promise<Snapshot>;
  connect(owner: string): Promise<Snapshot>;
  cancel(owner: string, attemptId: string): Promise<Snapshot>;
  disconnect(): Promise<Snapshot>;
  accessToken(): Promise<AccountTokenResult>;
  noteMint(code?: string): void;
  invalidate(): void;
  dispose(): void;
}
interface Attempt {
  id: string;
  owner: string;
  controller: AbortController;
  generation: number;
  expiresAt: number;
  authorization?: NonNullable<Snapshot["authorization"]>;
  error?: AccountError;
  done?: boolean;
}
export interface AccountAuthDeps {
  dataDir: string;
  fetch?: typeof fetch;
  storage?: AccountStorage;
  now?: () => number;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Must mint then discard a secret; never opens a microphone/session. */
  probe: (token: string, signal: AbortSignal) => Promise<{ ok: boolean; code?: string }>;
}
const messages = {
  unavailable: "Could not reach ChatGPT. Try again while your computer is online.",
  denied: "ChatGPT sign-in was refused. Start a new sign-in.",
  expired: "This ChatGPT code expired. Start a new sign-in.",
  cancelled: "ChatGPT sign-in cancelled.",
  "rate-limited": "ChatGPT is rate limiting requests. Try again later.",
  storage:
    "Voice credentials could not be stored. Use an owner-only voice-account directory (0700) and credential file (0600) on macOS/Linux; Windows storage is not supported yet.",
  "invalid-attempt": "This sign-in does not belong to this device or has ended.",
} as const;
const accountError = (code: AccountError["code"]): AccountError => ({
  code,
  message: messages[code],
  retryable: code !== "storage" && code !== "invalid-attempt",
});

export class AccountAuth implements VoiceAccount {
  private credentials?: AccountCredentials;
  private state: Snapshot["state"] = "not-connected";
  private ready = false;
  private error?: AccountError;
  private readonly attempts = new Map<string, Attempt>();
  private generation = 0;
  private readonly controllers = new Set<AbortController>();
  private closed = false;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly storage: AccountStorage;
  private readonly now: () => number;
  private readonly doFetch: typeof fetch;
  private readonly wait: (ms: number, signal: AbortSignal) => Promise<void>;
  private constructor(private readonly deps: AccountAuthDeps) {
    this.storage = deps.storage ?? accountStorage(deps.dataDir);
    this.now = deps.now ?? Date.now;
    this.doFetch = deps.fetch ?? fetch;
    this.wait = deps.wait ?? ((ms, signal) => delay(ms, undefined, { signal }));
  }
  static async create(deps: AccountAuthDeps): Promise<AccountAuth> {
    const service = new AccountAuth(deps);
    try {
      service.credentials = await service.storage.read();
      if (service.credentials) service.state = "connected";
    } catch {
      service.error = accountError("storage");
    }
    return service;
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work);
    this.queue = next.catch(() => undefined);
    return next;
  }
  private snapshot(error = this.error): Snapshot {
    return { state: this.state, voiceReady: this.ready, ...(error ? { error } : {}) };
  }
  async status(owner: string, attemptId?: string): Promise<Snapshot> {
    const attempt = this.attempts.get(owner);
    if (attemptId && attempt?.id !== attemptId)
      return this.snapshot(accountError("invalid-attempt"));
    if (attempt && !attempt.done && this.now() >= attempt.expiresAt) {
      attempt.controller.abort();
      attempt.done = true;
      attempt.error = accountError("expired");
    }
    if (attempt && !attempt.done)
      return { ...this.snapshot(), state: "authorizing", authorization: attempt.authorization };
    return this.snapshot(attempt?.error ?? this.error);
  }
  async connect(owner: string): Promise<Snapshot> {
    if (this.closed) return this.snapshot(accountError("unavailable"));
    const existing = this.attempts.get(owner);
    if (existing && !existing.done) return this.status(owner);
    if (this.attempts.size >= 4 && !existing) return this.snapshot(accountError("unavailable"));
    // Reserve before I/O: retries cannot create parallel attempts for one device.
    const attempt: Attempt = {
      id: randomUUID(),
      owner,
      controller: new AbortController(),
      generation: this.generation,
      expiresAt: this.now() + MAX_ATTEMPT_MS,
    };
    this.attempts.set(owner, attempt);
    try {
      const response = await this.post(
        "/api/accounts/deviceauth/usercode",
        { client_id: CLIENT_ID },
        attempt.controller.signal,
      );
      if (!response.ok) {
        attempt.error = accountError(response.status === 429 ? "rate-limited" : "denied");
        attempt.done = true;
      } else {
        const code = UserCode.parse(await boundedJson(response, attempt.controller.signal));
        if (!this.current(attempt)) return this.snapshot(accountError("cancelled"));
        attempt.authorization = {
          attemptId: attempt.id,
          userCode: code.user_code,
          verificationUrl: VERIFICATION_URL,
          expiresAt: attempt.expiresAt,
        };
        void this.poll(attempt, code).catch(() => {
          /* poll contains sanitized failure handling */
        });
      }
    } catch {
      if (this.current(attempt)) {
        attempt.error = accountError("unavailable");
        attempt.done = true;
      }
    }
    return this.status(owner);
  }
  private current(attempt: Attempt) {
    return (
      !this.closed &&
      !attempt.done &&
      !attempt.controller.signal.aborted &&
      attempt.generation === this.generation &&
      this.attempts.get(attempt.owner) === attempt &&
      this.now() < attempt.expiresAt
    );
  }
  private async post(
    path: string,
    body: Record<string, string>,
    signal: AbortSignal,
    form = false,
  ) {
    return this.doFetch(`${AUTH}${path}`, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": form ? "application/x-www-form-urlencoded" : "application/json" },
      body: form ? new URLSearchParams(body).toString() : JSON.stringify(body),
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    });
  }
  private async poll(attempt: Attempt, code: z.output<typeof UserCode>) {
    let interval = code.interval * 1000;
    try {
      while (this.current(attempt)) {
        await this.wait(
          Math.min(interval, Math.max(1, attempt.expiresAt - this.now())),
          attempt.controller.signal,
        );
        if (!this.current(attempt)) break;
        const response = await this.post(
          "/api/accounts/deviceauth/token",
          { device_auth_id: code.device_auth_id, user_code: code.user_code },
          attempt.controller.signal,
        );
        // Codex's device service uses 403/404 for authorization pending.
        if (response.status === 403 || response.status === 404) {
          await response.body?.cancel();
          continue;
        }
        if (response.status === 429) {
          await response.body?.cancel();
          interval = Math.min(60_000, interval + 5000);
          continue;
        }
        if (!response.ok) {
          const parsed = z
            .object({ error: z.string().max(100) })
            .safeParse(await boundedJson(response, attempt.controller.signal));
          const error = parsed.success ? parsed.data.error : "invalid";
          if (error === "authorization_pending") continue;
          if (error === "slow_down") {
            interval = Math.min(60_000, interval + 5000);
            continue;
          }
          attempt.error = accountError(error === "expired_token" ? "expired" : "denied");
          break;
        }
        const authorization = Authorization.parse(
          await boundedJson(response, attempt.controller.signal),
        );
        if (!this.current(attempt)) break;
        const exchanged = await this.post(
          "/oauth/token",
          {
            grant_type: "authorization_code",
            client_id: CLIENT_ID,
            code: authorization.authorization_code,
            code_verifier: authorization.code_verifier,
            redirect_uri: `${AUTH}/deviceauth/callback`,
          },
          attempt.controller.signal,
          true,
        );
        if (!exchanged.ok) {
          await exchanged.body?.cancel();
          attempt.error = accountError("denied");
          break;
        }
        const tokens = Token.parse(await boundedJson(exchanged, attempt.controller.signal));
        if (!tokens.refresh_token) throw new Error("Missing refresh token");
        const credentials: AccountCredentials = {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          expiresAt: this.now() + tokens.expires_in * 1000,
        };
        await this.serial(async () => {
          if (!this.current(attempt)) return;
          const previous = this.credentials;
          try {
            await this.storage.replace(credentials);
          } catch {
            attempt.error = accountError("storage");
            return;
          }
          // Cancel/shutdown can arrive during the write. Roll it back inside
          // the same queue; disconnect's queued delete still runs last.
          if (!this.current(attempt)) {
            try {
              if (previous) await this.storage.replace(previous);
              else await this.storage.delete();
            } catch {
              this.error = accountError("storage");
            }
            return;
          }
          this.credentials = credentials;
          this.state = "connected";
          this.ready = false;
          this.error = undefined;
        });
        if (!this.current(attempt) || attempt.error) break;
        const probe = await this.deps.probe(credentials.accessToken, attempt.controller.signal);
        if (this.current(attempt))
          this.noteMint(probe.ok ? undefined : (probe.code ?? "mint_failed"));
        break;
      }
      if (!attempt.error && this.now() >= attempt.expiresAt)
        attempt.error = accountError("expired");
    } catch {
      if (this.current(attempt)) attempt.error = accountError("unavailable");
    } finally {
      attempt.done = true;
    }
  }
  async cancel(owner: string, attemptId: string): Promise<Snapshot> {
    const attempt = this.attempts.get(owner);
    if (!attempt || attempt.id !== attemptId) return this.snapshot(accountError("invalid-attempt"));
    attempt.controller.abort();
    attempt.done = true;
    attempt.error = accountError("cancelled");
    return this.snapshot(attempt.error);
  }
  /** Invalidate before any await, so late fetch/storage completions cannot revive a login. */
  invalidate() {
    this.generation++;
    for (const attempt of this.attempts.values()) attempt.controller.abort();
    this.attempts.clear();
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    this.ready = false;
  }
  async disconnect(): Promise<Snapshot> {
    this.invalidate();
    this.credentials = undefined;
    this.state = "not-connected";
    this.error = undefined;
    return this.serial(async () => {
      try {
        await this.storage.delete();
      } catch {
        this.error = accountError("storage");
      }
      return this.snapshot();
    });
  }
  async accessToken(): Promise<AccountTokenResult> {
    const generation = this.generation;
    return this.serial(async () => {
      const credentials = this.credentials;
      if (
        this.closed ||
        generation !== this.generation ||
        !credentials ||
        this.state === "reconnect-required" ||
        this.error?.code === "storage"
      ) {
        return {
          ok: false,
          code: this.state === "reconnect-required" ? "reconnect-required" : "account-required",
          message:
            "Connect your ChatGPT voice account in the app. Existing API keys and Codex logins are not used for voice.",
        };
      }
      if (credentials.expiresAt - this.now() > 120_000)
        return { ok: true, token: credentials.accessToken };
      const controller = new AbortController();
      this.controllers.add(controller);
      try {
        const response = await this.post(
          "/oauth/token",
          {
            grant_type: "refresh_token",
            client_id: CLIENT_ID,
            refresh_token: credentials.refreshToken,
          },
          controller.signal,
          true,
        );
        if (!response.ok) {
          await response.body?.cancel();
          if (
            generation === this.generation &&
            (response.status === 400 || response.status === 401)
          )
            this.noteMint("reconnect-required");
          return {
            ok: false,
            code: "reconnect-required",
            message: "Reconnect your ChatGPT voice account.",
          };
        }
        const tokens = Token.parse(await boundedJson(response, controller.signal));
        if (generation !== this.generation || this.closed) throw new Error("Cancelled");
        const next: AccountCredentials = {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token ?? credentials.refreshToken,
          expiresAt: this.now() + tokens.expires_in * 1000,
        };
        try {
          await this.storage.replace(next);
        } catch {
          this.error = accountError("storage");
          throw new Error("Storage");
        }
        if (generation !== this.generation || this.closed) throw new Error("Cancelled");
        this.credentials = next;
        return { ok: true, token: next.accessToken };
      } catch {
        return {
          ok: false,
          code: "mint_failed",
          message:
            "Could not refresh the voice account. Check the computer's connection and credential storage, then retry.",
        };
      } finally {
        this.controllers.delete(controller);
      }
    });
  }
  noteMint(code?: string) {
    this.ready = code === undefined;
    if (code === "reconnect-required") this.state = "reconnect-required";
    else if (code === "not-entitled") this.state = "not-entitled";
    else if (this.credentials) this.state = "connected";
    this.error =
      code === "rate-limited"
        ? accountError("rate-limited")
        : code === "mint_failed"
          ? accountError("unavailable")
          : undefined;
  }
  dispose() {
    this.closed = true;
    this.invalidate();
    this.credentials = undefined;
  }
}
