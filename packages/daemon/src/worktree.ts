/**
 * Is this project a linked git worktree, and of which repository?
 *
 * Agents that isolate their work — ezcoder's `~/.ezcoder/worktrees/<repo>/ez-<id>`,
 * Claude Code's `--worktree`, a hand-made `git worktree add` — run sessions in a
 * second checkout of an existing repo. Folded by path, each one reads as an
 * unrelated project named `ez-mun7ig9t`: the phone cannot tell it belongs to
 * `black-mountain-fund`, and the voice model cannot say it, match it, or group
 * it with the repo the user actually names.
 *
 * Answered from the files git itself writes, never by spawning git: this runs
 * over every project an agent has history in, at probe time, and a process per
 * project is the cost the probe was redesigned to avoid. The layout is fixed by
 * git: a worktree's `.git` is a *file* (`gitdir: <common>/worktrees/<name>`),
 * and that admin directory names the shared one in `commondir`. A submodule's
 * `.git` is also a file but points into `modules/`, which is why the
 * `worktrees` parent is checked rather than "is a file".
 *
 * Never throws: an unreadable or half-deleted worktree is simply "not one".
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

export interface WorktreeInfo {
  /** Folder name of the repository it belongs to — what people call the project. */
  repo: string;
  /**
   * The main checkout, when there is one. Absent for a worktree of a bare
   * repository, which has no working tree of its own to offer.
   */
  root?: string;
  /** The checked-out branch; absent when HEAD is detached. */
  branch?: string;
  /**
   * The checkout no longer exists. ezcoder deletes a task's worktree when the
   * task is merged or discarded, but the agent's history keeps every session
   * that ran there: those conversations still belong to the repository, and
   * nothing new can be started in the folder.
   */
  gone?: boolean;
}

/** How far up from a session's cwd to look for `.git` (an agent may run in a subfolder). */
const MAX_ASCENT = 32;

/**
 * Folders macOS guards with a consent prompt.
 *
 * This runs over paths the *agent* chose, unprompted, every probe. Reading one
 * `.git` file under `~/Documents` would make macOS ask the user to let pew2 into
 * Documents — the exact prompt storm `suggestionRoots` exists to prevent. A
 * project there simply goes unlabelled; `workspaceStatus` opts back in, because
 * it already runs git in that directory at the user's request.
 */
const GUARDED_HOME_FOLDERS = ["Desktop", "Documents", "Downloads", "Library", "Movies", "Music", "Pictures"];

export function privacyGuarded(
  path: string,
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== "darwin") return false;
  const target = resolve(path);
  const under = (base: string) => target === base || target.startsWith(base + sep);
  if (under("/Volumes")) return true;
  return GUARDED_HOME_FOLDERS.some((folder) => under(join(resolve(home), folder)));
}

async function readSmall(path: string): Promise<string | undefined> {
  try {
    const text = await readFile(path, "utf8");
    // These files are one line; anything large is not what git wrote.
    return text.length > 4096 ? undefined : text;
  } catch {
    return undefined;
  }
}

/** `ref: refs/heads/<branch>` -> branch; a detached SHA -> undefined. */
export function branchFromHead(head: string | undefined): string | undefined {
  const match = head?.trim().match(/^ref:\s*refs\/heads\/(.+)$/);
  return match?.[1]?.trim() || undefined;
}

export interface DetectOptions {
  home?: string;
  platform?: NodeJS.Platform;
  /** Look even inside macOS-guarded folders (the caller already touched the directory). */
  allowGuarded?: boolean;
}

/** Where ezcoder keeps the checkouts it makes: `<home>/.ezcoder/worktrees/<repo>/<name>`. */
const EZCODER_WORKTREES = [".ezcoder", "worktrees"];

/**
 * A path in ezcoder's worktree folder, read from the layout alone.
 *
 * Git's own files are the better witness and win whenever they exist (see
 * `detectWorktree`). This is for when they don't: once a task's checkout is
 * deleted, its `.git` file goes with it, and without this every one of those
 * sessions comes back as a stranger project called `ez-mun7ig9t`. The repo is
 * the folder ezcoder filed it under; the main checkout is found later by name
 * (`linkWorktreeRoots`), because the layout does not record it.
 */
export async function ezcoderWorktree(path: string, home: string = homedir()): Promise<WorktreeInfo | undefined> {
  if (!isAbsolute(path)) return undefined;
  const base = join(resolve(home), ...EZCODER_WORKTREES);
  const target = resolve(path);
  if (!target.startsWith(base + sep)) return undefined;
  const [repo, folder] = target.slice(base.length + 1).split(sep);
  if (!repo || !folder) return undefined;
  const exists = await stat(join(base, repo, folder)).then(
    (info) => info.isDirectory(),
    () => false,
  );
  return exists ? { repo } : { repo, gone: true };
}

/** The worktree `path` sits in, or undefined for a main checkout, a non-repo, or anything unreadable. */
export async function detectWorktree(path: string, options: DetectOptions = {}): Promise<WorktreeInfo | undefined> {
  if (!path?.trim() || !isAbsolute(path)) return undefined;
  if (!options.allowGuarded && privacyGuarded(path, options.home, options.platform)) return undefined;
  const found = await fromGitFiles(path);
  if (found && "repo" in found) return found;
  const conventional = await ezcoderWorktree(path, options.home);
  // A real repository *inside* the checkout's folder outranks the layout; one
  // found above it (a home directory kept in git) says nothing about it.
  if (conventional && found && isWithin(found.mainCheckout, ezcoderFolder(path, options.home))) return undefined;
  return conventional;
}

function isWithin(path: string, base: string | undefined): boolean {
  return base !== undefined && (path === base || path.startsWith(base + sep));
}

/** `<home>/.ezcoder/worktrees/<repo>/<name>` for a path at or under one. */
function ezcoderFolder(path: string, home: string = homedir()): string | undefined {
  const base = join(resolve(home), ...EZCODER_WORKTREES);
  const [repo, folder] = resolve(path).slice(base.length + 1).split(sep);
  return repo && folder ? join(base, repo, folder) : undefined;
}

/** A worktree, the main checkout that was found instead, or nothing at all. */
async function fromGitFiles(path: string): Promise<WorktreeInfo | { mainCheckout: string } | undefined> {
  let dir = resolve(path);
  for (let step = 0; step < MAX_ASCENT; step++) {
    const dotGit = join(dir, ".git");
    let kind: "dir" | "file" | undefined;
    try {
      const info = await stat(dotGit);
      kind = info.isDirectory() ? "dir" : info.isFile() ? "file" : undefined;
    } catch {
      kind = undefined;
    }
    // A `.git` directory is a main checkout: the nearest repository is not a worktree.
    if (kind === "dir") return { mainCheckout: dir };
    if (kind === "file") return fromDotGitFile(dir, dotGit);
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

async function fromDotGitFile(dir: string, dotGit: string): Promise<WorktreeInfo | undefined> {
  const line = (await readSmall(dotGit))?.split(/\r?\n/).find((l) => l.startsWith("gitdir:"));
  const target = line?.slice("gitdir:".length).trim();
  if (!target) return undefined;
  const gitdir = isAbsolute(target) ? target : resolve(dir, target);
  // `modules/<name>` is a submodule — its own repository, not a second checkout.
  if (basename(dirname(gitdir)) !== "worktrees") return undefined;

  const pointer = (await readSmall(join(gitdir, "commondir")))?.trim();
  const common = pointer ? (isAbsolute(pointer) ? pointer : resolve(gitdir, pointer)) : dirname(dirname(gitdir));
  try {
    // A worktree whose repository was deleted or moved points at nothing.
    if (!(await stat(common)).isDirectory()) return undefined;
  } catch {
    return undefined;
  }

  const branch = branchFromHead(await readSmall(join(gitdir, "HEAD")));
  if (basename(common) === ".git") {
    const root = dirname(common);
    // Defensive: a pointer back at itself is not a second checkout.
    if (root === dir) return undefined;
    const repo = basename(root);
    return repo ? { repo, root, ...(branch ? { branch } : null) } : undefined;
  }
  // Bare repository (`api.git`): named without the suffix, with no checkout to offer.
  const repo = basename(common).replace(/\.git$/, "");
  return repo ? { repo, ...(branch ? { branch } : null) } : undefined;
}

/**
 * The same list, with `worktree` set on every project that is one.
 *
 * Lookups run concurrently: each is a handful of `stat`s, and a provider with
 * hundreds of projects should not pay for them one after another.
 */
export async function annotateWorktrees<T extends { path: string; name: string }>(
  projects: readonly T[],
  detect: (path: string) => Promise<WorktreeInfo | undefined> = (path) => detectWorktree(path),
): Promise<(T & { worktree?: WorktreeInfo })[]> {
  const found = await Promise.all(projects.map((project) => detect(project.path).catch(() => undefined)));
  return linkWorktreeRoots(
    projects.map((project, index) => {
      const worktree = found[index];
      return worktree ? { ...project, worktree } : project;
    }),
  );
}

/**
 * Fill in the main checkout of a worktree that could not name its own.
 *
 * A deleted ezcoder checkout knows only the repo's folder name. When exactly
 * one ordinary project in the same list has that name, that is the checkout it
 * came from; two (`~/work/api` and `~/oss/api`) is a coin toss, and a wrong
 * guess would file one repo's history under another, so it is left unlinked
 * and grouped by name alone.
 */
export function linkWorktreeRoots<T extends { path: string; name: string; worktree?: WorktreeInfo }>(projects: readonly T[]): T[] {
  const checkouts = new Map<string, string[]>();
  for (const project of projects) {
    if (project.worktree) continue;
    checkouts.set(project.name, [...(checkouts.get(project.name) ?? []), project.path]);
  }
  return projects.map((project) => {
    const worktree = project.worktree;
    if (!worktree || worktree.root) return project;
    const matches = checkouts.get(worktree.repo);
    const root = matches?.length === 1 ? matches[0] : undefined;
    return root ? { ...project, worktree: { ...worktree, root } } : project;
  });
}

export interface RegisteredWorktree {
  /** The linked checkout, as git recorded it. */
  path: string;
  branch?: string;
  /** Git still lists it but the folder is gone (deleted by hand or by ezcoder). */
  gone: boolean;
}

/** The most entries read from one repository's `.git/worktrees`. */
const MAX_REGISTERED = 200;

/**
 * Every linked worktree git has on record for the main checkout at `root`,
 * read from `<root>/.git/worktrees/<name>/{gitdir,HEAD}` — never by spawning
 * git, for the same reason as the rest of this module.
 *
 * Agent history only knows the checkouts an agent was *asked about*; a copy
 * ezcoder made for a task the phone never saw would otherwise be a stranger.
 * Sorted by path so the answer is the same on every call. Never throws.
 */
export async function registeredWorktrees(root: string): Promise<RegisteredWorktree[]> {
  const admin = join(resolve(root), ".git", "worktrees");
  let names: string[];
  try {
    names = (await readdir(admin)).filter((name) => !name.startsWith(".")).sort().slice(0, MAX_REGISTERED);
  } catch {
    return [];
  }
  const found = await Promise.all(
    names.map(async (name): Promise<RegisteredWorktree | undefined> => {
      // `gitdir` holds the path of the checkout's own `.git` file.
      const pointer = (await readSmall(join(admin, name, "gitdir")))?.trim();
      if (!pointer || !isAbsolute(pointer)) return undefined;
      const path = dirname(pointer);
      const branch = branchFromHead(await readSmall(join(admin, name, "HEAD")));
      const gone = !(await stat(pointer).then(
        (info) => info.isFile(),
        () => false,
      ));
      return { path, ...(branch ? { branch } : null), gone };
    }),
  );
  return found.filter((entry): entry is RegisteredWorktree => entry !== undefined).sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * "black-mountain-fund (fix/login)" — how a worktree is named to a person.
 *
 * The branch says what the checkout is *for*; the folder (`ez-mun7ig9t`) is
 * the fallback when HEAD is detached.
 */
export function worktreeLabel(folder: string, worktree: WorktreeInfo): string {
  return `${worktree.repo} (${worktree.branch ?? folder})`;
}
