/**
 * Voice tools for EZ Coder goal runs: start one, ask how it is going, list
 * them, pick one up again, and answer the agent's questions.
 *
 * A goal is not one turn: it is done only when ezcoder's own verifier and
 * final audit pass, and even then that is the agent's claim. Progress is read
 * from the run's file on disk (`goalRuns.ts`), and only for projects in the
 * registry, so a path never comes from the model and never leaves this module.
 *
 * `tools.ts` imports this module, so nothing here value-imports `tools.ts`;
 * the helpers it owns arrive through `GoalToolContext`.
 */
import { createHash } from "node:crypto";
import type { Orchestrator } from "./dispatcher.js";
import {
  continuePrompt,
  describeGoal,
  goalProgress,
  readGoalRuns,
  runOf,
  type GoalRun,
} from "./goalRuns.js";
import type { Resolution } from "./registry.js";
import { speakable, type ConfirmationTokens } from "./safety.js";
import { TERMINAL, type StoredTask, type VoiceStore } from "./store.js";
import type { ToolResult } from "./tools.js";
import type { VoiceProject } from "./types.js";

const EZCODER = "ezcoder";
const AGENT_NAME = "EZ Coder";
/** Projects read per fuzzy search, so one question never reads hundreds of files. */
const MAX_PROJECTS_SCANNED = 60;
const FINISHED_RUN: ReadonlySet<string> = new Set(["passed", "failed"]);

export const GOAL_TOOL_NAMES = ["start_goal", "goal_status", "list_goals", "resume_goal", "answer_question"] as const;
export type GoalToolName = (typeof GOAL_TOOL_NAMES)[number];

export function isGoalTool(name: string): name is GoalToolName {
  return GOAL_TOOL_NAMES.some((n) => n === name);
}

const s = (description: string) => ({ type: "string", description }) as const;

export const GOAL_TOOLS = [
  {
    type: "function",
    name: "start_goal",
    description:
      "Start an EZ Coder goal in a project: work that keeps going, milestone by milestone, until its verifier and final audit pass. Use when the user says 'start a goal', 'keep at it until it works', or describes an outcome rather than one change. Always needs a yes: call once to get a confirmToken and question, ask it, then call again with confirmToken and userConfirmed true only after the user says yes.",
    parameters: {
      type: "object",
      properties: {
        project: s("Spoken project name or projectId."),
        objective: s("The outcome, in the user's words."),
        title: s("A few words to call it by."),
        worktree: { type: "string", enum: ["auto", "new", "current"], description: "As start_task." },
        branch: s("Optional branch name for a new worktree."),
        attachmentIds: { type: "array", items: { type: "string" }, description: "Screenshots to send with it." },
        confirmToken: s("Token from the first call."),
        userConfirmed: { type: "boolean", description: "True only if the user just said yes out loud." },
      },
      required: ["project", "objective"],
    },
  },
  {
    type: "function",
    name: "goal_status",
    description:
      "How a goal is coming along: milestones done, what is happening now, whether the verifier passed and whether anything needs the user. A goal is done only when this says passed; a finished turn is not a finished goal.",
    parameters: {
      type: "object",
      properties: {
        goal: s("What the user called the goal, if they named it."),
        project: s("Spoken project name, to narrow it."),
        taskId: s("The goal's task, if known."),
      },
      required: [],
    },
  },
  {
    type: "function",
    name: "list_goals",
    description: "Goals still in progress across the user's projects, or one project's.",
    parameters: { type: "object", properties: { project: s("Spoken project name, optional.") }, required: [] },
  },
  {
    type: "function",
    name: "resume_goal",
    description:
      "Pick up a goal that stopped (for example one started at the computer, or interrupted). Always needs a yes, like start_goal.",
    parameters: {
      type: "object",
      properties: {
        goal: s("What the user called the goal."),
        project: s("Spoken project name, to narrow it."),
        confirmToken: s("Token from the first call."),
        userConfirmed: { type: "boolean", description: "True only if the user just said yes out loud." },
      },
      required: ["goal"],
    },
  },
  {
    type: "function",
    name: "answer_question",
    description: "Answer a question an agent asked. With one question open, taskId and requestId may be left out.",
    parameters: {
      type: "object",
      properties: {
        taskId: s("The task asking."),
        requestId: s("The question's requestId."),
        answer: s("The answer, or the option the user chose."),
      },
      required: ["answer"],
    },
  },
] as const;

/** Where a new goal runs, as `start_task` decides it. A string is a speakable refusal. */
export type GoalPlacement = { target: VoiceProject; note?: string; newWorktree?: { project: string; branch: string } } | string;

export interface GoalToolContext {
  store: VoiceStore;
  orchestrator: Orchestrator;
  projects: () => Promise<VoiceProject[]>;
  usableProviders: () => string[];
  confirm: ConfirmationTokens;
  now: () => number;
  /** `goalRunsBase(env, home)`. */
  goalRunsBase: string;
  resolveProject: (query: string, projects: readonly VoiceProject[]) => Resolution;
  /** `ToolExecutor.daveGuard`: a result when the words meant the backlog, undefined to carry on. */
  daveGuard: (query: string, r: Resolution, instruction?: string, extra?: Record<string, unknown>) => ToolResult | undefined;
  /** `ToolExecutor.clarify`: "did you mean A or B?". */
  clarify: (r: Resolution) => ToolResult;
  /** Worktree placement, as `start_task`. */
  place: (
    project: VoiceProject,
    projects: readonly VoiceProject[],
    want: { mode: "auto" | "new" | "current"; branch: string },
  ) => Promise<GoalPlacement>;
  /** A conversational reference ("that goal") to ids; undefined when nothing resolves confidently. */
  focusResolve?: (phrase: string) => { taskId?: string; projectId?: string; runId?: string } | undefined;
  /** `taskView` from tools.ts. */
  taskView: (task: StoredTask) => unknown;
  /** Screenshot ids that exist, or a speakable error. */
  attachments?: (args: Record<string, unknown>) => string[] | string;
}

const good = (output: unknown): ToolResult => ({ ok: true, output });
const fail = (error: string): ToolResult => ({ ok: false, output: { error }, error });

function arg(args: Record<string, unknown>, key: string, max: number): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
}

export function goalSubject(projectId: string, objective: string): string {
  return `goal:${projectId}:${createHash("sha256").update(objective).digest("hex").slice(0, 12)}`;
}

const tokens = (text: string) => new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));

/** Share of the query's words found in the text; 0 when nothing matches. */
function overlap(query: string, text: string): number {
  const q = tokens(query);
  if (q.size === 0) return 0;
  const t = tokens(text);
  let hit = 0;
  for (const w of q) if (t.has(w)) hit++;
  return hit / q.size;
}

interface FoundRun {
  project: VoiceProject;
  run: GoalRun;
}

/** Runs across the registry (or the given projects), newest first, deterministic. */
async function registryRuns(ctx: GoalToolContext, projects: readonly VoiceProject[]): Promise<FoundRun[]> {
  const scanned = [...projects].sort((a, b) => a.projectId.localeCompare(b.projectId)).slice(0, MAX_PROJECTS_SCANNED);
  const lists = await Promise.all(scanned.map(async (project) => (await readGoalRuns(ctx.goalRunsBase, project.path)).map((run) => ({ project, run }))));
  return lists.flat().sort((a, b) => b.run.updatedAt.localeCompare(a.run.updatedAt) || a.run.id.localeCompare(b.run.id));
}

/** The live goal task holding a run, if any. */
function taskForRun(store: VoiceStore, runId: string): StoredTask | undefined {
  return store.tasks().find((t) => t.goal?.runId === runId && !TERMINAL.has(t.state));
}

function liveOf(ctx: GoalToolContext, task: StoredTask | undefined) {
  return {
    working: task?.state === "running",
    agentName: AGENT_NAME,
    approvals: task?.approval ? 1 : 0,
    ...(task?.question ? { question: task.question.text } : null),
  };
}

function runView(found: FoundRun, task: StoredTask | undefined, ctx: GoalToolContext) {
  const progress = goalProgress(found.run);
  const live = liveOf(ctx, task);
  const say = describeGoal(progress, task && !TERMINAL.has(task.state) ? live : undefined);
  return {
    runId: found.run.id,
    title: progress.title,
    project: found.project.name,
    projectId: found.project.projectId,
    ...(task ? { taskId: task.taskId, taskState: task.state } : null),
    progress,
    say,
    live: { working: live.working, approvals: live.approvals, ...(live.question ? { question: live.question } : null) },
    nothingNeedsYou: !progress.needsYou && !live.question && live.approvals === 0,
  };
}

/** Narrow the registry to what the user named; a result is a clarification to return. */
async function projectsFor(ctx: GoalToolContext, query: string | undefined): Promise<VoiceProject[] | ToolResult> {
  const all = await ctx.projects();
  if (!query) return all;
  const r = ctx.resolveProject(query, all);
  const meant = ctx.daveGuard(query, r);
  if (meant) return meant;
  if (!r.best) return ctx.clarify(r);
  return [r.best];
}

/** Pick a run by what the user called it. A result is a clarification. */
function pickRun(found: readonly FoundRun[], phrase: string | undefined): FoundRun | ToolResult | undefined {
  if (found.length === 0) return undefined;
  if (!phrase) return found.length === 1 ? found[0] : undefined;
  const scored = found
    .map((f) => ({ f, score: Math.max(overlap(phrase, f.run.title), overlap(phrase, f.run.goal) * 0.9) }))
    .filter((x) => x.score >= 0.34)
    .sort((a, b) => b.score - a.score);
  const first = scored[0];
  if (!first) return undefined;
  const second = scored[1];
  if (second && first.score - second.score < 0.15) {
    const names = scored.slice(0, 3).map((x) => `${speakable(x.f.run.title, 50)} in ${x.f.project.name}`);
    return good({ needsClarification: true, question: `Did you mean ${names.join(" or ")}?` });
  }
  return first.f;
}

async function startGoal(args: Record<string, unknown>, ctx: GoalToolContext): Promise<ToolResult> {
  const query = arg(args, "project", 100);
  const objective = arg(args, "objective", 2000);
  if (!query || !objective) return fail("project and objective are required.");
  const projects = await ctx.projects();
  const r = ctx.resolveProject(query, projects);
  const meant = ctx.daveGuard(query, r, objective, { started: false });
  if (meant) return meant;
  if (!r.best) return ctx.clarify(r);
  const project = r.best;
  if (!ctx.usableProviders().includes(EZCODER)) return fail("EZ Coder isn't available on the computer, and goals need it.");
  const repoId = project.worktree?.repoId;
  const duplicate = ctx.store
    .tasks()
    .find(
      (t) =>
        !TERMINAL.has(t.state) &&
        t.goal?.objective === objective &&
        (t.projectId === project.projectId || (t.repo?.projectId !== undefined && (t.repo.projectId === project.projectId || t.repo.projectId === repoId))),
    );
  if (duplicate) return good({ started: false, duplicate: true, task: ctx.taskView(duplicate) });
  const shots = ctx.attachments ? ctx.attachments(args) : [];
  if (typeof shots === "string") return fail(shots);

  const subject = goalSubject(project.projectId, objective);
  const confirmed = args.userConfirmed === true && ctx.confirm.redeem(arg(args, "confirmToken", 40), subject);
  if (!confirmed) {
    return good({
      started: false,
      needsConfirmation: true,
      confirmToken: ctx.confirm.issue(subject),
      question: `Start a goal in ${project.name}: ${speakable(objective, 160)}? It keeps working until it's verified.`,
    });
  }
  const title = arg(args, "title", 80) ?? speakable(objective, 60);
  const mode = args.worktree === "new" || args.worktree === "current" ? args.worktree : "auto";
  const placed = await ctx.place(project, projects, { mode, branch: arg(args, "branch", 60) ?? title });
  if (typeof placed === "string") return fail(placed);
  const { target } = placed;
  const repo = target.worktree
    ? {
        name: target.worktree.repo,
        ...(target.worktree.repoId ? { projectId: target.worktree.repoId } : null),
        ...(target.worktree.branch ? { branch: target.worktree.branch } : null),
      }
    : undefined;
  const task = ctx.orchestrator.enqueue({
    projectId: target.projectId,
    projectName: target.name,
    ...(repo ? { repo } : null),
    cwd: target.path,
    providerId: EZCODER,
    title,
    prompt: `/goal ${objective}${placed.note ? `\n\n${placed.note}` : ""}`,
    ...(shots.length ? { attachmentIds: shots } : null),
    goal: { objective, requestedAt: ctx.now(), continues: 0 },
  });
  return good({
    started: true,
    ...(placed.newWorktree ? { newWorktree: placed.newWorktree } : null),
    task: ctx.taskView(task),
    note: "A goal is done only when goal_status says passed.",
  });
}

async function goalStatus(args: Record<string, unknown>, ctx: GoalToolContext): Promise<ToolResult> {
  const phrase = arg(args, "goal", 200);
  let taskId = arg(args, "taskId", 40);
  let runId: string | undefined;
  if (!taskId && phrase && ctx.focusResolve) {
    const ref = ctx.focusResolve(phrase);
    taskId = ref?.taskId;
    runId = ref?.runId;
  }
  const projects = await projectsFor(ctx, arg(args, "project", 100));
  if (!Array.isArray(projects)) return projects;

  if (taskId) {
    const task = ctx.store.getTask(taskId);
    if (!task) return fail(`No task ${taskId}.`);
    if (!task.goal) return fail("That task is not a goal; use task_status.");
    const project = (await ctx.projects()).find((p) => p.projectId === task.projectId);
    const run = runOf(task.goal, await readGoalRuns(ctx.goalRunsBase, task.cwd));
    if (!run || !project) {
      return good({
        taskId: task.taskId,
        taskState: task.state,
        found: false,
        say: describeGoal(task.goal.progress ?? { done: 0, total: 0 }, TERMINAL.has(task.state) ? undefined : liveOf(ctx, task)),
      });
    }
    return good(runView({ project, run }, task, ctx));
  }

  const found = await registryRuns(ctx, projects);
  if (runId) {
    const hit = found.find((f) => f.run.id === runId);
    if (hit) return good(runView(hit, taskForRun(ctx.store, hit.run.id), ctx));
  }
  const active = found.filter((f) => !FINISHED_RUN.has(f.run.status));
  const pick = pickRun(phrase ? found : active.length ? active : found.slice(0, 1), phrase);
  if (!pick) return good({ found: false, say: phrase ? "No goal by that name in your projects." : "There are no goals in progress." });
  if ("ok" in pick) return pick;
  return good(runView(pick, taskForRun(ctx.store, pick.run.id), ctx));
}

async function listGoals(args: Record<string, unknown>, ctx: GoalToolContext): Promise<ToolResult> {
  const projects = await projectsFor(ctx, arg(args, "project", 100));
  if (!Array.isArray(projects)) return projects;
  const active = (await registryRuns(ctx, projects)).filter((f) => !FINISHED_RUN.has(f.run.status));
  return good({
    goals: active.slice(0, 10).map((f) => {
      const p = goalProgress(f.run);
      const task = taskForRun(ctx.store, f.run.id);
      return {
        runId: f.run.id,
        title: p.title,
        project: f.project.name,
        status: p.status,
        done: p.done,
        total: p.total,
        ...(p.unit ? { unit: p.unit } : null),
        ...(p.needsYou ? { needsYou: p.needsYou } : null),
        ...(task ? { taskId: task.taskId } : null),
      };
    }),
    ...(active.length > 10 ? { more: active.length - 10 } : null),
  });
}

async function resumeGoal(args: Record<string, unknown>, ctx: GoalToolContext): Promise<ToolResult> {
  const phrase = arg(args, "goal", 200);
  if (!phrase) return fail("goal is required.");
  const projects = await projectsFor(ctx, arg(args, "project", 100));
  if (!Array.isArray(projects)) return projects;
  const ref = ctx.focusResolve?.(phrase);
  const found = (await registryRuns(ctx, projects)).filter((f) => !FINISHED_RUN.has(f.run.status));
  const pick = (ref?.runId ? found.find((f) => f.run.id === ref.runId) : undefined) ?? pickRun(found, phrase);
  if (!pick) return good({ resumed: false, say: "No unfinished goal by that name in your projects." });
  if ("ok" in pick) return pick;
  const { project, run } = pick;
  const holder = taskForRun(ctx.store, run.id);
  if (holder) return good({ resumed: false, duplicate: true, task: ctx.taskView(holder) });
  if (!ctx.usableProviders().includes(EZCODER)) return fail("EZ Coder isn't available on the computer, and goals need it.");
  const subject = `resume_goal:${project.projectId}:${run.id}`;
  const confirmed = args.userConfirmed === true && ctx.confirm.redeem(arg(args, "confirmToken", 40), subject);
  const title = speakable(run.title, 80);
  if (!confirmed) {
    return good({
      resumed: false,
      needsConfirmation: true,
      confirmToken: ctx.confirm.issue(subject),
      question: `Pick up the goal ${title} in ${project.name}? It keeps working until it's verified.`,
    });
  }
  const task = ctx.orchestrator.enqueue({
    projectId: project.projectId,
    projectName: project.name,
    cwd: project.path,
    providerId: EZCODER,
    title,
    prompt: continuePrompt(run.id, title),
    goal: { objective: run.goal, requestedAt: ctx.now(), runId: run.id, continues: 0 },
  });
  return good({ resumed: true, task: ctx.taskView(task) });
}

function answerQuestion(args: Record<string, unknown>, ctx: GoalToolContext): ToolResult {
  const answer = arg(args, "answer", 1000);
  if (!answer) return fail("answer is required.");
  let taskId = arg(args, "taskId", 40);
  if (!taskId && ctx.focusResolve) {
    const ref = ctx.focusResolve("that question");
    if (ref?.taskId && ctx.store.getTask(ref.taskId)?.question) taskId = ref.taskId;
  }
  const open = ctx.store.tasks().filter((t) => t.question);
  const task = taskId ? ctx.store.getTask(taskId) : open.length === 1 ? open[0] : undefined;
  if (!task) {
    if (open.length === 0) return fail("No agent is waiting on a question.");
    return good({
      needsClarification: true,
      question: `Which one: ${open.slice(0, 3).map((t) => t.title).join(" or ")}?`,
      candidates: open.map((t) => ({ taskId: t.taskId, title: t.title, question: t.question?.text })),
    });
  }
  const requestId = arg(args, "requestId", 80) ?? task.question?.requestId;
  if (!requestId) return fail("Stale: that task is not waiting on a question any more.");
  const r = ctx.orchestrator.answerQuestion(task.taskId, requestId, answer);
  return r.ok ? good({ answered: true, task: ctx.taskView(r.value) }) : fail(r.error);
}

/** Run one goal tool. Errors become results, like every other voice tool. */
export async function runGoalTool(name: string, args: Record<string, unknown>, ctx: GoalToolContext): Promise<ToolResult> {
  try {
    switch (name) {
      case "start_goal":
        return await startGoal(args, ctx);
      case "goal_status":
        return await goalStatus(args, ctx);
      case "list_goals":
        return await listGoals(args, ctx);
      case "resume_goal":
        return await resumeGoal(args, ctx);
      case "answer_question":
        return answerQuestion(args, ctx);
      default:
        return fail(`Unknown goal tool ${name}.`);
    }
  } catch (error) {
    return fail(speakable(error instanceof Error ? error.message : String(error), 160));
  }
}
