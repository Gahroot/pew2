import { expect, test } from "bun:test";
import { AccountAuth } from "./accountAuth.js";
import type { AccountCredentials, AccountStorage } from "./accountStorage.js";

function harness(
  options: {
    credentials?: AccountCredentials;
    probeCode?: string;
    failWrite?: boolean;
    beforeWrite?: () => Promise<void>;
  } = {},
) {
  let now = 1000;
  let saved = options.credentials;
  const requests: { url: string; init?: RequestInit }[] = [];
  const responses: Response[] = [];
  const waits: { ms: number; resume: () => void }[] = [];
  const storage: AccountStorage = {
    read: async () => saved,
    replace: async (value) => {
      if (options.failWrite) throw new Error("sensitive storage detail");
      await options.beforeWrite?.();
      saved = value;
    },
    delete: async () => {
      saved = undefined;
    },
  };
  const create = () =>
    AccountAuth.create({
      dataDir: "unused",
      storage,
      now: () => now,
      fetch: (async (url, init) => {
        requests.push({
          url: typeof url === "string" ? url : url instanceof URL ? url.href : url.url,
          init,
        });
        const response = responses.shift();
        if (!response) throw new Error("sensitive network detail");
        return response;
      }) as typeof fetch,
      wait: (ms) => new Promise<void>((resume) => waits.push({ ms, resume })),
      probe: async () =>
        options.probeCode ? { ok: false, code: options.probeCode } : { ok: true },
    });
  return {
    create,
    requests,
    waits,
    responses,
    saved: () => saved,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const device = () =>
  json({ device_auth_id: "private-device-id", user_code: "ABCD-EFGH", interval: "5" });
const authorization = () =>
  json({ authorization_code: "private-code", code_verifier: "private-verifier" });
const tokens = () =>
  json({ access_token: "private-access", refresh_token: "private-refresh", expires_in: 3600 });
async function settle() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

test("device authorization stays daemon-owned; another device cannot read or cancel it", async () => {
  const h = harness();
  const account = await h.create();
  h.responses.push(device());
  const state = await account.connect("phone");
  expect(state.state).toBe("authorizing");
  expect(state.authorization?.verificationUrl).toBe("https://auth.openai.com/codex/device");
  expect(JSON.stringify(state)).not.toContain("private-device-id");
  const id = state.authorization?.attemptId ?? "missing";
  expect(await account.status("other", id)).toMatchObject({ error: { code: "invalid-attempt" } });
  expect(await account.cancel("other", id)).toMatchObject({ error: { code: "invalid-attempt" } });
  expect(await account.connect("phone")).toEqual(state);
  expect(h.requests).toHaveLength(1);
  h.responses.push(authorization(), tokens());
  h.waits.shift()?.resume();
  await settle();
  expect(await account.status("phone")).toMatchObject({ state: "connected", voiceReady: true });
  expect(h.saved()?.refreshToken).toBe("private-refresh");
  expect(h.requests[2]?.init?.redirect).toBe("error");
  expect(String(h.requests[2]?.init?.body as string)).toContain(
    "redirect_uri=https%3A%2F%2Fauth.openai.com%2Fdeviceauth%2Fcallback",
  );
  expect(JSON.stringify(await account.status("phone"))).not.toContain("private");
  account.dispose();
});

test("pending and slow_down obey bounded polling; expiry never saves credentials", async () => {
  const h = harness();
  const account = await h.create();
  h.responses.push(device());
  await account.connect("phone");
  h.responses.push(json({}, 403));
  h.waits.shift()?.resume();
  await settle();
  expect(h.waits[0]?.ms).toBe(5000);
  h.responses.push(json({ error: "slow_down" }, 400));
  h.waits.shift()?.resume();
  await settle();
  expect(h.waits[0]?.ms).toBe(10000);
  h.advance(900001);
  h.waits.shift()?.resume();
  await settle();
  expect(await account.status("phone")).toMatchObject({ error: { code: "expired" } });
  expect(h.saved()).toBeUndefined();
  account.dispose();
});

for (const action of ["cancel", "disconnect", "dispose"] as const) {
  test(`${action} fences a late successful poll`, async () => {
    const h = harness();
    const account = await h.create();
    h.responses.push(device());
    const state = await account.connect("phone");
    if (action === "cancel") await account.cancel("phone", state.authorization?.attemptId ?? "");
    else if (action === "disconnect") await account.disconnect();
    else account.dispose();
    h.responses.push(authorization(), tokens());
    h.waits.shift()?.resume();
    await settle();
    expect(h.saved()).toBeUndefined();
    expect(h.requests).toHaveLength(1);
    account.dispose();
  });
}

for (const [reply, code] of [
  [{ error: "access_denied" }, "denied"],
  [{ error: "expired_token" }, "expired"],
  [{ surprise: "private-data" }, "unavailable"],
] as const) {
  test(`poll ${code} is sanitized`, async () => {
    const h = harness();
    const account = await h.create();
    h.responses.push(device());
    await account.connect("phone");
    h.responses.push(json(reply, 400));
    h.waits.shift()?.resume();
    await settle();
    const state = await account.status("phone");
    expect(state.error?.code).toBe(code === "unavailable" ? "denied" : code);
    expect(JSON.stringify(state)).not.toContain("private");
    account.dispose();
  });
}

test("a real login is separate from Realtime entitlement; disk failures fail closed", async () => {
  for (const failWrite of [false, true]) {
    const h = harness({ failWrite, probeCode: "not-entitled" });
    const account = await h.create();
    h.responses.push(device());
    await account.connect("phone");
    h.responses.push(authorization(), tokens());
    h.waits.shift()?.resume();
    await settle();
    expect(await account.status("phone")).toMatchObject(
      failWrite
        ? { voiceReady: false, error: { code: "storage" } }
        : { state: "not-entitled", voiceReady: false },
    );
    account.dispose();
  }
});

test("concurrent refresh is serialized and rotation persists only in the own store", async () => {
  const h = harness({
    credentials: { accessToken: "old", refreshToken: "old-refresh", expiresAt: 1001 },
  });
  const account = await h.create();
  h.responses.push(tokens());
  const results = await Promise.all([account.accessToken(), account.accessToken()]);
  expect(results).toEqual([
    { ok: true, token: "private-access" },
    { ok: true, token: "private-access" },
  ]);
  expect(h.requests).toHaveLength(1);
  expect(h.saved()?.refreshToken).toBe("private-refresh");
  await account.disconnect();
  expect(h.saved()).toBeUndefined();
  expect(await account.accessToken()).toMatchObject({ ok: false, code: "account-required" });
  account.dispose();
});

test("cancellation during credential persistence rolls back the late write", async () => {
  for (const action of ["cancel", "disconnect", "dispose"] as const) {
    let resumeWrite: (() => void) | undefined;
    const h = harness({
      beforeWrite: () =>
        new Promise<void>((resolve) => {
          resumeWrite = resolve;
        }),
    });
    const account = await h.create();
    h.responses.push(device());
    const state = await account.connect("phone");
    h.responses.push(authorization(), tokens());
    h.waits.shift()?.resume();
    await settle();
    expect(resumeWrite).toBeDefined();
    let disconnected: Promise<unknown> | undefined;
    if (action === "cancel") await account.cancel("phone", state.authorization?.attemptId ?? "");
    else if (action === "disconnect") disconnected = account.disconnect();
    else account.dispose();
    resumeWrite?.();
    await settle();
    await disconnected;
    expect(h.saved()).toBeUndefined();
    expect(await account.accessToken()).toMatchObject({ ok: false, code: "account-required" });
    account.dispose();
  }
});

test("malformed and oversized provider responses do not echo data", async () => {
  for (const response of [
    json({ device_auth_id: "private", user_code: "bad url", interval: 0 }),
    new Response("private".repeat(10000)),
  ]) {
    const h = harness();
    const account = await h.create();
    h.responses.push(response);
    const state = await account.connect("phone");
    expect(state.error?.code).toBe("unavailable");
    expect(JSON.stringify(state)).not.toContain("private");
    account.dispose();
  }
});
