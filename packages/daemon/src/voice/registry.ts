/**
 * Spoken project names to real projects.
 *
 * The model hears "pew two" or "the iOS app" and must land on a repository the
 * daemon already knows. Resolution is deliberately conservative: it returns
 * ranked candidates plus an `ambiguous` flag, and an ambiguous result means the
 * model asks the user rather than guessing — starting an agent in the wrong
 * repo is worse than one more question.
 *
 * Pure apart from the alias file, which lives beside the other daemon state.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { VoiceProject, VoiceRepo } from "./types.js";
import { writeFileAtomic } from "../atomic-file.js";
import { linkWorktreeRoots, worktreeLabel, type WorktreeInfo } from "../worktree.js";

const NUMBER_WORDS: Record<string, string> = {
  zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5",
  six: "6", seven: "7", eight: "8", nine: "9", ten: "10",
};

/** Lowercase, split camelCase and separators, spoken digits to digits. */
export function normalise(text: string): string {
  return text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((word) => NUMBER_WORDS[word] ?? word)
    .join(" ");
}

/** Space-free form, so "pew 2", "pew2" and "pew two" coincide. */
function squash(text: string): string {
  return normalise(text).replace(/ /g, "");
}

/** A small phonetic key (Metaphone-lite) so "kodex"/"codex" collide. */
export function phonetic(text: string): string {
  let s = squash(text);
  s = s
    .replace(/^kn|^gn|^pn|^wr/, (m) => m[1] ?? "")
    .replace(/ph/g, "f")
    .replace(/ck/g, "k")
    .replace(/c(?=[eiy])/g, "s")
    .replace(/c/g, "k")
    .replace(/q/g, "k")
    .replace(/x/g, "ks")
    .replace(/z/g, "s")
    .replace(/w(?=[aeiou])/g, "v")
    .replace(/(.)\1+/g, "$1");
  // Vowels carry little signal in noisy ASR; keep only a leading one.
  return (s[0] ?? "") + s.slice(1).replace(/[aeiouyhw]/g, "");
}

export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (row[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[b.length] ?? 0;
}

function similarity(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  return longest === 0 ? 1 : 1 - editDistance(a, b) / longest;
}

/** Score one spoken name against one label, 0..1. */
export function scoreName(query: string, label: string): number {
  const q = squash(query);
  const l = squash(label);
  if (!q || !l) return 0;
  if (q === l) return 1;
  let best = similarity(q, l) * 0.9;
  // Whole-word containment: "ios" inside "pew2 ios app".
  const words = normalise(label).split(" ");
  if (normalise(query).split(" ").every((w) => words.includes(w))) best = Math.max(best, 0.88);
  if (l.includes(q) && q.length >= 3) best = Math.max(best, 0.8 * (q.length / l.length) + 0.15);
  const pq = phonetic(query);
  const pl = phonetic(label);
  if (pq && pq === pl) best = Math.max(best, 0.86);
  else if (pq.length >= 3) best = Math.max(best, similarity(pq, pl) * 0.84);
  return Math.min(1, best);
}

export interface Candidate {
  project: VoiceProject;
  score: number;
}

export interface Resolution {
  candidates: Candidate[];
  /** More than one plausible match, or none good enough: ask the user. */
  ambiguous: boolean;
  /** Present only when unambiguous. */
  best?: VoiceProject;
}

const MIN_SCORE = 0.55;
/**
 * A worktree answers to its repository's name, but below the repo itself:
 * "black mountain fund" means the main checkout when there is one, and only
 * when there is not do its worktrees compete (and, being equal, ask).
 */
const WORKTREE_REPO_WEIGHT = 0.9;

/** Every name a project answers to at full strength. */
function labelsOf(project: VoiceProject): string[] {
  const labels = [project.name, ...project.aliases];
  if (project.worktree) {
    // "the fact total worktree" names the folder; "the login fix" the branch.
    const folder = basename(project.path.replace(/[\\/]+$/, ""));
    if (folder) labels.push(folder);
    if (project.worktree.branch) labels.push(project.worktree.branch);
  }
  return labels;
}

function scoreProject(query: string, project: VoiceProject): number {
  const own = Math.max(...labelsOf(project).map((label) => scoreName(query, label)));
  if (!project.worktree) return own;
  return Math.max(own, scoreName(query, project.worktree.repo) * WORKTREE_REPO_WEIGHT);
}
/** Two matches this close are a coin toss. */
const AMBIGUITY_GAP = 0.08;

export function resolveProject(
  query: string,
  projects: readonly VoiceProject[],
  limit = 4,
): Resolution {
  const trimmed = query.trim();
  if (!trimmed) return { candidates: [], ambiguous: true };
  // An exact projectId is not speech, just use it.
  const byId = projects.find((p) => p.projectId === trimmed);
  if (byId) return { candidates: [{ project: byId, score: 1 }], ambiguous: false, best: byId };

  const scored = projects
    .map((project): Candidate => ({ project, score: scoreProject(trimmed, project) }))
    .filter((c) => c.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score || a.project.name.localeCompare(b.project.name))
    .slice(0, limit);

  const first = scored[0];
  if (!first) return { candidates: [], ambiguous: true };
  const second = scored[1];
  const exact = first.score >= 1 && (!second || second.score < 1);
  const ambiguous =
    !exact && (first.score < 0.7 || (second ? first.score - second.score < AMBIGUITY_GAP : false));
  return ambiguous
    ? { candidates: scored, ambiguous: true }
    : { candidates: scored, ambiguous: false, best: first.project };
}

/**
 * Stable, path-derived id: survives restarts and is the same on every call.
 *
 * Hashed from the path without a trailing separator, so `/code/x` and
 * `/code/x/` are one project to the registry, to a task's lock, and to the
 * `repoId` a worktree points at; otherwise the same directory could hold two
 * ids and its tasks would be tracked under whichever spelling arrived first.
 */
export function projectIdFor(path: string): string {
  return `proj_${createHash("sha1").update(samePath(path)).digest("hex").slice(0, 10)}`;
}

/**
 * Fold project paths and user aliases into registry entries (first-seen order).
 *
 * A path `worktreeFor` recognises is named after its repository and branch
 * ("black-mountain-fund (fix/login)") instead of its folder (`ez-mun7ig9t`),
 * and its main checkout is added just before it when the agents never worked
 * there directly — otherwise the one name the user actually says would match
 * a dozen random worktrees and nothing else.
 *
 * Three checks keep the list one entry per thing the user could mean:
 *  - a path is one project however it is written (`/code/x` and `/code/x/`);
 *  - a deleted worktree is left out — nothing can be started in it, and its
 *    old tasks already carry their own names — though it still contributes
 *    its repo's main checkout;
 *  - two entries that would *sound* the same (`~/work/api` and `~/oss/api`)
 *    are named apart by their parent folder, so "did you mean api or api?"
 *    can never be asked.
 */
export function buildRegistry(
  paths: readonly string[],
  aliases: Readonly<Record<string, readonly string[]>>,
  providerFor?: (path: string) => string | undefined,
  worktreeFor?: (path: string) => WorktreeInfo | undefined,
): VoiceProject[] {
  // Roots first: a worktree that only knows its repo's name (a deleted ezcoder
  // checkout) is linked to the one checkout with that name, as the probe does.
  const known = linkWorktreeRoots(
    paths
      .filter((path) => path && folderOf(path))
      .map((path) => {
        const worktree = worktreeFor?.(path);
        return { path, name: folderOf(path), ...(worktree ? { worktree } : null) };
      }),
  );

  const seen = new Set<string>();
  const out: VoiceProject[] = [];
  const add = (path: string, worktree?: WorktreeInfo) => {
    const key = samePath(path);
    if (!key || seen.has(key)) return;
    seen.add(key);
    const folder = folderOf(path);
    if (!folder) return;
    const providerId = providerFor?.(path);
    out.push({
      projectId: projectIdFor(path),
      name: worktree ? worktreeLabel(folder, worktree) : folder,
      path,
      aliases: [...(aliases[path] ?? [])],
      ...(providerId ? { providerId } : null),
      ...(worktree
        ? {
            worktree: {
              repo: worktree.repo,
              ...(worktree.root ? { repoId: projectIdFor(worktree.root) } : null),
              ...(worktree.branch ? { branch: worktree.branch } : null),
            },
          }
        : null),
    });
  };
  for (const { path, worktree } of known) {
    if (worktree?.root) add(worktree.root);
    if (!worktree?.gone) add(path, worktree);
  }
  return nameApart(out);
}

function folderOf(path: string): string {
  return basename(path.replace(/[\\/]+$/, ""));
}

/** One spelling per directory: trailing separators are not a different project. */
function samePath(path: string): string {
  return path.replace(/[\\/]+$/, "") || path;
}

/** Entries whose names collide get their parent folder: "api (in work)", "api (in oss)". */
function nameApart(projects: VoiceProject[]): VoiceProject[] {
  const counts = new Map<string, number>();
  for (const p of projects) counts.set(normalise(p.name), (counts.get(normalise(p.name)) ?? 0) + 1);
  return projects.map((p) => {
    if ((counts.get(normalise(p.name)) ?? 0) < 2) return p;
    const parent = basename(dirname(samePath(p.path)));
    return parent ? { ...p, name: `${p.name} (in ${parent})` } : p;
  });
}

/**
 * The repository a registry entry's tasks belong to, or undefined for an
 * ordinary checkout. Recorded on the task when it is created, so every event
 * it emits can name the repository rather than the checkout.
 */
export function repoOf(project: VoiceProject): VoiceRepo | undefined {
  if (!project.worktree) return undefined;
  return {
    ...(project.worktree.repoId ? { projectId: project.worktree.repoId } : null),
    name: project.worktree.repo,
    branch: branchName(project),
  };
}

/**
 * The same, for a directory that may no longer be in the registry: a task
 * saved before repositories were tracked, possibly in a checkout ezcoder has
 * since deleted. `projects` supplies the main checkout when git could not.
 */
export function repoForPath(path: string, worktree: WorktreeInfo | undefined, projects: readonly VoiceProject[]): VoiceRepo | undefined {
  if (!worktree) return undefined;
  const root = worktree.root ?? soleCheckoutNamed(worktree.repo, projects);
  return {
    ...(root ? { projectId: projectIdFor(root) } : null),
    name: worktree.repo,
    branch: worktree.branch ?? folderOf(path),
  };
}

function soleCheckoutNamed(name: string, projects: readonly VoiceProject[]): string | undefined {
  const matches = projects.filter((p) => !p.worktree && folderOf(p.path) === name);
  return matches.length === 1 ? matches[0]?.path : undefined;
}

/** Worktrees of the repository whose main checkout is `projectId`. */
export function worktreesOf(projectId: string, projects: readonly VoiceProject[]): VoiceProject[] {
  return projects.filter((p) => p.worktree?.repoId === projectId);
}

/** What a worktree is called inside its repo: the branch, else its folder. */
export function branchName(project: VoiceProject): string {
  return project.worktree?.branch ?? folderOf(project.path);
}

/** The most branches named per repository before "and N more". */
const BRANCHES_LISTED = 6;

export interface RepoGroup {
  /** The main checkout's id; absent when only its worktrees are known. */
  projectId?: string;
  name: string;
  aliases: string[];
  branches: { projectId: string; branch: string }[];
  moreBranches?: number;
}

/**
 * The registry as the user thinks of it: one entry per repository, its
 * worktrees listed as branches under it rather than as projects of their own.
 *
 * ezcoder makes a checkout per task, so a repo worked on for a month can own
 * a dozen; listed flat they buried every other project the user could name.
 * Worktrees whose main checkout is unknown are grouped by repo name alone.
 */
export function groupByRepo(projects: readonly VoiceProject[]): RepoGroup[] {
  const groups: RepoGroup[] = [];
  const byKey = new Map<string, RepoGroup>();
  const keyOf = (p: VoiceProject) => (p.worktree ? (p.worktree.repoId ?? `repo:${p.worktree.repo}`) : p.projectId);
  const ids = new Set(projects.map((p) => p.projectId));
  for (const p of projects) {
    let key = keyOf(p);
    // A repoId that is not in this list (filtered out upstream) falls back to the name.
    if (p.worktree?.repoId && !ids.has(p.worktree.repoId)) key = `repo:${p.worktree.repo}`;
    let group = byKey.get(key);
    if (!group) {
      group = p.worktree
        ? { name: p.worktree.repo, aliases: [], branches: [] }
        : { projectId: p.projectId, name: p.name, aliases: p.aliases.slice(0, 3), branches: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    if (p.worktree) group.branches.push({ projectId: p.projectId, branch: branchName(p) });
  }
  for (const group of groups) {
    if (group.branches.length > BRANCHES_LISTED) {
      group.moreBranches = group.branches.length - BRANCHES_LISTED;
      group.branches = group.branches.slice(0, BRANCHES_LISTED);
    }
  }
  return groups;
}

/** Ezcoder when it is usable, else the most recently used agent, else the first usable one. */
export function chooseProvider(usable: readonly string[], lastUsed?: string): string | undefined {
  if (usable.includes("ezcoder")) return "ezcoder";
  if (lastUsed && usable.includes(lastUsed)) return lastUsed;
  return usable[0];
}

// ---- alias persistence -----------------------------------------------------

export function aliasesPath(dataDir: string): string {
  return join(dataDir, "voice-aliases.json");
}

export async function readAliases(dataDir: string): Promise<Record<string, string[]>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(aliasesPath(dataDir), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string[]> = {};
    for (const [path, list] of Object.entries(parsed)) {
      if (Array.isArray(list)) out[path] = list.filter((a): a is string => typeof a === "string");
    }
    return out;
  } catch {
    return {};
  }
}

/** Add one alias for a project path (read-modify-write, deduplicated). */
export async function addAlias(
  dataDir: string,
  path: string,
  alias: string,
): Promise<Record<string, string[]>> {
  const all = await readAliases(dataDir);
  const clean = alias.trim().slice(0, 60);
  if (!clean) return all;
  const list = all[path] ?? [];
  if (!list.some((a) => normalise(a) === normalise(clean))) list.push(clean);
  all[path] = list.slice(-20);
  await mkdir(dirname(aliasesPath(dataDir)), { recursive: true, mode: 0o700 });
  await writeFileAtomic(aliasesPath(dataDir), JSON.stringify(all, null, 2));
  return all;
}
