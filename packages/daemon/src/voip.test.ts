import { describe, expect, it } from "bun:test";
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { wire } from "@pew2/protocol";
import { parseApnsArgs } from "./cli/voice.js";
import {
  apnsJwt,
  apnsKeyPath,
  apnsRequest,
  clearApns,
  configureApns,
  readApnsConfig,
  VoipSender,
  type ApnsRequest,
} from "./voip.js";

const PAYLOAD: wire.VoiceCallPush = {
  type: "voice.call",
  callId: "6f9619ff-8b86-4d11-b42d-00c04fc964ff",
  caller: "pew2: finished",
  eventId: 3,
  taskId: "t1",
  projectId: "p1",
  class: "completed",
};
const TARGET = {
  token: "AB".repeat(32),
  environment: "production" as const,
  bundleId: "io.github.kenkaiii.pew2",
};

function keyPem(): string {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

async function configured(): Promise<{ dataDir: string; pem: string }> {
  const dataDir = await mkdtemp(join(tmpdir(), "pew2-voip-"));
  const pem = keyPem();
  const keyFile = join(dataDir, "AuthKey.p8");
  await writeFile(keyFile, pem);
  await configureApns(dataDir, keyFile, "ABC123DEFG", "TEAM123456");
  return { dataDir, pem };
}

describe("APNs provider token", () => {
  it("is an ES256 JWT Apple can verify with the key's public half", () => {
    const pem = keyPem();
    const jwt = apnsJwt(pem, "ABC123DEFG", "TEAM123456", 1_700_000_000);
    const [header, claims, signature] = jwt.split(".");
    expect(JSON.parse(Buffer.from(header ?? "", "base64url").toString())).toEqual({
      alg: "ES256",
      kid: "ABC123DEFG",
    });
    expect(JSON.parse(Buffer.from(claims ?? "", "base64url").toString())).toEqual({
      iss: "TEAM123456",
      iat: 1_700_000_000,
    });
    const ok = verify(
      "sha256",
      Buffer.from(`${header}.${claims}`),
      { key: createPublicKey(pem), dsaEncoding: "ieee-p1363" },
      Buffer.from(signature ?? "", "base64url"),
    );
    expect(ok).toBe(true);
  });
});

describe("apnsRequest", () => {
  it("is a VoIP push to the app's .voip topic that Apple must not store", () => {
    const request = apnsRequest(TARGET, "jwt", PAYLOAD);
    expect(request.host).toBe("api.push.apple.com");
    expect(request.path).toBe(`/3/device/${"ab".repeat(32)}`);
    expect(request.headers).toMatchObject({
      "apns-push-type": "voip",
      "apns-topic": "io.github.kenkaiii.pew2.voip",
      "apns-expiration": "0",
      authorization: "bearer jwt",
    });
    expect(JSON.parse(request.body)).toEqual(PAYLOAD);
    expect(apnsRequest({ ...TARGET, environment: "sandbox" }, "jwt", PAYLOAD).host).toBe(
      "api.sandbox.push.apple.com",
    );
  });
});

describe("configureApns", () => {
  it("stores the key owner-only and refuses what is not a key or not an Apple id", async () => {
    const { dataDir } = await configured();
    expect(await readApnsConfig(dataDir)).toEqual({ keyId: "ABC123DEFG", teamId: "TEAM123456" });
    // Windows has no POSIX modes to assert.
    if (process.platform !== "win32") expect((await stat(apnsKeyPath(dataDir))).mode & 0o777).toBe(0o600);

    const junk = join(dataDir, "junk.p8");
    await writeFile(junk, "not a key");
    await expect(configureApns(dataDir, junk, "ABC123DEFG", "TEAM123456")).rejects.toThrow(
      /not a readable/,
    );
    await expect(
      configureApns(dataDir, apnsKeyPath(dataDir), "short", "TEAM123456"),
    ).rejects.toThrow(/10-character/);

    await clearApns(dataDir);
    expect(await readApnsConfig(dataDir)).toBeUndefined();
  });
});

describe("VoipSender", () => {
  const sender = (
    dataDir: string,
    respond: (r: ApnsRequest) => { status: number; reason?: string },
    now = () => 1_000_000,
  ) => {
    const requests: ApnsRequest[] = [];
    const warnings: string[] = [];
    const voip = new VoipSender({
      dataDir,
      now,
      warn: (m) => warnings.push(m),
      transport: async (r) => (requests.push(r), respond(r)),
    });
    return { voip, requests, warnings };
  };

  it("does nothing without `pew2 voice apns`", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "pew2-voip-"));
    const { voip, requests } = sender(dataDir, () => ({ status: 200 }));
    expect(await voip.send(TARGET, PAYLOAD)).toBe("unconfigured");
    expect(requests).toHaveLength(0);
  });

  it("reports what Apple said, and reuses one provider token rather than minting per push", async () => {
    const { dataDir } = await configured();
    const statuses = [
      { status: 200 },
      { status: 410, reason: "Unregistered" },
      { status: 400, reason: "BadDeviceToken" },
      { status: 429 },
    ];
    const { voip, requests, warnings } = sender(
      dataDir,
      () => statuses[requests.length - 1] ?? { status: 500 },
    );
    expect(await voip.send(TARGET, PAYLOAD)).toBe("sent");
    expect(await voip.send(TARGET, PAYLOAD)).toBe("gone");
    expect(await voip.send(TARGET, PAYLOAD)).toBe("gone");
    expect(await voip.send(TARGET, PAYLOAD)).toBe("failed");
    expect(new Set(requests.map((r) => r.headers.authorization)).size).toBe(1);
    // One warning a minute, never the key.
    expect(warnings).toHaveLength(1);
    const pem = await readFile(apnsKeyPath(dataDir), "utf8");
    expect(warnings.join("")).not.toContain(pem.split("\n")[1] ?? "unreachable");
  });

  it("never throws when APNs is unreachable", async () => {
    const { dataDir } = await configured();
    const voip = new VoipSender({
      dataDir,
      warn: () => {},
      transport: async () => {
        throw new Error("ENOTFOUND");
      },
    });
    expect(await voip.send(TARGET, PAYLOAD)).toBe("failed");
  });
});

describe("pew2 voice apns arguments", () => {
  it("reads status, off and a full set, and names what is missing", () => {
    expect(parseApnsArgs([])).toEqual({ action: "status" });
    expect(parseApnsArgs(["off"])).toEqual({ action: "off" });
    expect(
      parseApnsArgs(["--key", "k.p8", "--key-id", "ABC123DEFG", "--team-id", "TEAM123456"]),
    ).toEqual({
      action: "set",
      key: "k.p8",
      keyId: "ABC123DEFG",
      teamId: "TEAM123456",
    });
    expect(parseApnsArgs(["--key", "k.p8"]).action).toBe("usage");
    expect(parseApnsArgs(["--key", "--key-id", "X"]).action).toBe("usage");
    expect(parseApnsArgs(["--nope", "x"]).action).toBe("usage");
  });
});
