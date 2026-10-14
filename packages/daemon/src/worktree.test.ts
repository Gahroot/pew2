import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { annotateWorktrees, branchFromHead, detectWorktree, linkWorktreeRoots, privacyGuarded, worktreeLabel, type WorktreeInfo } from "./worktree.js";

function git(cwd: string, ...args: string[]) {
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "init.defaultBranch=main", ...args], {
    cwd,
    stdio: "ignore",
  });
}

/** A repo with one commit and a linked worktree on `fix/login`, laid out like ezcoder's. */
function repoWithWorktree(at = ["worktrees", "billing", "ez-mun7ig9t"]) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "pew2-wt-")));
  const root = join(base, "billing");
  mkdirSync(root);
  git(root, "init");
  writeFileSync(join(root, "a.txt"), "a");
  git(root, "add", ".");
  git(root, "commit", "-m", "init");
  const tree = join(base, ...at);
  git(root, "worktree", "add", "-b", "fix/login", tree);
  return { base, root, tree };
}

describe("detectWorktree", () => {
  test("names the repository, main checkout and branch of a linked worktree", async () => {
    const { root, tree } = repoWithWorktree();
    expect(await detectWorktree(tree)).toEqual({ repo: "billing", root, branch: "fix/login" });
    // An agent may run in a subfolder; the worktree is still found.
    mkdirSync(join(tree, "src"));
    expect((await detectWorktree(join(tree, "src")))?.repo).toBe("billing");
  });

  test("a main checkout, a plain folder and a relative path are not worktrees", async () => {
    const { base, root } = repoWithWorktree();
    expect(await detectWorktree(root)).toBeUndefined();
    expect(await detectWorktree(mkdtempSync(join(tmpdir(), "pew2-plain-")))).toBeUndefined();
    expect(await detectWorktree("relative/path")).toBeUndefined();
    expect(await detectWorktree(join(base, "missing"))).toBeUndefined();
  });

  test("a detached worktree has no branch", async () => {
    const { root, base } = repoWithWorktree();
    const detached = join(base, "detached");
    git(root, "worktree", "add", "--detach", detached);
    expect(await detectWorktree(detached)).toEqual({ repo: "billing", root });
  });

  test("a submodule's .git file and a dangling pointer are not worktrees", async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "pew2-wt-")));
    const sub = join(base, "sub");
    mkdirSync(join(base, ".git", "modules", "sub"), { recursive: true });
    mkdirSync(sub);
    writeFileSync(join(sub, ".git"), "gitdir: ../.git/modules/sub\n");
    expect(await detectWorktree(sub)).toBeUndefined();

    const gone = join(base, "gone");
    mkdirSync(gone);
    writeFileSync(join(gone, ".git"), `gitdir: ${join(base, "deleted", ".git", "worktrees", "gone")}\n`);
    expect(await detectWorktree(gone)).toBeUndefined();
  });

  test("macOS-guarded folders are left alone unless the caller opts in", async () => {
    const home = "/Users/someone";
    expect(privacyGuarded(`${home}/Documents/api`, home, "darwin")).toBe(true);
    expect(privacyGuarded("/Volumes/work/api", home, "darwin")).toBe(true);
    expect(privacyGuarded(`${home}/.ezcoder/worktrees/api/ez-1`, home, "darwin")).toBe(false);
    expect(privacyGuarded(`${home}/DocumentsArchive`, home, "darwin")).toBe(false);
    expect(privacyGuarded(`${home}/Documents/api`, home, "linux")).toBe(false);

    // A worktree under `<home>/Documents`: skipped at probe time, read on request.
    const { tree, base } = repoWithWorktree(["Documents", "ez-1"]);
    expect(await detectWorktree(tree, { home: base, platform: "darwin" })).toBeUndefined();
    expect((await detectWorktree(tree, { home: base, platform: "darwin", allowGuarded: true }))?.repo).toBe("billing");
  });
});

test("branchFromHead reads symbolic refs only", () => {
  expect(branchFromHead("ref: refs/heads/ez/mun7ig9t\n")).toBe("ez/mun7ig9t");
  expect(branchFromHead("0123456789abcdef0123456789abcdef01234567\n")).toBeUndefined();
  expect(branchFromHead(undefined)).toBeUndefined();
});

test("annotateWorktrees labels only the worktrees and keeps order", async () => {
  const projects = [{ path: "/a", name: "a" }, { path: "/b", name: "b" }];
  const annotated = await annotateWorktrees(projects, async (path) =>
    path === "/b" ? { repo: "api", branch: "fix/x" } : undefined,
  );
  expect(annotated).toEqual([{ path: "/a", name: "a" }, { path: "/b", name: "b", worktree: { repo: "api", branch: "fix/x" } }]);
  expect(worktreeLabel("ez-1", { repo: "api" })).toBe("api (ez-1)");
});

describe("a deleted ezcoder checkout", () => {
  /** A fake home holding ezcoder's worktree folder, and a main checkout beside it. */
  function ezHome() {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "pew2-home-")));
    mkdirSync(join(home, ".ezcoder", "worktrees", "billing"), { recursive: true });
    return { home, worktrees: join(home, ".ezcoder", "worktrees", "billing") };
  }

  test("is still filed under its repo, and marked gone", async () => {
    const { home, worktrees } = ezHome();
    expect(await detectWorktree(join(worktrees, "ez-mun7ig9t"), { home })).toEqual({ repo: "billing", gone: true });
    // A subfolder an agent ran in is the same checkout.
    expect(await detectWorktree(join(worktrees, "ez-mun7ig9t", "packages", "app"), { home })).toEqual({ repo: "billing", gone: true });
  });

  test("a folder that survived without its .git is the repo's, not gone", async () => {
    const { home, worktrees } = ezHome();
    mkdirSync(join(worktrees, "tmp"));
    expect(await detectWorktree(join(worktrees, "tmp"), { home })).toEqual({ repo: "billing" });
  });

  test("git's own files win over the layout, and a repo of its own there is not a worktree", async () => {
    const { home, worktrees } = ezHome();
    const own = join(worktrees, "standalone");
    mkdirSync(own);
    git(own, "init");
    expect(await detectWorktree(own, { home })).toBeUndefined();
    // Outside the folder the layout means nothing.
    expect(await detectWorktree(join(home, "elsewhere", "ez-1"), { home })).toBeUndefined();
  });

  test("a home directory kept in git does not hide the layout", async () => {
    const { home, worktrees } = ezHome();
    git(home, "init");
    expect(await detectWorktree(join(worktrees, "ez-gone"), { home })).toEqual({ repo: "billing", gone: true });
  });
});

describe("linkWorktreeRoots", () => {
  test("a worktree that cannot name its checkout gets the one project with its repo's name", () => {
    const linked = linkWorktreeRoots<{ path: string; name: string; worktree?: WorktreeInfo }>([
      { path: "/code/billing", name: "billing" },
      { path: "/wt/billing/ez-1", name: "ez-1", worktree: { repo: "billing", gone: true } },
    ]);
    expect(linked[1]?.worktree).toEqual({ repo: "billing", gone: true, root: "/code/billing" });
  });

  test("two checkouts with that name are a coin toss, so neither is guessed", () => {
    const linked = linkWorktreeRoots([
      { path: "/work/api", name: "api" },
      { path: "/oss/api", name: "api" },
      { path: "/wt/api/ez-1", name: "ez-1", worktree: { repo: "api" } },
    ]);
    expect(linked[2]?.worktree).toEqual({ repo: "api" });
  });

  test("a root git named is never replaced", () => {
    const linked = linkWorktreeRoots([
      { path: "/code/billing", name: "billing" },
      { path: "/wt/ez-1", name: "ez-1", worktree: { repo: "billing", root: "/elsewhere/billing" } },
    ]);
    expect(linked[1]?.worktree?.root).toBe("/elsewhere/billing");
  });
});
