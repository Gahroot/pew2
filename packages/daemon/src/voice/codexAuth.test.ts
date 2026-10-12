import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { subscriptionToken } from "./codexAuth.js";

const jwt = (exp: number) => `h.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.s`;
const home = (auth: object) => {
  const dir = mkdtempSync(join(tmpdir(), "codex-"));
  writeFileSync(join(dir, "auth.json"), JSON.stringify(auth));
  return dir;
};

test("fresh ChatGPT token is used as is", async () => {
  const t = jwt(2_000_000_000);
  const dir = home({ auth_mode: "chatgpt", tokens: { access_token: t, refresh_token: "r" } });
  expect(await subscriptionToken({ CODEX_HOME: dir }, (() => { throw new Error("no net"); }) as never, () => 1_000)).toBe(t);
});

test("expired token is refreshed and saved back", async () => {
  const dir = home({ auth_mode: "chatgpt", tokens: { access_token: jwt(10), refresh_token: "r1" } });
  const fresh = jwt(2_000_000_000);
  const f = (async () => new Response(JSON.stringify({ access_token: fresh, refresh_token: "r2" }))) as unknown as typeof fetch;
  expect(await subscriptionToken({ CODEX_HOME: dir }, f, () => 1_000)).toBe(fresh);
  expect(JSON.parse(readFileSync(join(dir, "auth.json"), "utf8")).tokens.refresh_token).toBe("r2");
});

test("no login, or an API-key login, gives nothing", async () => {
  expect(await subscriptionToken({ CODEX_HOME: "/nonexistent-codex-home" })).toBeUndefined();
  const dir = home({ auth_mode: "apikey", tokens: {} });
  expect(await subscriptionToken({ CODEX_HOME: dir })).toBeUndefined();
});
