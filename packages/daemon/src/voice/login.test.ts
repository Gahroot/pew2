import { expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEVICE_TOKEN_URL,
  DEVICE_USERCODE_URL,
  DEVICE_USER_AGENT,
  DEVICE_VERIFICATION_URL,
  DeviceLogin,
  REASON_NEVER_REDEEMED,
} from "./login.js";
import { OPENAI_TOKEN_URL } from "./credentials.js";

const NOW = 1_800_000_000_000;

async function setup(tokenReplies: Response[], clock = { t: NOW }) {
  const dir = await mkdtemp(join(tmpdir(), "voice-login-"));
  const calls: { url: string; init?: RequestInit }[] = [];
  const outcomes: { ok: boolean; reason?: string }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url === DEVICE_USERCODE_URL) {
      return Response.json({ device_auth_id: "dev1", user_code: "ABCD-1234", interval: "5", expires_at: (NOW + 60_000) / 1000 });
    }
    if (url === DEVICE_TOKEN_URL) return tokenReplies.shift() ?? new Response("", { status: 403 });
    if (url === OPENAI_TOKEN_URL) {
      return Response.json({ access_token: "at", refresh_token: "rt", id_token: `x.${Buffer.from('{"email":"k@x.y"}').toString("base64url")}.y`, expires_in: 3600 });
    }
    return new Response("", { status: 500 });
  }) as never;
  const login = new DeviceLogin({
    voiceAuthPath: join(dir, "voice-auth.json"),
    fetchImpl,
    now: () => clock.t,
    sleep: async (ms) => {
      clock.t += ms;
    },
    onChange: (outcome) => outcomes.push(outcome),
  });
  return { dir, calls, outcomes, login, clock };
}

test("device code: start, pending polls, redeem, exchange, save", async () => {
  const { dir, calls, outcomes, login } = await setup([
    new Response("", { status: 403 }),
    new Response("", { status: 404 }),
    Response.json({ authorization_code: "code1", code_verifier: "ver1" }),
  ]);
  const pending = await login.start();
  expect(pending).toEqual({ userCode: "ABCD-1234", verificationUrl: DEVICE_VERIFICATION_URL, expiresAt: NOW + 60_000 });
  const first = calls[0];
  expect(new Headers(first?.init?.headers).get("user-agent")).toBe(DEVICE_USER_AGENT);
  expect(JSON.parse(first?.init?.body as string)).toEqual({ client_id: "app_EMoamEEZ73f0CkXaXp7hrann" });
  await login.polling;
  expect(outcomes).toEqual([{ ok: true }]);
  expect(login.current).toBeUndefined();
  const exchange = calls.find((call) => call.url === OPENAI_TOKEN_URL);
  const form = new URLSearchParams(exchange?.init?.body as string);
  expect(form.get("grant_type")).toBe("authorization_code");
  expect(form.get("code")).toBe("code1");
  expect(form.get("code_verifier")).toBe("ver1");
  expect(form.get("redirect_uri")).toBe("https://auth.openai.com/deviceauth/callback");
  const saved = JSON.parse(await readFile(join(dir, "voice-auth.json"), "utf8"));
  expect(saved).toMatchObject({ accessToken: "at", refreshToken: "rt", account: "k@x.y", expiresAt: NOW + 15_000 + 3_600_000 });
});

test("a code never redeemed fails with the settings hint", async () => {
  const { outcomes, login } = await setup([]);
  await login.start();
  await login.polling;
  expect(outcomes).toEqual([{ ok: false, reason: REASON_NEVER_REDEEMED }]);
  expect(login.failure).toBe(REASON_NEVER_REDEEMED);
});

test("cancel stops polling silently", async () => {
  const { outcomes, login } = await setup([]);
  await login.start();
  login.cancel();
  await login.polling;
  expect(outcomes).toEqual([]);
  expect(login.current).toBeUndefined();
});
