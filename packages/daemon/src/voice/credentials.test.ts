import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { POSIX_MODES } from "../testing/platform.js";
import {
  REASON_EXPIRED,
  REASON_SIGN_IN,
  forgetOwnLogin,
  resolveCredential,
  voicePaths,
  writeVoiceAuth,
  type VoicePaths,
} from "./credentials.js";

const NOW = 1_800_000_000_000;

async function paths(): Promise<VoicePaths> {
  const root = await mkdtemp(join(tmpdir(), "voice-cred-"));
  return {
    ggAuth: join(root, "gg", "auth.json"),
    codexAuth: join(root, "codex", "auth.json"),
    voiceAuth: join(root, "pew2", "voice-auth.json"),
    voicePrefs: join(root, "pew2", "voice-prefs.json"),
  };
}

async function put(path: string, value: unknown) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(value));
}

const jwt = (claims: object) =>
  `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;

const noFetch = (() => {
  throw new Error("must not fetch");
}) as never;

describe("resolveCredential", () => {
  test("nothing found asks the user to sign in", async () => {
    expect(await resolveCredential(await paths(), { now: NOW, fetchImpl: noFetch })).toEqual({
      ok: false,
      reason: REASON_SIGN_IN,
      canLogin: true,
    });
  });

  test("GG Coder first", async () => {
    const p = await paths();
    await put(p.ggAuth, { openai: { accessToken: "gg-tok", expiresAt: NOW + 3_600_000 } });
    await put(p.codexAuth, { tokens: { access_token: jwt({ exp: NOW / 1000 + 3600 }) } });
    const result = await resolveCredential(p, { now: NOW, fetchImpl: noFetch });
    expect(result.ok && result.credential).toEqual({ source: "ggcoder", token: "gg-tok" });
  });

  test("an expired agent token is skipped, never refreshed", async () => {
    const p = await paths();
    await put(p.ggAuth, { openai: { accessToken: "old", refreshToken: "r", expiresAt: NOW - 1 } });
    const codex = jwt({ exp: NOW / 1000 + 3600 });
    await put(p.codexAuth, { tokens: { access_token: codex, id_token: jwt({ email: "a@b.c" }) } });
    const result = await resolveCredential(p, { now: NOW, fetchImpl: noFetch });
    expect(result.ok && result.credential).toEqual({ source: "codex", token: codex, account: "a@b.c" });
  });

  test("only expired agent logins: the expired reason", async () => {
    const p = await paths();
    await put(p.ggAuth, { openai: { accessToken: "old", refreshToken: "r", expiresAt: NOW - 1 } });
    await put(p.codexAuth, { tokens: { access_token: jwt({ exp: NOW / 1000 - 10 }), refresh_token: "r" } });
    expect(await resolveCredential(p, { now: NOW, fetchImpl: noFetch })).toEqual({
      ok: false,
      reason: REASON_EXPIRED,
      canLogin: true,
    });
  });

  test("pew2's own token is refreshed and rewritten 0600", async () => {
    const p = await paths();
    await writeVoiceAuth(p.voiceAuth, { accessToken: "old", refreshToken: "r1", expiresAt: NOW - 1 });
    let body = "";
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      body = init?.body as string;
      return Response.json({ access_token: "new", refresh_token: "r2", expires_in: 3600 });
    }) as never;
    const result = await resolveCredential(p, { now: NOW, fetchImpl });
    expect(result.ok && result.credential.token).toBe("new");
    expect(body).toContain("grant_type=refresh_token");
    expect(body).toContain("refresh_token=r1");
    const saved = JSON.parse(await readFile(p.voiceAuth, "utf8"));
    expect(saved.refreshToken).toBe("r2");
    // Windows has no POSIX permission bits to set or read.
    if (POSIX_MODES) expect((await stat(p.voiceAuth)).mode & 0o777).toBe(0o600);
  });

  test("API key last, from env or the file", async () => {
    const p = await paths();
    let result = await resolveCredential({ ...p, apiKey: "sk-env" }, { now: NOW });
    expect(result.ok && result.credential).toEqual({ source: "apikey", token: "sk-env" });
    await writeVoiceAuth(p.voiceAuth, { apiKey: "sk-file" });
    result = await resolveCredential(p, { now: NOW });
    expect(result.ok && result.credential).toEqual({ source: "apikey", token: "sk-file" });
  });

  test("logout keeps an API key and touches no agent file", async () => {
    const p = await paths();
    await put(p.ggAuth, { openai: { accessToken: "gg" } });
    await writeVoiceAuth(p.voiceAuth, { accessToken: "mine", apiKey: "sk" });
    await forgetOwnLogin(p.voiceAuth);
    expect(JSON.parse(await readFile(p.voiceAuth, "utf8"))).toEqual({ apiKey: "sk" });
    expect(JSON.parse(await readFile(p.ggAuth, "utf8")).openai.accessToken).toBe("gg");
  });
});

test("voicePaths sits beside pairing.json", () => {
  const p = voicePaths({ PEW2_HOME: "/x/.pew2", CODEX_HOME: "/c" }, "/home/u");
  // Built with the platform's separator (Windows: backslashes).
  expect(p.voiceAuth).toBe(join("/x/.pew2", "voice-auth.json"));
  expect(p.voicePrefs).toBe(join("/x/.pew2", "voice-prefs.json"));
  expect(p.ggAuth).toBe(join("/home/u", ".gg", "auth.json"));
  expect(p.codexAuth).toBe(join("/c", "auth.json"));
});
