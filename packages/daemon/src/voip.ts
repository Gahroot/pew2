/**
 * Ringing an iPhone's native call screen: APNs VoIP pushes, sent straight to
 * Apple with the user's OWN APNs auth key (.p8).
 *
 * Expo's push service cannot carry a VoIP push, so this is the one place the
 * daemon talks to APNs itself. No credential ships in the daemon: the key is
 * configured on this machine with `pew2 voice apns`, copied into the data
 * directory owner-only, and never logged, sent to a client or put in an error.
 * Without it nothing here runs and a ring falls back to the ordinary banner.
 *
 * The relay is not involved, exactly as for Expo pushes: the desktop has
 * internet and calls Apple itself.
 *
 * Ported from AutomationGods/pew2 (`voip.ts`), cut down to sending: which
 * events ring, and the fallback when one cannot, are decided in `push.ts`.
 */
import { createPrivateKey, sign } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, rm } from "node:fs/promises";
import http2 from "node:http2";
import { join } from "node:path";
import { z } from "zod";
import type { wire } from "@pew2/protocol";
import { writeFileAtomic } from "./atomic-file.js";

export type VoipTarget = NonNullable<wire.PushRegister["voip"]>;

const ApnsConfig = z.object({
  keyId: z.string().regex(/^[A-Z0-9]{10}$/),
  teamId: z.string().regex(/^[A-Z0-9]{10}$/),
});
export type ApnsConfig = z.output<typeof ApnsConfig>;

export const apnsConfigPath = (dataDir: string) => join(dataDir, "voice-apns.json");
export const apnsKeyPath = (dataDir: string) => join(dataDir, "apns-voip.p8");

/** The configured key id and team, or undefined when VoIP is not set up (or the file is junk). */
export async function readApnsConfig(dataDir: string): Promise<ApnsConfig | undefined> {
  try {
    const parsed = ApnsConfig.safeParse(
      JSON.parse(await readFile(apnsConfigPath(dataDir), "utf8")),
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Validate the key and copy it in at 0600. Throws a sentence for a person on
 * anything wrong; never echoes the key.
 */
export async function configureApns(
  dataDir: string,
  keyFile: string,
  keyId: string,
  teamId: string,
): Promise<void> {
  const config = ApnsConfig.safeParse({ keyId, teamId });
  if (!config.success) {
    throw new Error(
      "--key-id and --team-id are each the 10-character IDs from the Apple developer portal.",
    );
  }
  let pem: string;
  try {
    pem = await readFile(keyFile, "utf8");
    createPrivateKey(pem);
  } catch {
    throw new Error(`${keyFile} is not a readable .p8 private key.`);
  }
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await copyFile(keyFile, apnsKeyPath(dataDir));
  await chmod(apnsKeyPath(dataDir), 0o600);
  await writeFileAtomic(apnsConfigPath(dataDir), `${JSON.stringify(config.data, null, 2)}\n`);
}

export async function clearApns(dataDir: string): Promise<void> {
  await rm(apnsConfigPath(dataDir), { force: true });
  await rm(apnsKeyPath(dataDir), { force: true });
}

/** ES256 provider token: header {alg,kid}, claims {iss,iat}. */
export function apnsJwt(keyPem: string, keyId: string, teamId: string, nowSeconds: number): string {
  const enc = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const input = `${enc({ alg: "ES256", kid: keyId })}.${enc({ iss: teamId, iat: nowSeconds })}`;
  const signature = sign("sha256", Buffer.from(input), {
    key: createPrivateKey(keyPem),
    dsaEncoding: "ieee-p1363",
  });
  return `${input}.${signature.toString("base64url")}`;
}

export interface ApnsRequest {
  host: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}
export type ApnsTransport = (request: ApnsRequest) => Promise<{ status: number; reason?: string }>;

/** HTTP/2 via node:http2, which Bun's client implements. One connection per push: rings are rare. */
export const http2Transport: ApnsTransport = (request) =>
  new Promise((resolve, reject) => {
    const client = http2.connect(`https://${request.host}`);
    client.on("error", reject);
    const stream = client.request({ ":method": "POST", ":path": request.path, ...request.headers });
    stream.setTimeout(10_000, () => stream.close(http2.constants.NGHTTP2_CANCEL));
    let status = 0;
    let body = "";
    stream.on("response", (headers) => {
      status = Number(headers[":status"]);
    });
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      if (body.length < 4096) body += chunk;
    });
    stream.on("end", () => {
      client.close();
      let reason: string | undefined;
      try {
        const parsed: unknown = body ? JSON.parse(body) : undefined;
        if (
          parsed &&
          typeof parsed === "object" &&
          "reason" in parsed &&
          typeof parsed.reason === "string"
        ) {
          reason = parsed.reason;
        }
      } catch {
        // Not JSON: the status alone decides.
      }
      resolve({ status, reason });
    });
    stream.on("error", (error) => {
      client.close();
      reject(error instanceof Error ? error : new Error("APNs request failed"));
    });
    stream.end(request.body);
  });

export function apnsRequest(
  target: VoipTarget,
  jwt: string,
  payload: wire.VoiceCallPush,
): ApnsRequest {
  return {
    host: target.environment === "sandbox" ? "api.sandbox.push.apple.com" : "api.push.apple.com",
    path: `/3/device/${target.token.toLowerCase()}`,
    headers: {
      authorization: `bearer ${jwt}`,
      "apns-push-type": "voip",
      "apns-topic": `${target.bundleId}.voip`,
      "apns-priority": "10",
      // A ring that lands late is worse than none: Apple must not store it.
      "apns-expiration": "0",
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  };
}

/**
 * - `sent`: Apple accepted it; the phone rings.
 * - `gone`: the token is dead (app deleted, setting off); forget it.
 * - `unconfigured`: no `pew2 voice apns` on this machine.
 * - `failed`: anything else. The caller falls back to a banner.
 */
export type VoipOutcome = "sent" | "gone" | "unconfigured" | "failed";

export class VoipSender {
  private jwtCache?: { jwt: string; keyId: string; at: number };
  private nextWarnAt = 0;

  constructor(
    private readonly deps: {
      dataDir: string;
      transport?: ApnsTransport;
      now?: () => number;
      warn?: (message: string) => void;
    },
  ) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private async jwt(config: ApnsConfig): Promise<string> {
    const now = this.now();
    // Apple refuses a provider token older than an hour and throttles minting
    // one more often than every twenty minutes: reuse each for forty.
    if (
      this.jwtCache &&
      this.jwtCache.keyId === config.keyId &&
      now - this.jwtCache.at < 40 * 60_000
    ) {
      return this.jwtCache.jwt;
    }
    const pem = await readFile(apnsKeyPath(this.deps.dataDir), "utf8");
    const jwt = apnsJwt(pem, config.keyId, config.teamId, Math.floor(now / 1000));
    this.jwtCache = { jwt, keyId: config.keyId, at: now };
    return jwt;
  }

  /** Never throws. */
  async send(target: VoipTarget, payload: wire.VoiceCallPush): Promise<VoipOutcome> {
    const config = await readApnsConfig(this.deps.dataDir);
    if (!config) return "unconfigured";
    let jwt: string;
    try {
      jwt = await this.jwt(config);
    } catch {
      this.warn("could not read the APNs key; run `pew2 voice apns` again");
      return "failed";
    }
    try {
      const result = await (this.deps.transport ?? http2Transport)(
        apnsRequest(target, jwt, payload),
      );
      if (result.status === 200) return "sent";
      if (result.reason === "ExpiredProviderToken" || result.reason === "InvalidProviderToken")
        this.jwtCache = undefined;
      this.warn(
        `APNs refused a VoIP push (${result.status}${result.reason ? ` ${result.reason}` : ""})`,
      );
      return result.status === 410 ||
        result.reason === "BadDeviceToken" ||
        result.reason === "Unregistered"
        ? "gone"
        : "failed";
    } catch {
      this.warn("could not reach APNs");
      return "failed";
    }
  }

  /** At most one line a minute: a broken key must not flood the log on every event. */
  private warn(text: string): void {
    const now = this.now();
    if (now < this.nextWarnAt) return;
    this.nextWarnAt = now + 60_000;
    try {
      (this.deps.warn ?? console.warn)(`[voip] ${text}. Further failures are suppressed for 60s.`);
    } catch {
      // Diagnostics never break a ring.
    }
  }
}
