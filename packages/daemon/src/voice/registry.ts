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
import type { VoiceProject } from "./types.js";
import { writeFileAtomic } from "../atomic-file.js";

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
    .map((project): Candidate => {
      const labels = [project.name, ...project.aliases];
      return { project, score: Math.max(...labels.map((label) => scoreName(trimmed, label))) };
    })
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

/** Stable, path-derived id: survives restarts and is the same on every call. */
export function projectIdFor(path: string): string {
  return `proj_${createHash("sha1").update(path).digest("hex").slice(0, 10)}`;
}

/** Fold project paths and user aliases into registry entries (first-seen order). */
export function buildRegistry(
  paths: readonly string[],
  aliases: Readonly<Record<string, readonly string[]>>,
  providerFor?: (path: string) => string | undefined,
): VoiceProject[] {
  const seen = new Set<string>();
  const out: VoiceProject[] = [];
  for (const path of paths) {
    if (!path || seen.has(path)) continue;
    seen.add(path);
    const name = basename(path.replace(/[\\/]+$/, ""));
    if (!name) continue;
    const providerId = providerFor?.(path);
    out.push({
      projectId: projectIdFor(path),
      name,
      path,
      aliases: [...(aliases[path] ?? [])],
      ...(providerId ? { providerId } : null),
    });
  }
  return out;
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
