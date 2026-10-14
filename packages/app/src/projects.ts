/**
 * Which project the drawer is showing, and which one a new conversation opens
 * in.
 *
 * The history list is a recent-work switcher: the newest conversations across
 * everything this agent has done. That answers "what was I just doing" and
 * nothing else — a repo touched last month has no rows in it at all, so there
 * was no way to say "work on *that* one" without going back to the desk. The
 * project selector is that missing axis, and it does two jobs at once: it
 * narrows the list, and it decides where the next session starts.
 *
 * The daemon folds projects from the agent's *whole* session list, which is
 * why they arrive separately from `sessions` rather than being grouped from
 * it here. This module still derives them from whatever sessions it can see,
 * as a fallback for an older daemon and so a project used seconds ago appears
 * before the next probe lands.
 *
 * Pure and react-free: the matching rules below are the fiddly part and are
 * directly testable.
 */
import { folderName } from "./projectFolder";
import type { Session } from "./useDaemon";

/**
 * A linked git worktree: a second checkout of an existing repository.
 *
 * ezcoder runs each task in `~/.ezcoder/worktrees/<repo>/ez-<id>`, so by folder
 * name alone the drawer filled with projects called `ez-mun7ig9t` that nobody
 * could place. The daemon names the repository and branch; absent from older
 * daemons, in which case the folder name is all there is.
 */
export interface ProjectWorktree {
  /** Folder name of the repository it belongs to. */
  repo: string;
  /** The main checkout's path, when there is one. */
  root?: string;
  /** Checked-out branch; absent when detached. */
  branch?: string;
  /** The checkout was deleted; its conversations remain, nothing new starts there. */
  gone?: boolean;
}

/** Only the fields we understand, and only when they are the right shape. */
export function readWorktree(raw: unknown): ProjectWorktree | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const { repo, root, branch, gone } = raw as Record<string, unknown>;
  if (typeof repo !== "string" || !repo.trim()) return undefined;
  return {
    repo,
    ...(typeof root === "string" && root ? { root } : null),
    ...(typeof branch === "string" && branch ? { branch } : null),
    ...(gone === true ? { gone: true } : null),
  };
}

/**
 * What the user calls a project: its repository's name, set apart by its
 * parent folder only when two would otherwise read the same.
 *
 * Display only — `name` stays the folder, because it is what a session's
 * folder stamp is matched against in `sessionInProject`. A lone worktree
 * (from a caller that did not group) reads "repo · branch".
 */
export function projectTitle(project: { name: string; title?: string; worktree?: ProjectWorktree }): string {
  if (project.title) return project.title;
  const worktree = project.worktree;
  return worktree ? `${worktree.repo} · ${worktree.branch ?? project.name}` : project.name;
}

/** One worktree of a project: a second checkout of the same repository, on its own branch. */
export interface ProjectBranch {
  path: string;
  /** Folder name, matched against a session's folder stamp like `Project.name`. */
  name: string;
  /** What it is called inside its project: the branch, else the folder. Unique within the project. */
  label: string;
  sessions?: number;
  updatedAt?: string;
  /** Deleted: its conversations still list, but nothing new can start there. */
  gone?: boolean;
}

/** A project as the drawer offers it. */
export interface Project {
  /** Absolute path. The identity of a project everywhere, and what a new session is started with. */
  path: string;
  /** Last path segment: the project as people say it. */
  name: string;
  /** Conversations the agent holds in it, when the daemon counted them. */
  sessions?: number;
  /** ISO 8601 of the newest of those, for ordering. */
  updatedAt?: string;
  /** Set when the folder is a linked worktree of another repository. */
  worktree?: ProjectWorktree;
  /** Shown instead of `name` when two projects would read the same; see `projectTitle`. */
  title?: string;
  /**
   * Its worktrees, newest first. ezcoder makes one per task, so a repository
   * worked on for a month can own a dozen; they are this project's branches,
   * not projects of their own.
   */
  branches?: ProjectBranch[];
  /**
   * Every directory whose conversations belong here: `path`, each branch, and
   * any other spelling of `path` (`/code/x/`). Absent means just `path`.
   */
  paths?: string[];
}

/** As announced by the daemon, folded from the agent's full history. */
export interface WireProject {
  path: string;
  name: string;
  sessions?: number;
  updatedAt?: string;
  /** Unvalidated as it arrives; read through `readWorktree`. */
  worktree?: unknown;
}

/**
 * Every project this agent can be pointed at, newest work first.
 *
 * Two sources, unioned by path. The daemon's list is authoritative and
 * complete; the sessions on screen add anything newer than the last probe —
 * including the conversation started in this app a minute ago, which would
 * otherwise be filed under a project the menu does not yet offer.
 */
export function projectsForProvider(
  announced: WireProject[] | undefined,
  sessions: Session[],
  providerId: string | undefined,
): Project[] {
  if (!providerId) return [];

  const byPath = new Map<string, Project>();
  for (const project of announced ?? []) {
    if (!project.path || !project.name) continue;
    const { worktree: rawWorktree, ...rest } = project;
    const worktree = readWorktree(rawWorktree);
    byPath.set(project.path, { ...rest, ...(worktree ? { worktree } : null) });
  }

  for (const session of sessions) {
    if (session.providerId !== providerId) continue;
    const path = session.cwd;
    if (!path) continue;
    const name = folderName(path);
    if (!name) continue;
    // The daemon's count is over the agent's whole history; a session already
    // on screen is part of that count, so nothing is added to it here.
    //
    // A project the daemon has not announced yet gets its stamp from the
    // session itself, or a repo opened a minute ago would sort below every
    // dated one — last in a menu that promises newest first.
    if (!byPath.has(path)) {
      byPath.set(path, {
        path,
        name,
        updatedAt: Number.isFinite(session.startedAt)
          ? new Date(session.startedAt).toISOString()
          : undefined,
      });
    }
  }

  return groupProjects([...byPath.values()]);
}

const newestFirst = (a: { updatedAt?: string }, b: { updatedAt?: string }) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");

/** `/code/x` and `/code/x/` are one directory; the separator is not part of its identity. */
function pathKey(path: string): string {
  return path.replace(/[\\/]+$/, "") || path;
}

function newer(a?: string, b?: string): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

/**
 * One entry per repository, its worktrees folded in as branches, newest first.
 *
 * The flat list the daemon sends has one row per *directory*, and ezcoder
 * runs every task in a directory of its own: one real repo became a dozen
 * projects called `ez-mun7ig9t`, all burying the projects around them. Here a
 * worktree joins the project of its main checkout (which is added when no
 * agent ever ran in it directly), or, when the checkout is unknown, the other
 * worktrees of the same repo.
 *
 * And the list is checked so nothing in it can be confused for anything else:
 *  - two spellings of one path (`/code/x`, `/code/x/`) are one project;
 *  - two projects that would read the same (`~/work/api`, `~/oss/api`) are
 *    titled apart by their parent folder;
 *  - two branches that would read the same within a project are told apart
 *    by their folders.
 */
export function groupProjects(flat: readonly Project[]): Project[] {
  // 1. One entry per directory, however it was written.
  const byKey = new Map<string, Project & { paths: string[] }>();
  for (const project of flat) {
    const key = pathKey(project.path);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...project, paths: [project.path] });
      continue;
    }
    existing.paths.push(project.path);
    if (project.sessions !== undefined) existing.sessions = (existing.sessions ?? 0) + project.sessions;
    existing.updatedAt = newer(existing.updatedAt, project.updatedAt);
    existing.worktree ??= project.worktree;
  }
  const unique = [...byKey.values()];

  // 2. A worktree that cannot name its checkout takes the one project with its
  //    repo's name. Two candidates is a coin toss and is left alone.
  const checkoutsByName = new Map<string, string[]>();
  for (const p of unique) if (!p.worktree) checkoutsByName.set(p.name, [...(checkoutsByName.get(p.name) ?? []), p.path]);
  const rootOf = (worktree: ProjectWorktree): string | undefined => {
    if (worktree.root) return worktree.root;
    const matches = checkoutsByName.get(worktree.repo);
    return matches?.length === 1 ? matches[0] : undefined;
  };

  // 3. Fold worktrees into their repository.
  const groups = new Map<string, Project & { paths: string[]; branches: ProjectBranch[] }>();
  const groupFor = (key: string, seed: () => Project) => {
    let group = groups.get(key);
    if (!group) {
      const base = seed();
      group = { ...base, paths: [...(base.paths ?? [base.path])], branches: [] };
      groups.set(key, group);
    }
    return group;
  };
  // Checkouts first, so a worktree always finds its repository's real entry
  // rather than creating a stub the checkout would then have to replace.
  for (const p of unique) if (!p.worktree) groupFor(pathKey(p.path), () => p);
  for (const p of unique) {
    const worktree = p.worktree;
    if (!worktree) continue;
    const root = rootOf(worktree);
    const group = root
      ? groupFor(pathKey(root), () => ({ path: root, name: folderName(root) ?? worktree.repo, sessions: 0 }))
      : groupFor(`repo:${worktree.repo}`, () => ({ path: p.path, name: worktree.repo, sessions: 0 }));
    group.branches.push({
      path: p.path,
      name: p.name,
      label: worktree.branch ?? p.name,
      ...(p.sessions !== undefined ? { sessions: p.sessions } : null),
      ...(p.updatedAt ? { updatedAt: p.updatedAt } : null),
      ...(worktree.gone ? { gone: true } : null),
    });
    group.paths.push(...p.paths);
    if (p.sessions !== undefined) group.sessions = (group.sessions ?? 0) + p.sessions;
    group.updatedAt = newer(group.updatedAt, p.updatedAt);
  }

  const out: Project[] = [];
  for (const group of groups.values()) {
    const { branches, paths, ...rest } = group;
    const project: Project = { ...rest };
    if (branches.length > 0) {
      // Live branches first, newest first; deleted ones after them.
      branches.sort((a, b) => Number(a.gone ?? false) - Number(b.gone ?? false) || newestFirst(a, b));
      project.branches = labelsApart(branches);
      // With no main checkout to start in, a new chat goes to the newest live branch.
      if (!checkoutKnown(group)) project.path = branches.find((b) => !b.gone)?.path ?? project.path;
    }
    if (paths.length > 1) project.paths = [...new Set(paths)];
    out.push(project);
  }
  return titlesApart(out).sort(newestFirst);
}

/** A group seeded by a worktree with no checkout to name has only branches. */
function checkoutKnown(group: Project & { branches: ProjectBranch[] }): boolean {
  return !group.branches.some((b) => b.path === group.path);
}

/** Two branches reading the same ("main" twice, two detached) get their folders. */
function labelsApart(branches: ProjectBranch[]): ProjectBranch[] {
  const counts = new Map<string, number>();
  for (const b of branches) counts.set(b.label, (counts.get(b.label) ?? 0) + 1);
  return branches.map((b) => ((counts.get(b.label) ?? 0) > 1 && b.label !== b.name ? { ...b, label: `${b.label} (${b.name})` } : b));
}

/** Two projects reading the same get their parent folder: "api (work)", "api (oss)". */
function titlesApart(projects: Project[]): Project[] {
  const counts = new Map<string, number>();
  for (const p of projects) counts.set(projectTitle(p), (counts.get(projectTitle(p)) ?? 0) + 1);
  return projects.map((p) => {
    if ((counts.get(projectTitle(p)) ?? 0) < 2) return p;
    const parent = folderName(pathKey(p.path).replace(/[\\/][^\\/]*$/, ""));
    return parent ? { ...p, title: `${projectTitle(p)} (${parent})` } : p;
  });
}

/** Is `path` this project's own directory, or one of its branches? */
export function projectContains(project: Project, path: string | undefined): boolean {
  if (!path) return false;
  if (path === project.path) return true;
  return (project.paths ?? []).includes(path);
}

/** The project a directory belongs to, branch or not. */
export function projectFor(projects: readonly Project[], path: string | undefined): Project | undefined {
  if (!path) return undefined;
  return projects.find((p) => p.path === path) ?? projects.find((p) => projectContains(p, path));
}

/**
 * Where a chat in `path` happens, in words: "billing", or "billing · fix/login"
 * when the path is one of its branches. Undefined for a path in no project.
 */
export function placeTitle(projects: readonly Project[], path: string | undefined): string | undefined {
  const project = projectFor(projects, path);
  if (!project) return undefined;
  const branch = project.branches?.find((b) => b.path === path && b.path !== project.path);
  return branch ? `${projectTitle(project)} · ${branch.label}` : projectTitle(project);
}

/**
 * The only parts of the session list that can change the project list.
 *
 * The sessions array is rebuilt on every streamed chunk — each one updates the
 * mirror of turns hanging off the active session — so it takes a new identity
 * many times a second while an agent is answering. Used directly as a memo
 * dependency, that made `projectsForProvider` rebuild its Map and run a
 * `localeCompare` sort on every chunk, for a drawer that is usually closed and
 * whose contents had not changed.
 *
 * This is that list reduced to what the function above actually reads: `cwd`
 * and `startedAt`, over the sessions belonging to this agent. Building it is a
 * linear pass over values already in memory, cheaper than the sort it now
 * nearly always avoids — and it is exact rather than a heuristic: if this
 * string is unchanged, so is the list it would have produced. It errs toward
 * including a session the caller later discards, never toward omitting one.
 *
 * The separators are control characters because a path may contain anything the
 * filesystem allows, including whatever punctuation an ordinary delimiter would
 * have picked.
 */
export function projectSourceKey(
  sessions: Session[],
  providerId: string | undefined,
): string {
  if (!providerId) return "";
  let key = "";
  for (const session of sessions) {
    if (session.providerId !== providerId || !session.cwd) continue;
    key += `${session.cwd}\u0000${session.startedAt}\u0001`;
  }
  return key;
}

/**
 * Does this conversation belong to the chosen project?
 *
 * `cwd` is the real answer, but a session this app started never had one: the
 * daemon stamps only the folder *name* onto it when the turn finishes. Falling
 * back to that name is what keeps a conversation you just started from
 * vanishing out of the project you started it in. Two repos with the same last
 * segment could collide there, which is why it is the fallback and not the
 * rule.
 */
export function sessionInProject(session: Pick<Session, "cwd" | "folder">, project: Project): boolean {
  if (session.cwd) return projectContains(project, session.cwd);
  if (session.folder === undefined) return false;
  return session.folder === project.name || (project.branches ?? []).some((b) => b.name === session.folder);
}

/** The history list, narrowed to one project. `undefined` means all of them. */
export function sessionsInProject<T extends Pick<Session, "cwd" | "folder">>(sessions: T[], project: Project | undefined): T[] {
  if (!project) return sessions;
  return sessions.filter((session) => sessionInProject(session, project));
}

/** The selector's own label. Named for the state it is in, never left blank. */
export function projectLabel(project: Project | undefined): string {
  return project ? projectTitle(project) : "All projects";
}

/** One chip in the drawer's project strip. `path` undefined is "All". */
export interface ProjectTabItem {
  path?: string;
  label: string;
  a11y: string;
}

/**
 * The project strip's data, "All" first. Built once per project list so the
 * windowed strip gets stable items, and only the chips on screen mount: an
 * agent with hundreds of projects (GG Coder) mounted every one on switch.
 */
export function projectTabItems(projects: readonly Project[]): ProjectTabItem[] {
  return [
    { label: "All", a11y: "All projects" },
    ...projects.map((project) => {
      const title = projectTitle(project);
      const branches = project.branches?.length ?? 0;
      return {
        path: project.path,
        label: title,
        a11y: project.worktree
          ? `Project ${project.worktree.repo}, worktree ${project.worktree.branch ?? project.name}`
          : branches > 0
            ? `Project ${title}, ${branchCount(branches)}`
            : `Project ${title}`,
      };
    }),
  ];
}

/** "1 branch", "12 branches". */
export function branchCount(count: number): string {
  return `${count} branch${count === 1 ? "" : "es"}`;
}
