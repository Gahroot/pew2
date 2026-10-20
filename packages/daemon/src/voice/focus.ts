/**
 * Conversational references: what "that", "it", "the other project" or
 * "yesterday's issue" mean, resolved to real ids.
 *
 * Pure and deterministic (the clock and timezone are injected). Follows the
 * SessionMemory pattern: typed records, per-kind half-life salience decay,
 * `corrects` overrides, and no confident match means ask, never guess.
 */
import { speakable } from "./safety.js";
import type { FocusRef, StoredTask } from "./store.js";
import { MAX_FOCUS } from "./store.js";
import type { ToolResult } from "./taskTools.js";
import type { VoiceEvent, VoiceProject } from "./types.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Half-life per kind; a question stays salient while it is open. */
export const FOCUS_HALF_LIFE_MS: Readonly<Record<FocusRef["kind"], number>> = {
  task: 2 * HOUR,
  project: 4 * HOUR,
  goal: 24 * HOUR,
  result: 6 * HOUR,
  question: Number.POSITIVE_INFINITY,
};

/** Below this, a ref is too faded to act on without asking. */
const MIN_SALIENCE = 0.1;

/** The task fields reference resolution reads. A `StoredTask` satisfies it. */
export type FocusTask = Pick<
  StoredTask,
  "taskId" | "projectId" | "projectName" | "title" | "state" | "createdAt" | "updatedAt"
> &
  Partial<Pick<StoredTask, "goal" | "question" | "error">>;

/** A goal run as reference resolution needs it; independent of `goalRuns.ts`. */
export interface FocusGoal {
  runId: string;
  title: string;
  objective?: string;
  projectId: string;
  projectName: string;
  status?: string;
  updatedAt?: number;
}

export interface FocusMatch {
  taskId?: string;
  projectId?: string;
  runId?: string;
  label: string;
  why: string;
}

export interface ResolveResult {
  match?: FocusMatch;
  alternatives: FocusMatch[];
  needsClarification?: boolean;
  question?: string;
  /** For a time-word match: a later task in the same project that finished. */
  laterOutcome?: { taskId: string; label: string; state: "completed" | "verified" };
}

export interface ResolveContext {
  refs: readonly FocusRef[];
  tasks: readonly FocusTask[];
  projects: readonly VoiceProject[];
  goals: readonly FocusGoal[];
  now: number;
  tzOffsetMinutes: number;
}

export interface NoteContext {
  now: number;
  tasks: readonly FocusTask[];
  projects: readonly VoiceProject[];
  goals?: readonly FocusGoal[];
  via?: FocusRef["via"];
}

export interface ToolCallNote {
  name: string;
  args: Record<string, unknown>;
  output: unknown;
  ok: boolean;
}

const ACTIVE_STATES = new Set(["running", "blocked", "queued"]);
const PROBLEM_STATES = new Set(["failed", "blocked"]);

function label(text: string | undefined): string {
  return speakable(text, 80) || "that task";
}

function isOpenQuestion(ref: FocusRef, tasks: readonly FocusTask[]): boolean {
  const task = tasks.find((t) => t.taskId === ref.id);
  if (!task) return false;
  return task.question !== undefined || task.state === "blocked";
}

/** Decayed salience in [0, 1]; a corrected ref and a closed question are 0. */
export function salience(
  ref: FocusRef,
  refs: readonly FocusRef[],
  tasks: readonly FocusTask[],
  now: number,
): number {
  const corrected = refs.some(
    (r) => r.corrects === ref.id && r.kind === ref.kind && r.at >= ref.at,
  );
  if (corrected) return 0;
  if (ref.kind === "question") return isOpenQuestion(ref, tasks) ? 1 : 0;
  const age = Math.max(0, now - ref.at);
  return 0.5 ** (age / FOCUS_HALF_LIFE_MS[ref.kind]);
}

interface Ranked {
  ref: FocusRef;
  score: number;
}

/** Refs by salience, newest winning ties, then id for stability. */
function ranked(refs: readonly FocusRef[], tasks: readonly FocusTask[], now: number): Ranked[] {
  return refs
    .map((ref) => ({ ref, score: salience(ref, refs, tasks, now) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || b.ref.at - a.ref.at || a.ref.id.localeCompare(b.ref.id));
}

function upsert(refs: readonly FocusRef[], ref: FocusRef): FocusRef[] {
  const kept = refs.filter((r) => !(r.kind === ref.kind && r.id === ref.id));
  kept.push(ref);
  return kept.slice(-MAX_FOCUS);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The objects ids are read from: args, output, and `output.task`/`output.goal`. */
function sources(call: ToolCallNote): Record<string, unknown>[] {
  const out = record(call.output);
  const list = [call.args];
  if (out) {
    list.push(out);
    for (const key of ["task", "goal", "match", "project"]) {
      const inner = record(out[key]);
      if (inner) list.push(inner);
    }
  }
  return list;
}

function first(list: Record<string, unknown>[], key: string): string | undefined {
  for (const item of list) {
    const value = str(item[key]);
    if (value) return value;
  }
  return undefined;
}

function asksFirst(args: Record<string, unknown>): boolean {
  return Object.keys(args)
    .sort()
    .some((k) => {
      const v = args[k];
      return typeof v === "string" && /\bfirst\b/i.test(v);
    });
}

/** Record what a tool call talked about. A failed call changes nothing. */
export function noteToolCall(
  refs: readonly FocusRef[],
  call: ToolCallNote,
  ctx: NoteContext,
): FocusRef[] {
  if (!call.ok) return [...refs];
  const list = sources(call);
  const via = ctx.via ?? "tool";
  const correcting = call.name === "reprioritize_task" || asksFirst(call.args);
  const before = ranked(refs, ctx.tasks, ctx.now);
  const corrects = (kind: FocusRef["kind"], id: string): string | undefined => {
    if (!correcting) return undefined;
    return before.find((r) => r.ref.kind === kind && r.ref.id !== id)?.ref.id;
  };
  let next = [...refs];

  const taskId = first(list, "taskId");
  const task = taskId ? ctx.tasks.find((t) => t.taskId === taskId) : undefined;
  let projectId = first(list, "projectId") ?? task?.projectId;
  const project = projectId ? ctx.projects.find((p) => p.projectId === projectId) : undefined;
  if (projectId && !project && !task) projectId = undefined; // unknown id: never invent a label
  const projectName = project?.name ?? task?.projectName;

  if (projectId && projectName) {
    const c = corrects("project", projectId);
    next = upsert(next, {
      kind: "project",
      id: projectId,
      label: label(projectName),
      projectId,
      projectName,
      at: ctx.now,
      via,
      ...(c ? { corrects: c } : {}),
    });
  }
  if (task) {
    const c = corrects("task", task.taskId);
    next = upsert(next, {
      kind: "task",
      id: task.taskId,
      label: label(task.title),
      projectId: task.projectId,
      projectName: task.projectName,
      at: ctx.now,
      via,
      ...(c ? { corrects: c } : {}),
    });
  }
  const runId = first(list, "runId") ?? task?.goal?.runId;
  if (runId) {
    const goal = ctx.goals?.find((g) => g.runId === runId);
    const title = goal?.title ?? task?.goal?.objective ?? first(list, "title");
    if (title) {
      next = upsert(next, {
        kind: "goal",
        id: runId,
        label: label(title),
        ...((goal?.projectId ?? projectId) ? { projectId: goal?.projectId ?? projectId } : {}),
        ...((goal?.projectName ?? projectName)
          ? { projectName: goal?.projectName ?? projectName }
          : {}),
        at: ctx.now,
        via,
      });
    }
  }
  const requestId = first(list, "requestId");
  if (requestId && task?.question?.requestId === requestId) {
    next = upsert(next, {
      kind: "question",
      id: task.taskId,
      label: label(task.question.text),
      projectId: task.projectId,
      projectName: task.projectName,
      at: ctx.now,
      via,
    });
  }
  return next;
}

/** Record what an event means for "that". Approvals are live state, not refs. */
export function noteEvent(
  refs: readonly FocusRef[],
  event: VoiceEvent,
  task: FocusTask | undefined,
): FocusRef[] {
  const base = {
    id: event.taskId,
    label: label(task?.title ?? event.text),
    projectId: event.projectId,
    projectName: event.projectName,
    at: event.at,
    via: "event" as const,
  };
  if (
    event.kind === "task.completed" ||
    event.kind === "task.failed" ||
    event.kind === "task.verified"
  ) {
    return upsert(refs, { ...base, kind: "result" });
  }
  const isQuestion =
    event.goal?.change === "needs_you" ||
    (event.kind === "task.blocked" &&
      (task?.question !== undefined || /^question\b/i.test(event.text)));
  if (isQuestion) return upsert(refs, { ...base, kind: "question" });
  return [...refs];
}

const STOP = new Set(
  "a an the that this it its is was did does do get got have has had to of in on for from with and or my me you your be been there what which issue problem bug thing one please tell ask make let just actually now first yesterday today earlier morning last week agent about any how coming along going status".split(
    " ",
  ),
);

function tokens(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length > 1 && !STOP.has(t)),
    ),
  ].sort();
}

function overlap(phrase: string[], text: string): number {
  if (phrase.length === 0) return 0;
  const words = new Set(tokens(text));
  return phrase.filter((t) => words.has(t)).length / phrase.length;
}

function taskMatch(task: FocusTask, why: string): FocusMatch {
  return {
    taskId: task.taskId,
    projectId: task.projectId,
    ...(task.goal?.runId ? { runId: task.goal.runId } : {}),
    label: `${label(task.title)} in ${label(task.projectName)}`,
    why,
  };
}

function clarify(alternatives: FocusMatch[], fallback: string): ResolveResult {
  const top = alternatives.slice(0, 3);
  const names = top.map((a) => a.label);
  const question =
    names.length >= 2
      ? `Did you mean ${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}?`
      : names.length === 1
        ? `Did you mean ${names[0]}?`
        : fallback;
  return { alternatives: top, needsClarification: true, question };
}

interface Window {
  from: number;
  to: number;
  name: string;
}

function timeWindow(phrase: string, now: number, tzOffsetMinutes: number): Window | undefined {
  const offset = tzOffsetMinutes * MINUTE;
  const dayStart = Math.floor((now + offset) / DAY) * DAY - offset;
  if (/\byesterday\b/.test(phrase))
    return { from: dayStart - DAY, to: dayStart, name: "yesterday" };
  if (/\blast week\b/.test(phrase))
    return { from: dayStart - 7 * DAY, to: dayStart, name: "last week" };
  if (/\bthis morning\b/.test(phrase))
    return { from: dayStart, to: dayStart + 12 * HOUR, name: "this morning" };
  if (/\b(earlier|today)\b/.test(phrase)) return { from: dayStart, to: now, name: "earlier today" };
  return undefined;
}

function byRecency(a: FocusTask, b: FocusTask): number {
  return b.updatedAt - a.updatedAt || a.taskId.localeCompare(b.taskId);
}

function resolveTime(phrase: string, win: Window, ctx: ResolveContext): ResolveResult {
  const inWindow = ctx.tasks
    .filter((t) => t.updatedAt >= win.from && t.updatedAt < win.to)
    .sort(byRecency);
  const problems = inWindow.filter((t) => PROBLEM_STATES.has(t.state) || t.question !== undefined);
  let pool = problems.length > 0 ? problems : inWindow;
  const words = tokens(phrase);
  if (pool.length > 1 && words.length > 0) {
    const scored = pool.map((t) => ({ t, s: overlap(words, `${t.title} ${t.projectName}`) }));
    const best = Math.max(...scored.map((x) => x.s));
    if (best > 0) pool = scored.filter((x) => x.s === best).map((x) => x.t);
  }
  const alternatives = pool.map((t) => taskMatch(t, `updated ${win.name}`));
  const only = pool.length === 1 ? pool[0] : undefined;
  if (!only)
    return clarify(alternatives, `I can't find a task from ${win.name}. Which one do you mean?`);
  const later = ctx.tasks
    .filter(
      (t) =>
        t.taskId !== only.taskId &&
        t.projectId === only.projectId &&
        t.createdAt >= only.createdAt &&
        t.updatedAt > only.updatedAt &&
        (t.state === "completed" || t.state === "verified"),
    )
    .sort(
      (a, b) =>
        (a.state === "verified" ? 0 : 1) - (b.state === "verified" ? 0 : 1) || byRecency(a, b),
    )[0];
  return {
    match: alternatives[0] ?? taskMatch(only, `updated ${win.name}`),
    alternatives: [],
    ...(later
      ? {
          laterOutcome: {
            taskId: later.taskId,
            label: label(later.title),
            state: later.state === "verified" ? "verified" : "completed",
          },
        }
      : {}),
  };
}

function currentProject(rank: Ranked[]): string | undefined {
  return rank.find((r) => r.ref.projectId)?.ref.projectId;
}

function resolveOther(ctx: ResolveContext, rank: Ranked[]): ResolveResult {
  const current = currentProject(rank);
  const seen = new Map<string, { name: string; score: number }>();
  for (const r of rank) {
    const id = r.ref.projectId;
    if (!id || id === current || r.score < MIN_SALIENCE || seen.has(id)) continue;
    const name =
      ctx.projects.find((p) => p.projectId === id)?.name ?? r.ref.projectName ?? r.ref.label;
    seen.set(id, { name, score: r.score });
  }
  const alternatives = [...seen.entries()].map(([projectId, v]) => ({
    projectId,
    label: label(v.name),
    why: "the other project mentioned recently",
  }));
  const only = alternatives.length === 1 ? alternatives[0] : undefined;
  if (only) return { match: only, alternatives: [] };
  return clarify(alternatives, "Which project do you mean?");
}

const DEICTIC = /\b(that|it|this|the agent|its)\b/;
const ADDRESSES_AGENT = /\b(the agent|have it|tell it|ask it|make it|get it)\b/;

function resolveDeictic(phrase: string, ctx: ResolveContext, rank: Ranked[]): ResolveResult {
  const addressing = ADDRESSES_AGENT.test(phrase);
  const taskOf = (r: Ranked): FocusTask | undefined =>
    r.ref.kind === "task" || r.ref.kind === "result" || r.ref.kind === "question"
      ? ctx.tasks.find((t) => t.taskId === r.ref.id)
      : undefined;
  const candidates: { task: FocusTask; score: number }[] = [];
  for (const r of rank) {
    const task = taskOf(r);
    if (!task || r.score < MIN_SALIENCE || candidates.some((c) => c.task.taskId === task.taskId))
      continue;
    candidates.push({ task, score: r.score });
  }
  const active0 = candidates.filter((c) => ACTIVE_STATES.has(c.task.state));
  const pool = addressing && active0.length > 0 ? active0 : candidates;
  const top = pool[0];
  if (top)
    return {
      match: taskMatch(
        top.task,
        addressing ? "the agent you were just working with" : "the task just discussed",
      ),
      alternatives: [],
    };
  const active = ctx.tasks.filter((t) => ACTIVE_STATES.has(t.state)).sort(byRecency);
  const only = active.length === 1 ? active[0] : undefined;
  if (only) return { match: taskMatch(only, "the only active task"), alternatives: [] };
  const alts = (active.length > 0 ? active : [...ctx.tasks].sort(byRecency)).map((t) =>
    taskMatch(t, "recent task"),
  );
  return clarify(alts, "Which task do you mean?");
}

function resolveNamed(words: string[], ctx: ResolveContext): ResolveResult | undefined {
  if (words.length === 0) return undefined;
  const scored: { m: FocusMatch; s: number; at: number }[] = [];
  for (const t of ctx.tasks) {
    const s = overlap(words, `${t.title} ${t.goal?.objective ?? ""}`);
    if (s > 0) scored.push({ m: taskMatch(t, "its name matches"), s, at: t.updatedAt });
  }
  for (const g of ctx.goals) {
    const s = overlap(words, `${g.title} ${g.objective ?? ""}`);
    if (s > 0)
      scored.push({
        m: {
          runId: g.runId,
          projectId: g.projectId,
          label: `${label(g.title)} in ${label(g.projectName)}`,
          why: "goal name matches",
        },
        s,
        at: g.updatedAt ?? 0,
      });
  }
  for (const p of ctx.projects) {
    const s = overlap(words, [p.name, ...p.aliases].join(" "));
    if (s > 0)
      scored.push({
        m: { projectId: p.projectId, label: label(p.name), why: "project name matches" },
        s,
        at: 0,
      });
  }
  if (scored.length === 0) return undefined;
  scored.sort((a, b) => b.s - a.s || b.at - a.at || a.m.label.localeCompare(b.m.label));
  const [best, second] = scored;
  if (best && best.s >= 0.5 && (!second || second.s < best.s))
    return { match: best.m, alternatives: [] };
  return clarify(
    scored.map((x) => x.m),
    "Which one do you mean?",
  );
}

/** Resolve a spoken reference to ids. Low confidence asks; it never guesses. */
export function resolveReference(phrase: string, ctx: ResolveContext): ResolveResult {
  const text = phrase.toLowerCase();
  const rank = ranked(ctx.refs, ctx.tasks, ctx.now);
  if (/\bother (project|one|repo)\b/.test(text)) return resolveOther(ctx, rank);
  const win = timeWindow(text, ctx.now, ctx.tzOffsetMinutes);
  if (win) return resolveTime(text, win, ctx);
  if (DEICTIC.test(text)) return resolveDeictic(text, ctx, rank);
  return resolveNamed(tokens(text), ctx) ?? clarify([], "Which task or project do you mean?");
}

/** Up to five "Working memory" lines for the model's instructions. Ids only in brackets. */
export function focusContext(
  refs: readonly FocusRef[],
  tasks: readonly FocusTask[],
  now: number,
): string {
  const rank = ranked(refs, tasks, now).filter((r) => r.score >= MIN_SALIENCE);
  const top = (kind: FocusRef["kind"]): FocusRef | undefined =>
    rank.find((r) => r.ref.kind === kind)?.ref;
  const lines: string[] = [];
  const project = top("project");
  if (project)
    lines.push(`Working memory: current project ${speakable(project.label, 80)} [${project.id}]`);
  const task = top("task");
  if (task) lines.push(`Working memory: current task ${speakable(task.label, 80)} [${task.id}]`);
  const goal = top("goal");
  if (goal) lines.push(`Working memory: current goal ${speakable(goal.label, 80)} [${goal.id}]`);
  const result = top("result");
  if (result) {
    const state = tasks.find((t) => t.taskId === result.id)?.state ?? "finished";
    lines.push(
      `Working memory: last result ${speakable(result.label, 80)}, ${state} [${result.id}]`,
    );
  }
  const question = top("question");
  if (question)
    lines.push(
      `Working memory: open question on ${speakable(question.label, 80)} [${question.id}]`,
    );
  return lines.slice(0, 5).join("\n");
}

export const REFERENCE_TOOLS = [
  {
    type: "function",
    name: "resolve_reference",
    description:
      "Resolve what the user means by 'that', 'it', 'this', 'the agent', 'the other project', 'yesterday's issue' or a task/goal named loosely, to real ids. Always call this before acting on such a reference; never use ids from memory. If it returns needsClarification, ask its question and do not act.",
    parameters: {
      type: "object",
      properties: {
        phrase: {
          type: "string",
          description: "The user's words containing the reference, verbatim.",
        },
      },
      required: ["phrase"],
    },
  },
] as const;

export type ReferenceToolContext = ResolveContext;

export function runReferenceTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ReferenceToolContext,
): Promise<ToolResult> {
  if (name !== "resolve_reference")
    return Promise.resolve({ ok: false, output: null, error: `Unknown tool '${name}'.` });
  const phrase = str(args.phrase);
  if (!phrase)
    return Promise.resolve({
      ok: false,
      output: null,
      error: "Say which words to resolve (phrase).",
    });
  return Promise.resolve({ ok: true, output: resolveReference(phrase, ctx) });
}
