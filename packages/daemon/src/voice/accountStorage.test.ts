import { expect, test } from "bun:test";
import { chmod, lstat, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { scratch } from "./scratch.js";
import { accountStorage } from "./accountStorage.js";

test("credentials use isolated owner-only storage and disconnect leaves Codex untouched", async () => {
  const root = scratch();
  const storage = accountStorage(root);
  const value = { accessToken: "access", refreshToken: "refresh", expiresAt: 1000 };
  await writeFile(join(root, "auth.json"), "CLI login");
  expect(await storage.read()).toBeUndefined();
  await storage.replace(value);
  expect(await storage.read()).toEqual(value);
  expect((await lstat(join(root, "voice-account"))).mode & 0o777).toBe(0o700);
  expect((await lstat(join(root, "voice-account/oauth.json"))).mode & 0o777).toBe(0o600);
  await storage.delete();
  expect(await storage.read()).toBeUndefined();
  expect(await readFile(join(root, "auth.json"), "utf8")).toBe("CLI login");
});

test("unsafe permissions, symlinks, and unsupported permission enforcement fail closed", async () => {
  const root = scratch();
  const directory = join(root, "voice-account");
  await mkdir(directory, { mode: 0o755 });
  await chmod(directory, 0o755);
  await expect(accountStorage(root).read()).rejects.toThrow();
  await chmod(directory, 0o700);
  await symlink(join(root, "auth.json"), join(directory, "oauth.json"));
  await expect(accountStorage(root).read()).rejects.toThrow();
  await expect(accountStorage(scratch(), "win32").read()).rejects.toThrow("POSIX");
});
