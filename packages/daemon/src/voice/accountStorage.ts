/** Pew2-owned credentials only. Never reads or writes the Codex CLI's login. */
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

export const AccountCredentials = z
  .object({
    accessToken: z.string().min(1).max(24000),
    refreshToken: z.string().min(1).max(24000),
    expiresAt: z.number().int().positive(),
  })
  .strict();
export type AccountCredentials = z.output<typeof AccountCredentials>;
export interface AccountStorage {
  read(): Promise<AccountCredentials | undefined>;
  replace(value: AccountCredentials): Promise<void>;
  delete(): Promise<void>;
}
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";

/** POSIX permissions, not OS keychain protection. Windows fails closed. */
export function accountStorage(dataDir: string, platform = process.platform): AccountStorage {
  const directory = join(dataDir, "voice-account");
  const path = join(directory, "oauth.json");
  const checkDirectory = async (create: boolean): Promise<boolean> => {
    if (platform === "win32" || !process.getuid)
      throw new Error("Voice account storage needs owner-only POSIX permissions.");
    if (create) await mkdir(directory, { mode: 0o700, recursive: true });
    try {
      const info = await lstat(directory);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        info.uid !== process.getuid() ||
        (info.mode & 0o077) !== 0
      ) {
        throw new Error("Voice account directory must be owned by you with mode 0700.");
      }
      return true;
    } catch (error) {
      if (!create && missing(error)) return false;
      throw error;
    }
  };
  return {
    async read() {
      if (!(await checkDirectory(false))) return undefined;
      let file;
      try {
        file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const info = await file.stat();
        if (
          !info.isFile() ||
          info.uid !== process.getuid?.() ||
          (info.mode & 0o077) !== 0 ||
          info.size > 64000
        ) {
          throw new Error("Invalid voice account credential file permissions or size.");
        }
        return AccountCredentials.parse(JSON.parse(await file.readFile("utf8")));
      } catch (error) {
        if (missing(error)) return undefined;
        throw error;
      } finally {
        await file?.close();
      }
    },
    async replace(value) {
      const validated = AccountCredentials.parse(value);
      await checkDirectory(true);
      const temporary = join(directory, `.${randomUUID()}.tmp`);
      try {
        const file = await open(
          temporary,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        try {
          await file.writeFile(JSON.stringify(validated));
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temporary, path);
      } finally {
        await unlink(temporary).catch((error: unknown) => {
          if (!missing(error)) throw error;
        });
      }
    },
    async delete() {
      if (!(await checkDirectory(false))) return;
      await unlink(path).catch((error: unknown) => {
        if (!missing(error)) throw error;
      });
    },
  };
}
