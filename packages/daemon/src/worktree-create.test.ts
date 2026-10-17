import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorktree, isCarryable, slugifyBranch } from "./worktree-create.js";
import { detectWorktree, registeredWorktrees } from "./worktree.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "init.defaultBranch=main", ...args],
    {
      cwd,
      encoding: "utf8",
    },
  );
}

/** A repo named `triten-os` with one commit, a gitignored `.env`, and a fake home beside it. */
function repo() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "pew2-wtc-")));
  const root = join(base, "triten-os");
  const home = join(base, "home");
  mkdirSync(root);
  mkdirSync(home);
  git(root, "init");
  writeFileSync(join(root, ".gitignore"), ".env\nnode_modules/\nsecret.db\n");
  writeFileSync(join(root, "a.txt"), "a");
  git(root, "add", ".");
  git(root, "commit", "-m", "init");
  writeFileSync(join(root, ".env"), "KEY=1\n");
  writeFileSync(join(root, "secret.db"), "data");
  return { base, root, home };
}

describe("createWorktree", () => {
  test("makes a branch in ezcoder's layout, records the fork point and carries only allowlisted config", async () => {
    const { root, home } = repo();
    // A dirty main checkout is left exactly as it was.
    writeFileSync(join(root, "a.txt"), "edited by another agent");
    const made = await createWorktree({ repoRoot: root, branch: "Add dark mode!", home });
    if (!made.ok) throw new Error(made.error);
    const expected = realpathSync(
      join(home, ".ezcoder", "worktrees", "triten-os", "add-dark-mode"),
    );
    expect(made.value).toMatchObject({
      path: expected,
      branch: "add-dark-mode",
      baseRef: "main",
      root,
      repo: "triten-os",
      carried: [".env"],
    });
    expect(readFileSync(join(made.value.path, ".env"), "utf8")).toBe("KEY=1\n");
    expect(existsSync(join(made.value.path, "secret.db"))).toBe(false);
    expect(readFileSync(join(made.value.path, "a.txt"), "utf8")).toBe("a");
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("edited by another agent");
    expect(
      readFileSync(join(root, ".git", "worktrees", "add-dark-mode", "ezcoder-base"), "utf8"),
    ).toBe("main\n");
    // Detection and the registry reader see it as the repo's branch.
    expect(await detectWorktree(made.value.path)).toEqual({
      repo: "triten-os",
      root,
      branch: "add-dark-mode",
    });
    expect(await registeredWorktrees(root)).toEqual([
      { path: made.value.path, branch: "add-dark-mode", gone: false },
    ]);
  });

  test("a taken name gets a suffix, and no name means ez/<time>", async () => {
    const { root, home } = repo();
    const first = await createWorktree({ repoRoot: root, branch: "fix login", home });
    const second = await createWorktree({ repoRoot: root, branch: "fix login", home });
    expect(first.ok && first.value.branch).toBe("fix-login");
    expect(second.ok && second.value.branch).toBe("fix-login-2");
    const unnamed = await createWorktree({ repoRoot: root, home, now: () => 36 ** 3 });
    expect(unnamed.ok && unnamed.value.branch).toBe("ez/1000");
    expect(unnamed.ok && unnamed.value.path).toEndWith(join("triten-os", "ez-1000"));
  });

  test("refuses a linked worktree and a non-repository", async () => {
    const { root, home, base } = repo();
    const made = await createWorktree({ repoRoot: root, branch: "one", home });
    if (!made.ok) throw new Error(made.error);
    const fromWorktree = await createWorktree({ repoRoot: made.value.path, home });
    expect(fromWorktree.ok).toBe(false);
    const plain = join(base, "plain");
    mkdirSync(plain);
    expect((await createWorktree({ repoRoot: plain, home })).ok).toBe(false);
  });
});

test("registeredWorktrees marks a deleted checkout gone and reads nothing for a plain folder", async () => {
  const { root, home, base } = repo();
  const made = await createWorktree({ repoRoot: root, branch: "temp", home });
  if (!made.ok) throw new Error(made.error);
  execFileSync("rm", ["-rf", made.value.path]);
  expect(await registeredWorktrees(root)).toEqual([
    { path: made.value.path, branch: "temp", gone: true },
  ]);
  expect(await registeredWorktrees(join(base, "nowhere"))).toEqual([]);
});

test("slugifyBranch and the carry allowlist", () => {
  expect(slugifyBranch("Fix the Login  bug")).toBe("fix-the-login-bug");
  expect(slugifyBranch("feature/Dark Mode")).toBe("feature/dark-mode");
  expect(slugifyBranch("../etc")).toBe("etc");
  expect(slugifyBranch("a..b")).toBe("");
  expect(slugifyBranch("x.lock")).toBe("");
  expect(slugifyBranch("!!!")).toBe("");
  expect(slugifyBranch("a".repeat(80)).length).toBeLessThanOrEqual(48);
  expect([".env", ".env.local", "test.env", ".npmrc", ".yarnrc.yml"].every(isCarryable)).toBe(true);
  expect(["secret.db", "id_rsa", ".envrc"].some(isCarryable)).toBe(false);
});
