/**
 * "Dave" means two different things to voice, and they must never be swapped.
 *
 *  - **The backlog**: the user's to-do list, kept by DAVE, the assistant they
 *    talk *to*. "Check the backlog", "what's next on the backlog", "checking
 *    Dave, what's next on my to-do list?", "ask Dave", "Dave's priorities".
 *    "Backlog" is the canonical word, and its tool is `check_backlog`.
 *  - **dave, the project**: `~/dave` is a repository like any other, so it is
 *    in the registry and "dave" resolves to it. "Open the dave project", "work
 *    on dave", "in the dave repo, fix the login", "commit dave". That is
 *    `start_task` and friends.
 *
 * The model mostly gets it right from the instructions, but a misheard
 * "checking Dave" plus a project literally named dave is exactly where it
 * doesn't, and the cost is a coding agent launched in the wrong repository to
 * "find the next items on the to-do list". So every project-taking tool runs
 * its arguments through `routeDave` before acting, which reads the words the
 * model passed on (`project` and, for a task, its `instruction`, given "as the
 * user said it").
 *
 * The rules are deliberately small:
 *  - a projectId, or an explicit project cue ("the dave project", "dave repo",
 *    "in dave", "open dave", "work on dave"), means the project;
 *  - a spoken *project* that is itself a backlog query ("the backlog", "check
 *    the backlog") means the backlog, whatever project it might fuzzily match —
 *    unless it names a project ("the backlog repo");
 *  - otherwise they apply only when the dave project is in play (the spoken
 *    project mentions Dave or resolved to dave), so "fix the bug Dave
 *    reported" or "check the backlog" in any other repo is left alone. There,
 *    talking to or about Dave, or saying "backlog", means the backlog; both
 *    cues at once, or a bare "dave" with a to-do/what's-next question, asks.
 *
 * Pure: no I/O, so it is tested on its own and shared by every caller.
 */
import { normalise } from "./registry.js";
import type { VoiceProject } from "./types.js";

/** What the words say "Dave" is. `bare` names Dave with no cue either way; `none` never names it. */
export type DaveSense = "assistant" | "project" | "unclear" | "bare" | "none";

const DAVE = /\bdave\b/;

const PROJECT_NOUNS =
  "project|projects|repo|repos|repository|codebase|code|app|checkout|folder|directory|worktree|worktrees|branch|branches|source";

/** Phrases that only make sense about the code project. Matched on `normalise()`d text. */
const PROJECT_CUES: readonly RegExp[] = [
  // "the dave project", "dave's repo", "dave code"
  new RegExp(`\\bdave (s )?(${PROJECT_NOUNS})\\b`),
  // "the repo called dave", "project dave"
  new RegExp(`\\b(${PROJECT_NOUNS}) (called |named )?dave\\b`),
  // "in dave", "inside the dave" — but not "check in dave" (a misheard "check in
  // with Dave"), and not "in dave's list".
  /(?<!\bcheck(s|ing|ed)? )\b(in|inside|into|under) (the )?dave\b(?! s\b)/,
  // "open dave", "work on the dave", "switch to dave" — but not "open Dave's backlog".
  /\b(open|opening|work on|working on|switch to|switching to|go to|go into|jump into|start on|inspect|inspecting|look inside) (the )?dave\b(?! s\b)/,
];

/** Phrases that address Dave or report what Dave says: the assistant. */
const ASSISTANT_CUES: readonly RegExp[] = [
  // "checking Dave", "check in with Dave", "ask Dave", "hey Dave", "ping Dave"
  /\b(check|checks|checking|checked|ask|asks|asking|asked|tell|telling|consult|consulting|ping|pinging|hey|hi|ok|okay|query|querying)( in| back)?( with| on)? dave\b/,
  // "according to Dave", "from Dave"
  /\b(according to|from) dave\b/,
  // "Dave says", "Dave thinks", "Dave recommends"
  /\bdave (says|said|say|thinks|think|thought|recommends|recommend|recommended|suggests|suggest|suggested|wants|want|reckons|knows|know)\b/,
  // "what does Dave …", "can Dave …"
  /\b(does|did|would|will|can|could) dave\b/,
  // "Dave's list", "Dave's priorities", "Dave's to-do"
  /\bdave s (list|lists|backlog|to do|todo|todos|priorities|priority|queue|plan|plans|take|view|opinion|recommendation|recommendations|advice|picks|agenda|focus|ranking)\b/,
  // A vocative: "Dave, what's next?"
  /^(hey |hi |ok |okay )?dave (what|whats|which|tell|give|list|show|any|how|read)\b/,
];

/** What a phrase says "Dave" is. */
export function daveSense(text: string): DaveSense {
  const t = normalise(text);
  if (!DAVE.test(t)) return "none";
  const project = PROJECT_CUES.some((re) => re.test(t));
  const assistant = ASSISTANT_CUES.some((re) => re.test(t));
  if (project && assistant) return "unclear";
  if (assistant) return "assistant";
  if (project) return "project";
  return "bare";
}

/** An imperative a coding agent can carry out: "add a to-do", "mark the next items done". */
const CODING_VERB =
  /^(please )?(add|create|implement|fix|write|update|remove|delete|build|refactor|make|rename|move|change|clean|mark|tick|complete|finish|edit|sort|convert)\b/;
/** Naming a file means the repository's TODO, not the user's. */
const FILE_WORD = /\b(file|files|md|txt|readme|markdown|issue|issues|ticket|tickets)\b/;

const TODO_QUESTIONS: readonly RegExp[] = [
  /\b(my|our) (to do|todo|todos|to dos|priorities|agenda)\b/,
  /\b(to do|todo) list\b/,
  /\bnext (item|items|thing|things|up)\b/,
  /\b(what s|whats|what is|what) next\b/,
  /\bwhat should i (do|work on|focus on|tackle|pick up)\b/,
];

const BACKLOG = /\bback ?log\b/;
/** "the backlog" as the name of a project, not the to-do list: "the backlog repo", "project backlog". */
const BACKLOG_PROJECT = new RegExp(
  `\\bback ?log (s )?(${PROJECT_NOUNS})\\b|\\b(${PROJECT_NOUNS}) (called |named )?back ?log\\b`,
);
const BACKLOG_QUERIES: readonly RegExp[] = [
  // The word on its own: "backlog", "the backlog", "my backlog".
  /^(the |my |our )?back ?log$/,
  // "check the backlog", "read me the backlog", "go through my backlog"
  /\b(check|checking|read|reading|show|list|open|look at|looking at|go through|review|reviewing|pull up|bring up|consult|query|what s|whats|what is|anything)( me)?( on| in| at)?( the| my| our)? back ?log\b/,
  // "next on the backlog", "top of the backlog", "items in my backlog"
  /\b(next|top|items?|things?|first)( up)? (on|in|of|from) (the |my |our )?back ?log\b/,
  // "backlog items", "the backlog's priorities"
  /\bback ?log (s )?(items|list|priorities|queue|summary|status)\b/,
];

/** Says "backlog" at all, e.g. "Dave's backlog": once the backlog is meant, it is the ranked list. */
function mentionsBacklog(text: string): boolean {
  return BACKLOG.test(normalise(text));
}

/**
 * "Check the backlog": a query of the user's backlog, by its canonical word.
 * A coding instruction ("add a backlog screen"), a file or ticket, or a
 * project named backlog ("the backlog repo") is not one.
 */
export function isBacklogQuery(text: string): boolean {
  const t = normalise(text);
  if (!BACKLOG.test(t) || BACKLOG_PROJECT.test(t)) return false;
  if (CODING_VERB.test(t) || FILE_WORD.test(t)) return false;
  return BACKLOG_QUERIES.some((re) => re.test(t));
}

/**
 * A question about the user's own to-do list or what to do next, which is
 * DAVE's to answer, as opposed to a coding instruction that mentions a TODO.
 */
export function isTodoQuestion(text: string): boolean {
  const t = normalise(text);
  if (CODING_VERB.test(t) || FILE_WORD.test(t)) return false;
  return TODO_QUESTIONS.some((re) => re.test(t));
}

/** A registry entry the user would call "dave": the repository, or a worktree of it. */
export function isDaveProject(project: VoiceProject | undefined): boolean {
  if (!project) return false;
  const names = [project.name, project.worktree?.repo ?? "", ...project.aliases];
  return names.some((name) => DAVE.test(normalise(name)));
}

export type DaveRoute =
  /** Carry on with the project tool. */
  | { kind: "project" }
  /** The user means the backlog (DAVE): use check_backlog, not the project. */
  | { kind: "assistant"; about: "priorities" | "overview" }
  /** Could be either: ask before doing anything. */
  | { kind: "ask"; about: "priorities" | "overview" };

export interface DaveRouteInput {
  /** The spoken project the model passed. */
  query: string;
  /** For start_task: the instruction, as the user said it. */
  instruction?: string;
  /** What `query` resolved to, if anything. */
  target?: VoiceProject;
  /** The query was an exact projectId: the model already chose. */
  byId?: boolean;
  /** DAVE's tools are offered in this session. */
  daveAvailable: boolean;
}

/** One sense for two phrases: a cue in either counts, and opposite cues are unclear. */
function merge(a: DaveSense, b: DaveSense): DaveSense {
  const has = (sense: DaveSense) => a === sense || b === sense;
  if (has("unclear") || (has("assistant") && has("project"))) return "unclear";
  if (has("assistant")) return "assistant";
  if (has("project")) return "project";
  return has("bare") ? "bare" : "none";
}

/** Whether a project-taking call meant the dave project, DAVE the assistant, or isn't clear. */
export function routeDave(input: DaveRouteInput): DaveRoute {
  const { query, instruction, target, byId, daveAvailable } = input;
  if (byId) return { kind: "project" };
  const querySense = daveSense(query);
  // "Which project?" "The backlog." The spoken project is itself the backlog,
  // whatever it might fuzzily match. With DAVE off, a real match stands.
  if (querySense !== "project" && isBacklogQuery(query) && (daveAvailable || !target)) {
    return { kind: "assistant", about: "priorities" };
  }
  // Only when the dave project is in play: anything else is not this confusion.
  if (querySense === "none" && !isDaveProject(target)) return { kind: "project" };
  if (querySense === "project") return { kind: "project" };

  const asked = instruction ?? "";
  const about =
    isTodoQuestion(asked) ||
    isTodoQuestion(query) ||
    mentionsBacklog(asked) ||
    mentionsBacklog(query)
      ? "priorities"
      : "overview";
  // Read apart, never joined: "dave" + "what's next" would read as "Dave, what's next?".
  switch (merge(querySense, instruction ? daveSense(instruction) : "none")) {
    case "assistant":
      return { kind: "assistant", about };
    case "unclear":
      return { kind: "ask", about };
    case "project":
      return { kind: "project" };
    case "bare":
    case "none":
      if (!daveAvailable) return { kind: "project" };
      // "dave" + "check the backlog": the canonical word settles it.
      if (isBacklogQuery(asked)) return { kind: "assistant", about };
      // "dave" + "what's next on my to-do list": the repo has no say in the
      // user's to-do list, but with no cue this is worth one question.
      return isTodoQuestion(asked) ? { kind: "ask", about } : { kind: "project" };
  }
}
