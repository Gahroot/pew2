import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { countPorcelain, parseStatusBranch, workspaceStatus } from "./git.js";

describe("countPorcelain", () => {
  test("counts one entry per line", () => {
    expect(countPorcelain(" M src/a.ts\n?? src/b.ts\nA  src/c.ts\n")).toBe(3);
  });

  test("a clean tree is zero, not one empty line", () => {
    expect(countPorcelain("")).toBe(0);
    expect(countPorcelain("\n")).toBe(0);
  });
});

describe("workspaceStatus", () => {
  test("names the folder and reports the repo it is in", async () => {
    // This project is itself a git checkout, which is the case the bar shows.
    const status = await workspaceStatus(process.cwd());
    expect(status.repo).toBe(true);
    expect(status.folder).toBe(basename(process.cwd()));
    expect(status.uncommitted).toBeGreaterThanOrEqual(0);
  });

  test("a directory outside any repo is not an error", async () => {
    // An agent opened on a scratch folder is normal; the bar simply omits the
    // change count rather than the request failing.
    const scratch = mkdtempSync(join(tmpdir(), "pew2-git-"));
    const status = await workspaceStatus(scratch);
    expect(status.repo).toBe(false);
    expect(status.uncommitted).toBe(0);
    expect(status.folder.startsWith("pew2-git-")).toBe(true);
  });
});

describe("parseStatusBranch", () => {
  test("reads the branch from git's header line in each of its shapes", () => {
    expect(parseStatusBranch("## main...origin/main [ahead 1]")).toBe("main");
    expect(parseStatusBranch("## ez/mun7ig9t")).toBe("ez/mun7ig9t");
    expect(parseStatusBranch("## No commits yet on main")).toBe("main");
    expect(parseStatusBranch("## HEAD (no branch)")).toBeUndefined();
    expect(parseStatusBranch(" M src/a.ts")).toBeUndefined();
  });
});

test("a worktree reports its branch, its repository, and only real changes", async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "pew2-git-wt-")));
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "init.defaultBranch=main", ...args], { cwd, stdio: "ignore" });
  const root = join(base, "billing");
  mkdirSync(root);
  git(root, "init");
  writeFileSync(join(root, "a.txt"), "a");
  git(root, "add", ".");
  git(root, "commit", "-m", "init");
  const tree = join(base, "ez-1");
  git(root, "worktree", "add", "-b", "fix/login", tree);
  writeFileSync(join(tree, "b.txt"), "b");

  const status = await workspaceStatus(tree);
  // The `## ` header is the branch, not an uncommitted file.
  expect(status).toMatchObject({ repo: true, uncommitted: 1, branch: "fix/login", worktree: { repo: "billing", root } });
  const main = await workspaceStatus(root);
  expect(main).toMatchObject({ uncommitted: 0, branch: "main" });
  expect(main.worktree).toBeUndefined();
});
