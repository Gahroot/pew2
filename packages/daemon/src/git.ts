/**
 * What the session is working on, as a phone-sized fact: which project folder,
 * and how much work is uncommitted in it.
 *
 * The path an agent runs in is the one piece of context the phone cannot see
 * for itself, and "am I about to prompt against a dirty tree?" is the question
 * that decides whether the next instruction is safe. Only this machine has the
 * repository, so the answer is computed here and shipped as two numbers.
 *
 * Git is asked, never reimplemented, and a failure is an answer: a directory
 * that is not a repository is normal (an agent opened on a scratch folder) and
 * must read as "no repo", not as an error the user has to dismiss.
 */
import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";
import { detectWorktree, type WorktreeInfo } from "./worktree.js";

const run = promisify(execFile);

export interface WorkspaceStatus {
  cwd: string;
  /** Last path segment — what people call the project. */
  folder: string;
  /** False when `cwd` is not inside a git working tree. */
  repo: boolean;
  /** Entries `git status` reports as changed, staged or untracked. */
  uncommitted: number;
  /** The checked-out branch; absent when detached or not a repo. */
  branch?: string;
  /** Set when `cwd` is a linked worktree, naming the repository it belongs to. */
  worktree?: WorktreeInfo;
}

/**
 * The branch from `git status --branch`'s `## ` header line.
 *
 * Branch names cannot contain spaces or `..`, so the name ends at the first
 * of either: `## main...origin/main [ahead 1]`. A detached HEAD reads
 * `## HEAD (no branch)` and a fresh repo `## No commits yet on main`.
 */
export function parseStatusBranch(header: string | undefined): string | undefined {
  if (!header?.startsWith("## ")) return undefined;
  const rest = header.slice(3).trim();
  const unborn = rest.match(/^(?:No commits yet|Initial commit) on (\S+)$/);
  if (unborn) return unborn[1];
  if (rest.startsWith("HEAD (no branch)")) return undefined;
  const name = rest.split(/\.\.\.|\s/)[0];
  return name || undefined;
}

/**
 * Count porcelain entries.
 *
 * One line per path, and untracked directories are already collapsed to a
 * single entry by git itself, so a fresh `node_modules` counts once rather
 * than fifty thousand times.
 */
export function countPorcelain(stdout: string): number {
  return stdout.split("\n").filter((line) => line.trim().length > 0).length;
}

/**
 * Status of the working tree an agent session is running in.
 *
 * Never throws. `git` may be missing, the directory may not be a repository, or
 * the repo may be enormous — all of which produce "not a repo" rather than a
 * failed request, because this is decoration beside a text field.
 */
export async function workspaceStatus(cwd: string): Promise<WorkspaceStatus> {
  const folder = basename(cwd) || cwd;
  try {
    // `--branch` adds one `## ` header line: the branch rides on the same spawn.
    const { stdout } = await run("git", ["status", "--porcelain", "--branch"], {
      cwd,
      // A pathological repo must not hold the socket open; the bar simply says
      // nothing about git in that case.
      timeout: 5_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const lines = stdout.split("\n");
    const header = lines[0]?.startsWith("## ") ? lines.shift() : undefined;
    const branch = parseStatusBranch(header);
    // Git already ran in this directory at the user's request, so reading its
    // `.git` file cannot raise a privacy prompt that git itself did not.
    const worktree = await detectWorktree(cwd, { allowGuarded: true });
    return {
      cwd,
      folder,
      repo: true,
      uncommitted: countPorcelain(lines.join("\n")),
      ...(branch ? { branch } : null),
      ...(worktree ? { worktree } : null),
    };
  } catch {
    return { cwd, folder, repo: false, uncommitted: 0 };
  }
}
