/**
 * Make a new linked worktree the way ezcoder does, so voice can split work.
 *
 * Three requests for one repository in a row used to queue behind each other in
 * the one checkout, because a checkout is locked to one writing task at a time.
 * Running each in its own worktree is what ezcoder already does, and the layout
 * here is ezcoder's: `~/.ezcoder/worktrees/<repo>/<branch with / as ->`, a fresh
 * branch forked from the main checkout's current branch, and the fork point
 * written to `<gitdir>/ezcoder-base`. That way ezcoder's own reclaim and the
 * detection in `worktree.ts` treat these copies exactly like the ones it makes.
 *
 * Unlike `worktree.ts` this *does* spawn git. It runs only when the user asked
 * for new work, never at probe time, and `git worktree add` is not something to
 * reimplement by hand.
 *
 * A dirty main checkout is not a reason to refuse: `git worktree add` only reads
 * the base ref, so the main tree's in-flight edits stay untouched and the new
 * copy starts from the last commit. Not inheriting another agent's half-written
 * state is the whole point of the copy.
 */
import { execFile } from "node:child_process";
import { copyFile, lstat, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { branchFromHead } from "./worktree.js";

const GIT_TIMEOUT_MS = 30_000;
const MAX_COLLISION_ATTEMPTS = 20;
/** Branch names stay sayable: a whole sentence is not a branch. */
const MAX_BRANCH_LENGTH = 48;

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export interface CreatedWorktree {
  /** The new checkout. */
  path: string;
  branch: string;
  /** The ref it was forked from. */
  baseRef: string;
  /** The main checkout it belongs to. */
  root: string;
  /** Folder name of the repository, what people call it. */
  repo: string;
  /** Ignored config files copied across (`.env`, `.npmrc`…), repo-relative. */
  carried: string[];
}

export interface CreateWorktreeOptions {
  /** The repository's main checkout. A linked worktree or a non-repo is refused. */
  repoRoot: string;
  /** Wanted branch name, in any words; slugified. Absent means `ez/<time>`. */
  branch?: string;
  home?: string;
  now?: () => number;
  signal?: AbortSignal;
}

function git(
  cwd: string,
  args: readonly string[],
  signal?: AbortSignal,
  readOnly = true,
): Promise<string> {
  return new Promise((done, fail) => {
    execFile(
      "git",
      [...args],
      {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
        signal,
        env: readOnly ? { ...process.env, GIT_OPTIONAL_LOCKS: "0" } : process.env,
      },
      (error, stdout, stderr) => {
        if (error) fail(new Error(String(stderr).trim() || error.message));
        else done(String(stdout));
      },
    );
  });
}

async function gitOrUndefined(
  cwd: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    return (await git(cwd, args, signal)).trim() || undefined;
  } catch {
    return undefined;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Normalise any words into a branch name git accepts, or "" when nothing usable
 * survives. Ported from ezcoder's `slugifyBranch`, plus a length cap.
 */
export function slugifyBranch(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9._/-]+/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/\/{2,}/g, "/")
    .slice(0, MAX_BRANCH_LENGTH)
    .replace(/^[-./]+/, "")
    .replace(/[-./]+$/, "");
  if (!slug || slug.includes("..")) return "";
  if (slug.split("/").some((part) => !part || part.endsWith(".lock") || part.startsWith(".")))
    return "";
  return slug;
}

/** `<home>/.ezcoder/worktrees/<basename(repoRoot)>`, ezcoder's own folder for this repo. */
export function worktreesRootFor(repoRoot: string, home: string = homedir()): string {
  return join(home, ".ezcoder", "worktrees", basename(resolve(repoRoot)));
}

/** The admin directory git made for a worktree, read from its `.git` file. */
async function adminDirOf(worktreePath: string): Promise<string | undefined> {
  try {
    const line = (await readFile(join(worktreePath, ".git"), "utf8"))
      .split(/\r?\n/)
      .find((l) => l.startsWith("gitdir:"));
    const target = line?.slice("gitdir:".length).trim();
    if (!target) return undefined;
    return isAbsolute(target) ? target : resolve(worktreePath, target);
  } catch {
    return undefined;
  }
}

export async function createWorktree(
  options: CreateWorktreeOptions,
): Promise<Result<CreatedWorktree>> {
  const { signal } = options;
  const root = resolve(options.repoRoot);
  try {
    if (!(await stat(join(root, ".git"))).isDirectory()) {
      return {
        ok: false,
        error: `${basename(root)} is itself a worktree; make the new one from its main checkout.`,
      };
    }
  } catch {
    return { ok: false, error: `${basename(root)} is not a git repository.` };
  }

  // The branch the main checkout is on, else its commit when HEAD is detached.
  const head = branchFromHead(
    await readFile(join(root, ".git", "HEAD"), "utf8").catch(() => undefined),
  );
  const baseRef = head ?? (await gitOrUndefined(root, ["rev-parse", "--verify", "HEAD"], signal));
  if (!baseRef)
    return {
      ok: false,
      error: `${basename(root)} has no commits yet, so there is nothing to branch from.`,
    };

  const now = options.now ?? Date.now;
  const requested = options.branch ? slugifyBranch(options.branch) : "";
  const base = requested || `ez/${now().toString(36)}`;
  const container = worktreesRootFor(root, options.home);

  for (let attempt = 1; attempt <= MAX_COLLISION_ATTEMPTS; attempt++) {
    const branch = attempt === 1 ? base : `${base}-${attempt}`;
    const target = join(container, branch.replace(/\//g, "-"));
    const taken =
      (await gitOrUndefined(
        root,
        ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
        signal,
      )) !== undefined;
    if (taken || (await exists(target))) continue;
    try {
      await mkdir(container, { recursive: true });
      // `--` would end options before the path; the branch is already slugified
      // and cannot start with "-", so plain argument order is safe here.
      await git(root, ["worktree", "add", "-b", branch, target, baseRef], signal, false);
    } catch (error) {
      return {
        ok: false,
        error: `git could not make the worktree: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const admin = await adminDirOf(target);
    // Best effort, like ezcoder: a copy without the file still works, it is only
    // judged against the main branch when reclaimed.
    if (admin)
      await writeFile(join(admin, "ezcoder-base"), `${baseRef}\n`, "utf8").catch(() => undefined);
    const carried = await carryIgnoredConfig(root, target, signal);
    const path = await realpath(target).catch(() => target);
    return { ok: true, value: { path, branch, baseRef, root, repo: basename(root), carried } };
  }
  return {
    ok: false,
    error: `No free branch name for "${base}" after ${MAX_COLLISION_ATTEMPTS} tries.`,
  };
}

// ---- carrying ignored config -------------------------------------------------

/** Config is tiny; anything bigger is data, not config. */
const CARRY_MAX_BYTES = 64 * 1024;

/**
 * Ignored files whose absence breaks a build, matched by basename. An
 * allowlist on purpose (ezcoder's): "every small ignored file" also sweeps up
 * local databases, keys and editor state.
 */
const CARRY_PATTERNS: readonly RegExp[] = [
  /^\.env($|\.)/i,
  /\.env$/i,
  /^\.npmrc$/i,
  /^\.yarnrc(\.yml)?$/i,
];

export function isCarryable(name: string): boolean {
  return CARRY_PATTERNS.some((pattern) => pattern.test(name));
}

function inside(base: string, candidate: string): boolean {
  const rel = relative(base, candidate);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Copy allowlisted ignored config from the main checkout into the new one.
 * Never throws: a worktree missing its `.env` is still a worktree, and the
 * agent can be told so.
 */
async function carryIgnoredConfig(
  root: string,
  target: string,
  signal?: AbortSignal,
): Promise<string[]> {
  let listed: string;
  try {
    // `--directory` collapses a wholly ignored folder (node_modules) to one entry.
    listed = await git(
      root,
      ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"],
      signal,
    );
  } catch {
    return [];
  }
  const carried: string[] = [];
  const candidates = listed
    .split("\0")
    .filter((rel) => rel && !rel.endsWith("/") && isCarryable(basename(rel)))
    .sort();
  for (const rel of candidates) {
    const from = resolve(root, rel);
    const to = resolve(target, rel);
    if (!inside(root, from) || !inside(target, to)) continue;
    try {
      const info = await lstat(from);
      // A symlink could point anywhere; only plain small files are config.
      if (!info.isFile() || info.size > CARRY_MAX_BYTES || (await exists(to))) continue;
      await mkdir(dirname(to), { recursive: true });
      await copyFile(from, to);
      carried.push(rel);
    } catch {
      // Skipped, not fatal.
    }
  }
  return carried;
}
