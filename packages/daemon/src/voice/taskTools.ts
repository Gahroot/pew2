/**
 * The Realtime model's hands: function-tool definitions, the executor behind
 * them, the session instructions and the session config.
 *
 * Every result is small JSON. The model never sees paths, source or raw logs,
 * and never supplies a working directory — projects are named and resolved
 * against the registry.
 */
import { coalesce } from "./classify.js";
import { BACKLOG_TOOLS, runBacklogTool, backlogToolName, type DaveClient } from "./dave.js";
import { isDaveProject, routeDave } from "./daveIntent.js";
import { noteToolCall, REFERENCE_TOOLS, resolveReference, runReferenceTool, type FocusGoal, type ResolveContext } from "./focus.js";
import { GOAL_TOOLS, isGoalTool, runGoalTool, type GoalToolContext } from "./goalTools.js";
import { placeFields, placeSpoken } from "./place.js";
import type { Orchestrator } from "./dispatcher.js";
import { branchName, chooseProvider, groupByRepo, projectIdFor, repoOf, resolveProject, worktreesOf } from "./registry.js";
import {
  ConfirmationTokens,
  DEFAULT_POLICY,
  needsConfirmation,
  needsExplicitApproval,
  type ApprovalPolicy,
  DEFAULT_APPROVAL_POLICY,
  speakable,
  type SafetyPolicy,
} from "./safety.js";
import { wire } from "@pew2/protocol";
import { ACTIVE, TERMINAL, type StoredScreenshot, type StoredTask, type VoiceStore } from "./store.js";
import { basename } from "node:path";
import type { CreatedWorktree, Result } from "../worktree-create.js";
import type { RegisteredWorktree } from "../worktree.js";
import type { RunningSession, SessionPeek, VoiceProject } from "./types.js";

// ---- definitions -----------------------------------------------------------

/** A type, not an interface, so a list of them passes as plain JSON objects (`buildSessionConfig`). */
type ToolDef = {
  type: "function";
  name: string;
  description: string;
  parameters: { type: "object"; properties: Record<string, unknown>; required: readonly string[] };
};

const str = (description: string) => ({ type: "string", description });
const def = (
  name: string,
  description: string,
  properties: Record<string, unknown> = {},
  required: string[] = [],
): ToolDef => ({ type: "function", name, description, parameters: { type: "object", properties, required } });

const CORE_TOOLS: readonly ToolDef[] = [
  def("list_projects", "List projects the user can name."),
  def("resolve_project", "Match a spoken project name (partial, misheard or any case is fine). One clear match: use it, don't ask. Ambiguous: ask one short 'did you mean A or B?'. Not for the backlog ('check the backlog', 'checking Dave'): that is check_backlog.", { query: str("What the user said.") }, ["query"]),
  def(
    "start_task",
    "Start a coding task in a project. Each new feature or fix is its own task, and like EZ Coder each one runs in a fresh worktree on its own branch, so tasks never queue behind or touch each other (see worktree). Use follow_up for more work on an existing task.",
    {
      project: str("Spoken project name or projectId."),
      worktree: {
        type: "string",
        enum: ["auto", "new", "current"],
        description: "auto (default): a new worktree for every task that edits, except read-only work (stays in the main checkout), a named branch (runs there) and a task that depends on another (runs in that one's worktree). new: a new worktree even for those. current: run in the checkout named, even if it means waiting.",
      },
      branch: str("Optional branch name for a new worktree, a few words; defaults to the title."),
      instruction: str("What the coding agent should do, as the user said it."),
      title: str("Optional short title."),
      priority: { type: "integer", description: "Higher runs first. Default 0." },
      dependsOn: { type: "array", items: { type: "string" }, description: "taskIds that must complete first." },
      readOnly: { type: "boolean", description: "True if the task only reads and never edits." },
      attachmentIds: { type: "array", items: { type: "string" }, description: "Screenshots to send with it, by attachmentId from list_screenshots." },
    },
    ["project", "instruction"],
  ),
  def(
    "follow_up",
    "Send another instruction to an existing task, including a debrief's followUp once the user accepts its nextStep.",
    {
      taskId: str("Task id. Optional when the conversation makes the task clear; the result names the one it went to."),
      instruction: str("The instruction."),
      attachmentIds: { type: "array", items: { type: "string" }, description: "Screenshots to send with it, by attachmentId from list_screenshots." },
    },
    ["instruction"],
  ),
  def("task_status", "Fresh status of one task. Omit taskId when only one task is active.", { taskId: str("Task id.") }),
  def(
    "whats_running",
    "What is happening on the computer right now: voice tasks plus every agent conversation already open, including sessions running at the desk (in a terminal on the computer) and ones started in the app. Use for 'what's running', 'anything going on', 'what's the status'. For detail on one, call peek_session with its sessionRef.",
  ),
  def(
    "peek_session",
    "What an open conversation is doing right now: its last request, latest reply and current tool.",
    { sessionRef: str("From whats_running. Optional when exactly one conversation is working.") },
  ),
  def("list_tasks", "List tasks, newest first.", {
    state: str("Filter by state."),
    projectId: str("Filter by project; a repository includes its worktrees."),
    limit: { type: "integer", description: "Max 10." },
  }),
  def("reprioritize_task", "Change the priority of a queued task.", { taskId: str("Task id."), priority: { type: "integer" } }, ["taskId", "priority"]),
  def("pause_task", "Pause a task (stops the agent's current turn).", { taskId: str("Task id.") }, ["taskId"]),
  def("resume_task", "Resume a paused task.", { taskId: str("Task id.") }, ["taskId"]),
  def(
    "cancel_task",
    "Cancel a task. A running task needs confirmation: call once, ask the user, then call again with confirmToken and userConfirmed true.",
    { taskId: str("Task id."), confirmToken: str("Token from the first call."), userConfirmed: { type: "boolean" } },
    ["taskId"],
  ),
  def("verify_task", "Mark a completed task verified, only after the user or a check confirmed the result.", { taskId: str("Task id."), note: str("What confirmed it.") }, ["taskId"]),
  def("pending_approvals", "List approvals the agents are waiting on, each with a plain-words 'say' sentence, a risk and whether it is safe (read-only)."),
  def(
    "approve_safe",
    "Approve every pending request that is clearly read-only and inside the project. Risky ones are left untouched and reported. Use for 'approve all safe ones'.",
  ),
  def(
    "set_approval_policy",
    "Turn hands-free auto-approval of clearly read-only requests on or off for this voice session. Risky requests are always asked about.",
    { autoApproveSafe: { type: "boolean" } },
    ["autoApproveSafe"],
  ),
  def(
    "answer_approval",
    "Approve or deny an agent's request. Risky approvals (merge, deploy, destructive) return a confirmToken first: ask the user, then call again with confirmToken and userConfirmed true.",
    {
      taskId: str("Task id. Optional when exactly one approval is pending."),
      requestId: str("The requestId from pending_approvals. Optional when exactly one approval is pending."),
      decision: { type: "string", enum: ["approve", "deny"] },
      confirmToken: str("Token from the first call."),
      userConfirmed: { type: "boolean", description: "True only if the user just said yes out loud." },
    },
    ["decision"],
  ),
  def("recent_events", "Recent events, optionally for one task. Only when the user asks.", {
    taskId: str("Task id."),
    sinceEventId: { type: "integer" },
    limit: { type: "integer", description: "Max 10." },
  }),
  def("get_details", "More detail on one task: history, last output, errors.", { taskId: str("Task id.") }, ["taskId"]),
  def("remember_decision", "Persist a decision or instruction the user wants kept.", { text: str("The decision."), taskId: str("Related task.") }, ["text"]),
  def("add_project_alias", "Remember another spoken name for a project.", { projectId: str("Project id."), alias: str("The name.") }, ["projectId", "alias"]),
  def("list_screenshots", "Screenshots the user has shared, newest first, with which tasks each was sent to."),
  def(
    "attach_screenshot",
    "Send a shared screenshot to an existing task's coding agent, with what to do with it. For new work use start_task with attachmentIds instead.",
    {
      attachmentId: str("From list_screenshots. Optional when exactly one screenshot is unsent."),
      taskId: str("Task id. Optional when exactly one task is active."),
      instruction: str("What the agent should do with it, as the user said it."),
    },
  ),
  def(
    "create_worktree",
    "Make a new worktree of a repository: a separate checkout on a fresh branch, so work there never touches other agents'. Only when the user asks for one on its own; start_task makes them as needed.",
    { project: str("Spoken repository name or projectId."), branch: str("Branch name, a few words. Optional.") },
    ["project"],
  ),
  def(
    "list_worktrees",
    "Every worktree of one repository, with what is running in each. Use for 'what branches does X have', or when list_projects says moreBranches.",
    { project: str("Spoken repository name or projectId.") },
    ["project"],
  ),
  def(
    "commit",
    "Commit work when the user says commit, in any words. Runs EZ Coder's /commit command (checks, review, commit, and push if the branch has an upstream) in the task's own checkout. Pass taskId, or project when no task did the work.",
    {
      taskId: str("Task whose changes to commit. Optional when exactly one task could mean it."),
      project: str("Spoken project or branch, when no task is meant."),
      note: str("Anything the user added, e.g. a message to use. Optional."),
    },
  ),
];

/**
 * Tools a call has the call layer's own version of, so they are not offered
 * twice: approvals and questions go through `list_waiting`, `answer_permission`
 * and `answer_question` (every voice task is an ordinary session, so its
 * approvals are in that inbox). The executor still answers them, which the
 * approval tests rely on.
 */
const CALL_LAYER_OWNS: ReadonlySet<string> = new Set(["pending_approvals", "answer_approval", "answer_question"]);

/** The task tools a call is given beside its own: core, then goals and references. */
export const TASK_TOOLS: readonly ToolDef[] = [...CORE_TOOLS, ...GOAL_TOOLS, ...REFERENCE_TOOLS].filter(
  (tool) => !CALL_LAYER_OWNS.has(tool.name),
);

/**
 * Whether a call's tool call is a task tool, the backlog's included. A
 * function, not a set built at load: `dave.ts` imports this module, so
 * `BACKLOG_TOOLS` is not initialised yet while this one loads.
 */
export function isTaskTool(name: string): boolean {
  return TASK_TOOLS.some((t) => t.name === name) || BACKLOG_TOOLS.some((t) => t.name === name);
}

/** The task tools for one call; DAVE's only when the host has a DAVE client. */
export function callTools(options: { backlogTools?: boolean } = {}): readonly ToolDef[] {
  return options.backlogTools ? [...TASK_TOOLS, ...BACKLOG_TOOLS] : TASK_TOOLS;
}

// ---- instructions -----------------------------------------------------------

/**
 * How to use the task tools, added after the call's own instructions. Those
 * own the persona, the pacing, approvals, questions and hanging up; this only
 * covers tasks, goals, worktrees, commits, screenshots and DAVE.
 */
export const TASK_INSTRUCTIONS = [
  "Tasks:",
  "- Besides the chats, you can run tracked tasks. A task is a piece of work you hand to a coding agent with start_task: it runs in its own worktree on its own branch, can queue behind or depend on another, and reports back with a debrief. Use start_task for new work they ask for (a feature, a fix, a change), and follow_up for more on a task that exists. Use tell_agent for a chat that is open, and start_chat only when they ask to start a chat.",
  "- Acknowledge in one short sentence, like 'Sent to billing.' When the result has newWorktree, say so briefly ('Started in Triton OS on a new branch, add dark mode').",
  "- When a task completes, use its debrief. Say in a sentence what the agent did, from 'said' plus edits and checks in plain words, then offer the debrief's nextStep as one yes/no question. If they say yes, call follow_up with the debrief's followUp text. If the outcome is 'question', the agent is waiting on them: put its question to them plainly and send their answer with follow_up. If there is no nextStep, just report and stop. checks 'ran' means a check ran and the agent reported no failure; say 'it ran the tests', never 'tests pass'. Offer one next step at a time, and drop it if they decline or sound done.",
  "- When a task fails, say why in plain words and offer one way forward: try again, or a different approach.",
  "- System messages starting '[Update]' are news about a task. Tell them at the next pause, briefly, by the rules above. If you already told them that, say nothing.",
  "- Never say a task is done, merged, deployed or fixed until a tool result says the agent reported it. 'Completed' means the agent says it finished, not that it is verified; say so plainly. Only call verify_task after they or a check confirmed the result.",
  "- Call task_status before acting on a task you have not checked this call; state changes while you talk.",
  "- Never say project ids, task ids, request ids, tokens, file paths, URLs, hashes or code aloud.",
  "Projects and branches:",
  "- Pass what they said to start_task or resolve_project; partial, misheard and differently cased names are matched for you. One clear match: proceed. Ambiguous: ask once, 'Did you mean A or B?', naming at most three. Never guess between close matches.",
  "- list_projects gives one entry per repository, with its worktrees as branches under it. The repository's plain name means the main checkout; to work on a branch, pass its projectId or say the repository and branch ('billing, fix login'). Report work on a branch as that repository's ('billing, on the fix login branch, is done'), never as a separate project, and never say a folder id like 'ez-mun7ig9t': those are EZ Coder's worktrees of a repository.",
  "- Pass worktree 'current' only when they want it in the main checkout itself, and dependsOn when it should build on another task's unfinished work. create_worktree is only for 'make a worktree of X' on its own; list_worktrees answers what branches a repository has and what is running in each.",
  "- For 'what's running' across the computer, including conversations started at the desk, call whats_running; for one of those, peek_session.",
  "Commit:",
  "- Whenever they say commit, in any words, call commit; never describe the steps in a message yourself. Pass the taskId of the work they mean, or the project when no task did it; if several tasks could be meant, ask which. Never say it is committed until the result says the agent finished.",
  "Goals:",
  "- When they say 'start a goal' or 'keep at it until it works', or describe an outcome to reach rather than one change, call start_goal; it always needs a yes. A goal runs turn after turn until EZ Coder's verifier and final audit pass, so a finished turn is not a finished goal: a goal is done only when goal_status says passed, and even then it is the agent's report. For 'how's X coming along' about a goal, call goal_status and say its 'say' sentence. list_goals lists goals in progress; resume_goal picks one up again.",
  "References:",
  "- Whenever they point at a task without naming it ('that', 'it', 'the other project', 'yesterday's issue'), call resolve_reference with their words before acting, and use the ids it returns, never ids from memory. If it says needsClarification, ask its question and wait. 'Working memory:' lines below are what the last calls were about.",
  "Approvals on tasks:",
  "- A task's approvals are in list_waiting like any other. 'Approve all safe ones' means approve_safe; 'stop asking about safe ones' means set_approval_policy. Risky requests are never auto-approved. Cancelling a running task needs a confirmToken: call cancel_task once, ask 'Are you sure?', and call again with userConfirmed true only after they say yes. Never reuse or invent tokens.",
  "Screenshots:",
  "- Screenshots they shared in the app are listed by list_screenshots. You never see the picture. Send one with start_task or follow_up attachmentIds, or attach_screenshot for a task already running, with what they want done. Never describe what is in it.",
  "Check-in:",
  "- If there is a 'Check-in:' line below and nothing is waiting, open with it in those words instead of the plain greeting, then wait. Say nothing about what they already heard.",
  "The backlog (DAVE):",
  "- The backlog is their to-do list, kept by DAVE, their portfolio and priorities assistant. Check it with check_backlog only when they ask, in any words ('check the backlog', 'what's on the backlog', 'check in with Dave', 'checking Dave', 'what does Dave think I should do', 'what's next on my to-do list', 'what did I promise Acme'); never on your own, at the start of a call or to fill silence. A Check-in line may say DAVE has a new recommendation for a project; call check_backlog only if they then want the details.",
  "- Summarise what DAVE says in two or three sentences, and present its ranking as DAVE's recommendation, not a fact. If DAVE isn't available, say so plainly. You may offer to hand one of its coding objectives to EZ Coder as a single yes/no question; call delegate_backlog_item's second step only after an explicit yes, and never for a step DAVE marks as their own.",
  "- For 'what should I do next', use check_backlog with about 'next': say DAVE's one recommendation and ask a single yes/no, without lecturing; mention an alternative only if asked. For 'what moved' or 'how's progress', use about 'progress' and name the window it gives you ('since you last asked', 'in the last day' or a date). On a yes, act_on_backlog changes only DAVE's own records (do it, skip, defer); a hand-off to EZ Coder is delegate_backlog_item, never act_on_backlog. clean_up_backlog previews first, then clears exactly the previewed keys after a spoken yes; undo_backlog_clean_up brings them back. Every second step needs an explicit yes; if a result says stale, check the backlog again.",
  "- The backlog is not the project named dave. Saying backlog ('check the backlog', 'next on the backlog'), talking to or about Dave as a person ('checking Dave', 'ask Dave', 'Dave says', 'Dave's list'), or asking for the next items on their to-do list or their priorities, means check_backlog with about 'priorities', never start_task, list_tasks or resolve_project. Only words about the code mean the project: opening or working on it ('open the dave project', 'work on dave', 'the dave repo', 'in dave') or a coding instruction aimed at it; then use the project tools as for any project. If a result says meantBacklog, do what its next says; if it asks which, put the question to them.",
].join("\n");

// ---- executor --------------------------------------------------------------

export interface ToolCall {
  callId: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  ok: boolean;
  output: unknown;
  error?: string;
}

const RANK = { needs_you: 2, working: 1, idle: 0 } as const;

/** Where a conversation began, in the user's words. */
function startedAt(s: RunningSession): "computer" | "app" {
  return s.origin === "desktop" ? "computer" : "app";
}

/** The project whose directory holds `cwd`, longest path winning so a worktree beats its repository. */
export function projectForPath(cwd: string, projects: readonly VoiceProject[]): VoiceProject | undefined {
  const inside = (root: string) => cwd === root || cwd.startsWith(root.endsWith("/") ? root : `${root}/`);
  return projects.filter((p) => inside(p.path)).sort((a, b) => b.path.length - a.path.length)[0];
}

export interface ToolDeps {
  store: VoiceStore;
  orchestrator: Orchestrator;
  /** Fresh project list; called before any command that acts on a project. */
  projects: () => Promise<VoiceProject[]>;
  /** Usable agent ids, to pick a provider for a project. */
  usableProviders: () => string[];
  lastUsedProvider?: () => string | undefined;
  rememberAlias: (path: string, alias: string) => Promise<void>;
  /** Conversations open in the daemon, whoever started them; absent in older hosts and tests. */
  runningSessions?: () => RunningSession[];
  /** What one open conversation is doing now, by `RunningSession.sessionId`; absent in older hosts. */
  peekSession?: (sessionId: string) => SessionPeek | undefined;
  confirm?: ConfirmationTokens;
  policy?: SafetyPolicy;
  /** Per-voice-session approval policy; the executor owns one when not given. */
  approvalPolicy?: { get: () => ApprovalPolicy; set: (p: ApprovalPolicy) => void };
  /** DAVE, asked only when the model calls a DAVE tool; absent when turned off. */
  dave?: DaveClient;
  /** Make a new worktree of a main checkout; absent means voice cannot (older hosts, tests). */
  createWorktree?: (root: string, branch?: string) => Promise<Result<CreatedWorktree>>;
  /** Linked worktrees git has on record for a main checkout. */
  registeredWorktrees?: (root: string) => Promise<RegisteredWorktree[]>;
  /** Where EZ Coder keeps goal runs (`goalRunsBase`); absent means the goal tools cannot read them. */
  goalRunsBase?: string;
  /** Local time minus UTC in minutes, for "yesterday" and "this morning"; defaults to the host's zone. */
  tzOffsetMinutes?: () => number;
  now?: () => number;
}

function text(args: Record<string, unknown>, key: string, max = 2000): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
}

function int(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : undefined;
}

const { MAX_ATTACHMENTS } = wire;

export function taskView(store: VoiceStore, t: StoredTask) {
  const waiting = t.state === "queued" ? store.waitingFor(t) : undefined;
  return {
    taskId: t.taskId,
    // The repository, with the branch beside it: work on a branch is that
    // project's work, and the model reports it that way.
    ...placeFields(t),
    title: t.title,
    state: t.state,
    priority: t.priority,
    ...(t.activity ? { activity: t.activity } : null),
    ...(t.approval ? { approval: t.approval } : null),
    ...(waiting ? { waiting } : null),
    ...(t.error ? { error: t.error } : null),
    ...(t.interrupted ? { interrupted: true } : null),
    ...(t.state === "completed" ? { note: "Agent says finished; not verified." } : null),
    ...(t.debrief && t.state === "completed" ? { debrief: t.debrief } : null),
    ...(t.attachmentIds?.length ? { screenshots: t.attachmentIds.length } : null),
    ...(t.pendingAttachmentIds?.length ? { screenshotsWaiting: t.pendingAttachmentIds.length } : null),
    // A goal is not one turn: its progress, not the task state, says how far it got.
    ...(t.goal ? { goal: goalView(t) } : null),
    ...(t.question ? { question: { requestId: t.question.requestId, text: t.question.text, ...(t.question.options?.length ? { options: t.question.options } : null) } } : null),
  };
}

function goalView(t: StoredTask) {
  const p = t.goal?.progress;
  if (!p) return { note: "The goal run has not been found yet." };
  return {
    done: p.done,
    total: p.total,
    ...(p.unit ? { unit: p.unit } : null),
    ...(p.status ? { status: p.status } : null),
    ...(p.verified ? { verified: p.verified } : null),
    ...(p.needsYou ? { needsYou: p.needsYou } : null),
    ...(p.say ? { say: p.say } : null),
    ...(p.status === "passed" ? null : { note: "Not done until goal_status says passed." }),
  };
}

/** Goal runs the conversation can name, from goal tasks only: no file read per reference. */
function focusGoals(tasks: readonly StoredTask[]): FocusGoal[] {
  return tasks.flatMap((t) =>
    t.goal?.runId
      ? [
          {
            runId: t.goal.runId,
            title: t.goal.progress?.title ?? t.title,
            objective: t.goal.objective,
            projectId: t.projectId,
            projectName: t.projectName,
            ...(t.goal.progress?.status ? { status: t.goal.progress.status } : null),
            updatedAt: t.updatedAt,
          },
        ]
      : [],
  );
}

/** A screenshot as the model sees it: never a path. */
function screenshotView(store: VoiceStore, shot: StoredScreenshot) {
  return {
    attachmentId: shot.attachmentId,
    name: shot.name,
    sentTo: shot.sentTo.map((taskId) => {
      const task = store.getTask(taskId);
      return task ? { taskId, title: task.title, ...placeFields(task) } : { taskId };
    }),
  };
}

/**
 * The screenshot a call names, or the one obvious one when it names none:
 * exactly one not yet sent anywhere. Otherwise a reason to ask.
 */
function pickScreenshot(store: VoiceStore, attachmentId: string | undefined): StoredScreenshot | string {
  if (attachmentId) return store.screenshot(attachmentId) ?? `No screenshot ${attachmentId}. Call list_screenshots.`;
  const unsent = store.screenshots().filter((shot) => shot.sentTo.length === 0);
  if (unsent.length === 1 && unsent[0]) return unsent[0];
  return unsent.length === 0
    ? "There is no unsent screenshot. They can share one from the Tasks screen in the app."
    : "Several screenshots are unsent; pass attachmentId from list_screenshots.";
}

/**
 * `attachmentIds` from a call, checked: each must be one the user actually
 * shared, and no more than a prompt can carry. Ids only — a model can name a
 * screenshot, never a file.
 */
function attachmentsOf(store: VoiceStore, args: Record<string, unknown>): string[] | string {
  const raw = args.attachmentIds;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return "attachmentIds must be a list of ids.";
  const ids = [...new Set(raw.filter((id): id is string => typeof id === "string" && id.trim() !== "").map((id) => id.trim()))];
  if (ids.length > MAX_ATTACHMENTS) return `At most ${MAX_ATTACHMENTS} screenshots go with one instruction.`;
  const unknown = ids.find((id) => !store.screenshot(id));
  return unknown ? `No screenshot ${unknown}. Call list_screenshots.` : ids;
}

/** "Did you mean A or B?" for at most three names. */
export function didYouMean(names: readonly string[]): string {
  const list = names.slice(0, 3);
  if (list.length <= 1) return `Did you mean ${list[0] ?? "a different project"}?`;
  return `Did you mean ${list.slice(0, -1).join(", ")} or ${list[list.length - 1]}?`;
}

/** The agent whose `/commit` voice runs by default: EZ Coder's global command. */
export const COMMIT_PROVIDER = "ezcoder";

/**
 * What "commit" is sent as. To EZ Coder, its own `/commit` command, verbatim at
 * the start of the prompt: that is the only form it expands (checks, review,
 * one-line message, push when the branch has an upstream). Any other agent gets
 * the same procedure in words, since its slash commands are its own.
 */
export function commitInstruction(providerId: string, note?: string): string {
  if (providerId === COMMIT_PROVIDER) return note ? `/commit ${note}` : "/commit";
  return [
    "Commit your changes: run the project's checks and fix any failure, review the diff,",
    "stage only the files you changed on purpose (never `git add -A`), and commit with a one-line message",
    note ? `(the user added: ${note}).` : ".",
    "Push only if the branch has an upstream.",
  ].join(" ").replace(" .", ".");
}

/** Told to the agent in a worktree voice just made, after the user's instruction. */
function worktreeNote(made: CreatedWorktree): string {
  return [
    `(You are in a new git worktree of ${made.repo}, on branch ${made.branch}, made for this task so it does not touch other agents' work.`,
    "Keep your changes on this branch. Dependencies may not be installed here yet: install them first if a command needs them.)",
  ].join(" ");
}

/** The main checkout a project belongs to: itself, or its worktree's repository. */
function mainCheckoutOf(project: VoiceProject, projects: readonly VoiceProject[]): VoiceProject | undefined {
  if (!project.worktree) return project;
  const id = project.worktree.repoId;
  return id ? projects.find((p) => p.projectId === id && !p.worktree) : undefined;
}

/** A just-made worktree as a registry entry, without waiting on the next registry read. */
function worktreeProject(made: CreatedWorktree, root: VoiceProject): VoiceProject {
  return {
    projectId: projectIdFor(made.path),
    name: `${made.repo} (${made.branch})`,
    path: made.path,
    aliases: [],
    ...(root.providerId ? { providerId: root.providerId } : null),
    worktree: { repo: made.repo, repoId: root.projectId, branch: made.branch },
  };
}

/** The project ids a repository's work is filed under: the main checkout and every worktree. */
function familyOf(project: VoiceProject, projects: readonly VoiceProject[]): Set<string> {
  const root = mainCheckoutOf(project, projects);
  if (!root) return new Set([project.projectId]);
  return new Set([root.projectId, project.projectId, ...worktreesOf(root.projectId, projects).map((p) => p.projectId)]);
}

/** Same request: the instruction itself, possibly followed by a worktree note. */
function samePrompt(prompt: string, instruction: string): boolean {
  return prompt === instruction || prompt.startsWith(`${instruction}\n\n`);
}

const fail = (error: string): ToolResult => ({ ok: false, output: { error }, error });
const good = (output: unknown, extra: Partial<ToolResult> = {}): ToolResult => ({ ok: true, output, ...extra });

export class ToolExecutor {
  private readonly inFlight = new Map<string, Promise<ToolResult>>();
  private readonly confirm: ConfirmationTokens;
  private readonly policy: SafetyPolicy;
  private approvals: ApprovalPolicy = DEFAULT_APPROVAL_POLICY;

  getApprovalPolicy(): ApprovalPolicy {
    return this.deps.approvalPolicy?.get() ?? this.approvals;
  }

  private setApprovalPolicy(p: ApprovalPolicy) {
    if (this.deps.approvalPolicy) this.deps.approvalPolicy.set(p);
    else this.approvals = p;
  }

  private approvalView(t: StoredTask) {
    const id = t.approval?.requestId;
    const a = id ? this.deps.orchestrator.assessmentFor(t.taskId, id) : undefined;
    return a ? { say: a.speech, safe: a.safe, ...(a.concerns.length ? { concerns: a.concerns } : null) } : {};
  }

  constructor(private readonly deps: ToolDeps) {
    this.confirm = deps.confirm ?? new ConfirmationTokens();
    this.policy = deps.policy ?? DEFAULT_POLICY;
  }

  /**
   * Run one tool call exactly once per `callId`.
   *
   * The journal entry is on disk before the command runs. A retry after
   * completion returns the stored answer; a retry after a crash mid-command is
   * told the outcome is unknown instead of running it again.
   */
  handle(call: ToolCall): Promise<ToolResult> {
    const running = this.inFlight.get(call.callId);
    if (running) return running;
    const promise = this.run(call).finally(() => this.inFlight.delete(call.callId));
    this.inFlight.set(call.callId, promise);
    return promise;
  }

  private async run(call: ToolCall): Promise<ToolResult> {
    const { store } = this.deps;
    const begin = store.journalBegin(call.callId, call.name);
    if (begin.status === "done") return begin.result as ToolResult;
    if (begin.status === "pending") {
      return fail(
        "This command was interrupted by a restart and its outcome is unknown. Check task_status before trying again.",
      );
    }
    await store.flush();
    let result: ToolResult;
    try {
      result = await this.dispatch(call.name, call.args);
    } catch (error) {
      result = fail(speakable(error instanceof Error ? error.message : String(error), 160));
    }
    store.journalFinish(call.callId, result);
    await this.noteFocus(call, result);
    return result;
  }

  /**
   * Remember what a call was about, so the next "that" or "the other project"
   * resolves (`focus.ts`). Only for a call that ran now: a replayed answer was
   * noted the first time. Never fails the tool.
   */
  private async noteFocus(call: ToolCall, result: ToolResult): Promise<void> {
    if (!result.ok) return;
    try {
      const { store } = this.deps;
      const tasks = store.tasks();
      const before = store.focusRefs();
      const next = noteToolCall(
        before,
        { name: call.name, args: call.args, output: result.output, ok: result.ok },
        { now: (this.deps.now ?? Date.now)(), tasks, projects: await this.deps.projects(), goals: focusGoals(tasks) },
      );
      const same = next.length === before.length && next.every((ref, i) => ref === before[i]);
      if (!same) store.setFocusRefs(next);
    } catch {
      // Focus is a convenience; a reference just resolves less well.
    }
  }

  /** What reference resolution reads: the conversation's focus and the live tasks. */
  private async referenceContext(): Promise<ResolveContext> {
    const { store } = this.deps;
    const now = (this.deps.now ?? Date.now)();
    const tasks = store.tasks();
    return {
      refs: store.focusRefs(),
      tasks,
      projects: await this.deps.projects().catch(() => [] as VoiceProject[]),
      goals: focusGoals(tasks),
      now,
      tzOffsetMinutes: this.deps.tzOffsetMinutes?.() ?? -new Date(now).getTimezoneOffset(),
    };
  }

  /** The one task a reference means, or undefined when the conversation leaves it unclear. */
  private focusedTask(phrase: string, ctx: ResolveContext): StoredTask | undefined {
    const r = resolveReference(phrase, ctx);
    const id = r.needsClarification ? undefined : r.match?.taskId;
    return id ? this.deps.store.getTask(id) : undefined;
  }

  /** The executor's own helpers, handed to the goal tools (which must not import this module). */
  private goalContext(refs: ResolveContext): GoalToolContext {
    const { store, orchestrator } = this.deps;
    return {
      store,
      orchestrator,
      projects: this.deps.projects,
      usableProviders: this.deps.usableProviders,
      confirm: this.confirm,
      now: this.deps.now ?? Date.now,
      goalRunsBase: this.deps.goalRunsBase ?? "",
      resolveProject,
      daveGuard: (query, r, instruction, extra) => this.daveGuard(query, r, instruction, extra),
      clarify: (r) => this.clarify(r),
      place: async (project, projects, want) => {
        const placed = await this.placeTask(project, projects, { ...want, readOnly: false, dependsOn: [] });
        if (typeof placed === "string") return placed;
        const { target, made } = placed;
        return made ? { target, note: worktreeNote(made), newWorktree: { project: made.repo, branch: made.branch } } : { target };
      },
      focusResolve: (phrase) => {
        const r = resolveReference(phrase, refs);
        const m = r.needsClarification ? undefined : r.match;
        if (!m) return undefined;
        return { ...(m.taskId ? { taskId: m.taskId } : null), ...(m.projectId ? { projectId: m.projectId } : null), ...(m.runId ? { runId: m.runId } : null) };
      },
      taskView: (task) => taskView(store, task),
      attachments: (args) => attachmentsOf(store, args),
    };
  }

  /**
   * Stop a project tool that was really meant for DAVE, the assistant, or that
   * could be either (`daveIntent.ts`). Undefined means carry on. `extra` is
   * merged in so a refused start still says `started: false`.
   */
  private daveGuard(
    query: string,
    r: ReturnType<typeof resolveProject>,
    instruction?: string,
    extra: Record<string, unknown> = {},
  ): ToolResult | undefined {
    const daveAvailable = !!this.deps.dave;
    const target = r.best ?? r.candidates.find((c) => isDaveProject(c.project))?.project;
    const route = routeDave({
      query,
      ...(instruction ? { instruction } : null),
      ...(target ? { target } : null),
      byId: r.best?.projectId === query.trim(),
      daveAvailable,
    });
    if (route.kind === "project") return undefined;
    if (route.kind === "assistant") {
      return good({
        ...extra,
        meantBacklog: true,
        reason: "The user means the backlog, not a project.",
        next: daveAvailable ? `Call check_backlog with about '${route.about}'.` : "DAVE is turned off on this computer; say so plainly.",
      });
    }
    const name = target?.name ?? "dave";
    return good({
      ...extra,
      needsClarification: true,
      reason: "Dave could mean the backlog or the dave project.",
      question: route.about === "priorities" ? `Do you want the backlog, or a task in the ${name} project?` : `Do you mean the backlog, or the ${name} project?`,
      next: "For the backlog, call check_backlog. For the project, call again with its projectId.",
      candidates: target ? [{ projectId: target.projectId, name: target.name }] : [],
    });
  }

  /** "Did you mean A or B?" for a project that did not resolve to one. */
  private clarify(r: ReturnType<typeof resolveProject>): ToolResult {
    return good({
      needsClarification: true,
      reason: r.candidates.length ? "Several projects match." : "No project matches.",
      ...(r.candidates.length ? { question: didYouMean(r.candidates.map((c) => c.project.name)) } : null),
      candidates: r.candidates.map((c) => ({ projectId: c.project.projectId, name: c.project.name })),
    });
  }

  /**
   * Where a new task runs: the checkout named, or a new worktree of it.
   *
   * `auto` is EZ Coder's rule: every task that edits a main checkout gets its
   * own worktree, so three requests for one repo in a row are three branches
   * running at once, and none of them lands on top of another agent's (or the
   * user's) uncommitted work. Exceptions, each because a new copy would be
   * wrong rather than merely unneeded:
   *  - a branch the user named: they chose where it runs;
   *  - read-only work: it changes nothing, so it reads the real checkout;
   *  - a task depending on another in the same repository: it runs in that
   *    task's worktree, because a fresh copy from the last commit would not
   *    contain the work it is meant to build on.
   * `auto` falls back to the checkout when a worktree cannot be made (an
   * older host, git refusing); `new` fails instead, since the user asked.
   */
  private async placeTask(
    project: VoiceProject,
    projects: readonly VoiceProject[],
    want: { mode: "auto" | "new" | "current"; branch: string; readOnly: boolean; dependsOn: readonly string[] },
  ): Promise<{ target: VoiceProject; made?: CreatedWorktree } | string> {
    if (want.mode === "current") return { target: project };
    if (want.mode === "auto") {
      if (project.worktree || want.readOnly) return { target: project };
      const builtOn = this.dependencyCheckout(project, projects, want.dependsOn);
      if (builtOn) return { target: builtOn };
    }
    const root = mainCheckoutOf(project, projects);
    const create = this.deps.createWorktree;
    if (!root || !create) {
      if (want.mode === "auto") return { target: project };
      return root ? "This computer's pew2 cannot make worktrees." : `The main checkout of ${project.name} is not known on this computer.`;
    }
    const made = await create(root.path, want.branch);
    if (!made.ok) return want.mode === "auto" ? { target: project } : speakable(made.error, 160);
    return { target: worktreeProject(made.value, root), made: made.value };
  }

  /**
   * The checkout of the first dependency in the same repository, as a registry
   * entry. Built from the task itself when the registry has not been re-read
   * since that task's worktree was made.
   */
  private dependencyCheckout(project: VoiceProject, projects: readonly VoiceProject[], dependsOn: readonly string[]): VoiceProject | undefined {
    const family = familyOf(project, projects);
    for (const id of dependsOn) {
      const dep = this.deps.store.getTask(id);
      if (!dep || !(family.has(dep.projectId) || (dep.repo?.projectId !== undefined && family.has(dep.repo.projectId)))) continue;
      const known = projects.find((p) => p.projectId === dep.projectId);
      if (known) return known;
      return {
        projectId: dep.projectId,
        name: dep.projectName,
        path: dep.cwd,
        aliases: [],
        ...(dep.repo
          ? { worktree: { repo: dep.repo.name, ...(dep.repo.projectId ? { repoId: dep.repo.projectId } : null), ...(dep.repo.branch ? { branch: dep.repo.branch } : null) } }
          : null),
      };
    }
    return undefined;
  }

  /** A commit with no task behind it: a task of its own in that checkout, queued behind any writer there. */
  private startCommit(project: VoiceProject, note: string | undefined): ToolResult {
    const usable = this.deps.usableProviders();
    const providerId = usable.includes(COMMIT_PROVIDER)
      ? COMMIT_PROVIDER
      : chooseProvider(usable, project.providerId ?? this.deps.lastUsedProvider?.());
    if (!providerId) return fail("No coding agent is available on the computer.");
    const task = this.deps.orchestrator.enqueue({
      projectId: project.projectId,
      projectName: project.name,
      ...((repo) => (repo ? { repo } : null))(repoOf(project)),
      cwd: project.path,
      providerId,
      title: "Commit",
      prompt: commitInstruction(providerId, note),
    });
    return good({ committing: true, command: providerId === COMMIT_PROVIDER ? "/commit" : "commit instructions", task: taskView(this.deps.store, task) });
  }

  private async dispatch(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const { store, orchestrator } = this.deps;
    const taskOf = (): StoredTask | string => {
      const id = text(args, "taskId", 40);
      if (!id) return "taskId is required.";
      return store.getTask(id) ?? `No task ${id}.`;
    };

    if (backlogToolName(name)) {
      const client = this.deps.dave;
      if (!client) return fail("DAVE is turned off.");
      return runBacklogTool(name, args, {
        client,
        projects: this.deps.projects,
        usableProviders: this.deps.usableProviders,
        store,
        orchestrator,
        confirm: this.confirm,
        now: this.deps.now ?? Date.now,
      });
    }

    if (name === "resolve_reference") return runReferenceTool(name, args, await this.referenceContext());

    if (isGoalTool(name)) {
      // answer_question is about any agent's question; the rest read goal runs.
      if (name !== "answer_question" && !this.deps.goalRunsBase) return fail("Goals aren't available on this computer's pew2.");
      const refs = await this.referenceContext();
      let goalArgs = args;
      if (name === "goal_status" && !text(args, "taskId", 40) && !text(args, "goal", 200) && !text(args, "project", 100)) {
        // "How's it coming along?" right after talking about a goal means that goal.
        const meant = this.focusedTask("that", refs);
        if (meant?.goal) goalArgs = { ...args, taskId: meant.taskId };
      }
      return runGoalTool(name, goalArgs, this.goalContext(refs));
    }

    switch (name) {
      case "list_projects": {
        // One entry per repository, its worktrees as branches under it: a repo
        // with twelve ezcoder checkouts is still one line to say.
        const groups = groupByRepo(await this.deps.projects());
        return good({
          projects: groups.slice(0, 20).map((g) => ({
            ...(g.projectId ? { projectId: g.projectId } : null),
            name: g.name,
            ...(g.aliases.length ? { aliases: g.aliases } : null),
            ...(g.branches.length ? { branches: g.branches } : null),
            ...(g.moreBranches ? { moreBranches: g.moreBranches } : null),
          })),
        });
      }
      case "resolve_project": {
        const query = text(args, "query", 100);
        if (!query) return fail("query is required.");
        const r = resolveProject(query, await this.deps.projects());
        const meant = this.daveGuard(query, r);
        if (meant) return meant;
        return good({
          ambiguous: r.ambiguous,
          ...(r.ambiguous && r.candidates.length ? { question: didYouMean(r.candidates.map((c) => c.project.name)) } : null),
          ...(r.best ? { projectId: r.best.projectId, name: r.best.name } : null),
          candidates: r.candidates.map((c) => ({ projectId: c.project.projectId, name: c.project.name, score: Math.round(c.score * 100) / 100 })),
        });
      }
      case "start_task": {
        const query = text(args, "project", 100);
        const instruction = text(args, "instruction");
        if (!query || !instruction) return fail("project and instruction are required.");
        const r = resolveProject(query, await this.deps.projects());
        const meant = this.daveGuard(query, r, instruction, { started: false });
        if (meant) return meant;
        if (!r.best) {
          return good({
            started: false,
            needsClarification: true,
            reason: r.candidates.length ? "Several projects match." : "No project matches.",
            ...(r.candidates.length ? { question: didYouMean(r.candidates.map((c) => c.project.name)) } : null),
            candidates: r.candidates.map((c) => ({ projectId: c.project.projectId, name: c.project.name })),
          });
        }
        const projects = await this.deps.projects();
        const project = r.best;
        const dependsOn = Array.isArray(args.dependsOn)
          ? args.dependsOn.filter((d): d is string => typeof d === "string")
          : [];
        const missing = dependsOn.find((d) => !store.getTask(d));
        if (missing) return fail(`No task ${missing} to depend on.`);
        const shots = attachmentsOf(store, args);
        if (typeof shots === "string") return fail(shots);
        // The same instruction already waiting or running is the same request,
        // in whichever of the repository's checkouts it landed.
        // A task records its repository, which also covers a worktree made so
        // recently that the registry has not been re-read since.
        const family = familyOf(project, projects);
        const rootId = mainCheckoutOf(project, projects)?.projectId;
        const duplicate = store
          .tasks()
          .find(
            (t) =>
              (family.has(t.projectId) || (rootId !== undefined && t.repo?.projectId === rootId)) &&
              !TERMINAL.has(t.state) &&
              samePrompt(t.prompt, instruction),
          );
        if (duplicate) return good({ started: false, duplicate: true, task: taskView(store, duplicate) });
        const providerId = chooseProvider(this.deps.usableProviders(), project.providerId ?? this.deps.lastUsedProvider?.());
        if (!providerId) return fail("No coding agent is available on the computer.");
        const title = text(args, "title", 80) ?? speakable(instruction, 60);
        const readOnly = args.readOnly === true;

        const placed = await this.placeTask(project, projects, {
          mode: args.worktree === "new" || args.worktree === "current" ? args.worktree : "auto",
          branch: text(args, "branch", 60) ?? title,
          readOnly,
          dependsOn,
        });
        if (typeof placed === "string") return fail(placed);
        const { target, made } = placed;
        const priority = int(args, "priority");
        const task = orchestrator.enqueue({
          projectId: target.projectId,
          projectName: target.name,
          ...((repo) => (repo ? { repo } : null))(repoOf(target)),
          cwd: target.path,
          providerId,
          title,
          // A slash command must stay first and alone, or the agent never expands it.
          prompt: made && !instruction.startsWith("/") ? `${instruction}\n\n${worktreeNote(made)}` : instruction,
          dependsOn,
          readOnly,
          ...(shots.length ? { attachmentIds: shots } : null),
          ...(priority !== undefined ? { priority } : null),
        });
        return good({
          started: true,
          ...(made ? { newWorktree: { project: made.repo, branch: made.branch } } : null),
          task: taskView(store, task),
        });
      }
      case "follow_up": {
        const instruction = text(args, "instruction");
        if (!instruction) return fail("instruction is required.");
        let t: StoredTask | string;
        let fromConversation = false;
        if (text(args, "taskId", 40)) t = taskOf();
        else {
          // "Tell the agent to try a different approach": the agent just talked about.
          const meant = this.focusedTask("tell the agent", await this.referenceContext());
          if (!meant) {
            const active = store.tasks().filter((x) => !TERMINAL.has(x.state));
            return good({ needsClarification: true, reason: "Say which task.", active: active.slice(0, 8).map((x) => taskView(store, x)) });
          }
          t = meant;
          fromConversation = true;
        }
        if (typeof t === "string") return fail(t);
        const shots = attachmentsOf(store, args);
        if (typeof shots === "string") return fail(shots);
        const r = orchestrator.followUp(t.taskId, instruction, shots);
        return r.ok ? good({ task: taskView(store, r.value), ...(fromConversation ? { resolvedFrom: "conversation" } : null) }) : fail(r.error);
      }
      case "list_screenshots": {
        return good({ screenshots: store.screenshots().reverse().slice(0, 10).map((shot) => screenshotView(store, shot)) });
      }
      case "attach_screenshot": {
        const shot = pickScreenshot(store, text(args, "attachmentId", 40));
        if (typeof shot === "string") return fail(shot);
        let t: StoredTask | string;
        if (text(args, "taskId", 40)) t = taskOf();
        else {
          const active = store.tasks().filter((x) => !TERMINAL.has(x.state));
          if (active.length === 1 && active[0]) t = active[0];
          else {
            return good({
              needsClarification: true,
              reason: active.length ? "Several tasks are active." : "No task is active; use start_task with attachmentIds.",
              active: active.slice(0, 8).map((x) => taskView(store, x)),
            });
          }
        }
        if (typeof t === "string") return fail(t);
        if (t.state === "cancelled") return fail("That task was cancelled; start a new one with the screenshot instead.");
        const instruction = text(args, "instruction") ?? "Here is a screenshot the user forwarded. Use it for this task.";
        const r = orchestrator.followUp(t.taskId, instruction, [shot.attachmentId]);
        return r.ok ? good({ sent: true, screenshot: shot.name, task: taskView(store, r.value) }) : fail(r.error);
      }
      case "task_status": {
        let t: StoredTask | string;
        let fromConversation = false;
        if (text(args, "taskId", 40)) t = taskOf();
        else {
          const active = store.tasks().filter((x) => !TERMINAL.has(x.state));
          const meant = active.length === 1 ? undefined : this.focusedTask("that", await this.referenceContext());
          if (active.length === 1 && active[0]) t = active[0];
          else if (meant) {
            t = meant;
            fromConversation = true;
          } else return good({ needsClarification: true, active: active.slice(0, 8).map((x) => taskView(store, x)) });
        }
        return typeof t === "string" ? fail(t) : good({ task: taskView(store, t), ...(fromConversation ? { resolvedFrom: "conversation" } : null) });
      }
      case "whats_running": {
        const live = this.deps.runningSessions?.() ?? [];
        const projects = await this.deps.projects();
        const bySession = new Map(live.map((s) => [s.sessionId, s]));
        const active = store.tasks().filter((t) => !TERMINAL.has(t.state));
        const owned = new Set<string>();
        const tasks = active.map((t) => {
          const s = t.sessionId ? bySession.get(t.sessionId) : undefined;
          if (s) owned.add(s.sessionId);
          return { ...taskView(store, t), ...(s ? { session: s.state } : null) };
        });
        // Conversations no voice task owns: started at the desk or in the app.
        const others = live
          .filter((s) => !owned.has(s.sessionId))
          .map((s) => {
            const project = projectForPath(s.cwd, projects);
            const place = placeFields({ projectName: project?.name ?? basename(s.cwd), repo: project ? repoOf(project) : undefined });
            return {
              sessionRef: s.sessionId,
              ...place,
              agent: s.agentName ?? s.providerId,
              state: s.state,
              startedAt: startedAt(s),
              ...(s.title ? { title: speakable(s.title, 80) } : null),
              ...(s.tool ? { tool: speakable(s.tool, 80) } : null),
              lastActive: s.idleMs < 60_000 ? "just now" : `${Math.round(s.idleMs / 60_000)} minutes ago`,
            };
          })
          .sort((a, b) => RANK[b.state] - RANK[a.state]);
        const busy = others.filter((o) => o.state !== "idle").length + tasks.length;
        return good({
          tasks,
          otherSessions: others.slice(0, 8),
          summary: busy === 0 ? "Nothing is running." : `${tasks.length} voice task(s) and ${others.filter((o) => o.state !== "idle").length} other conversation(s) active.`,
          ...(this.deps.runningSessions ? null : { note: "This computer's daemon cannot list open conversations; only tasks are shown." }),
        });
      }
      case "peek_session": {
        if (!this.deps.peekSession) return fail("This computer's daemon cannot look inside open conversations.");
        const live = this.deps.runningSessions?.() ?? [];
        const projects = await this.deps.projects();
        const placeOf = (s: RunningSession) => {
          const project = projectForPath(s.cwd, projects);
          return placeFields({ projectName: project?.name ?? basename(s.cwd), repo: project ? repoOf(project) : undefined });
        };
        const ref = text(args, "sessionRef", 200);
        let s: RunningSession | undefined;
        if (ref) {
          s = live.find((x) => x.sessionId === ref);
          if (!s) return fail(`No open conversation ${speakable(ref, 60)}. Call whats_running.`);
        } else {
          const working = live.filter((x) => x.state === "working");
          if (working.length === 1) s = working[0];
          else
            return good({
              needsClarification: true,
              sessions: (working.length ? working : live).slice(0, 8).map((x) => ({ sessionRef: x.sessionId, ...placeOf(x), agent: x.agentName ?? x.providerId })),
            });
        }
        if (!s) return fail("No open conversation. Call whats_running.");
        const peek = this.deps.peekSession(s.sessionId);
        if (!peek) return fail(`No open conversation ${speakable(s.sessionId, 60)}. Call whats_running.`);
        const tool = peek.tool ?? s.tool;
        return good({
          ...placeOf(s),
          agent: s.agentName ?? s.providerId,
          state: s.state,
          startedAt: startedAt(s),
          ...(peek.lastPrompt ? { lastPrompt: speakable(peek.lastPrompt, 160) } : null),
          ...(peek.latest ? { latest: speakable(peek.latest, 400) } : null),
          ...(tool ? { tool: speakable(tool, 80) } : null),
        });
      }
      case "list_tasks": {
        const state = text(args, "state", 20);
        const projectId = text(args, "projectId", 40);
        const limit = Math.min(10, Math.max(1, int(args, "limit") ?? 6));
        // A repository's work includes its worktrees': "what's happening in
        // billing" must not miss the task ezcoder is running in a checkout of it.
        const inProject = projectId
          ? new Set([projectId, ...worktreesOf(projectId, await this.deps.projects()).map((p) => p.projectId)])
          : undefined;
        const tasks = store
          .tasks()
          .filter((t) => (!state || t.state === state) && (!inProject || inProject.has(t.projectId)))
          .slice(0, limit);
        return good({ tasks: tasks.map((t) => taskView(store, t)) });
      }
      case "reprioritize_task": {
        const t = taskOf();
        const priority = int(args, "priority");
        if (typeof t === "string") return fail(t);
        if (priority === undefined) return fail("priority is required.");
        const r = orchestrator.setPriority(t.taskId, priority);
        return r.ok ? good({ task: taskView(store, r.value) }) : fail(r.error);
      }
      case "pause_task": {
        const t = taskOf();
        if (typeof t === "string") return fail(t);
        const r = await orchestrator.pause(t.taskId);
        return r.ok ? good({ task: taskView(store, r.value) }) : fail(r.error);
      }
      case "resume_task": {
        const t = taskOf();
        if (typeof t === "string") return fail(t);
        const r = orchestrator.resume(t.taskId);
        return r.ok ? good({ task: taskView(store, r.value) }) : fail(r.error);
      }
      case "cancel_task": {
        const t = taskOf();
        if (typeof t === "string") return fail(t);
        if (TERMINAL.has(t.state)) return fail(`Task is already ${t.state}.`);
        if (ACTIVE.has(t.state)) {
          const subject = `cancel:${t.taskId}`;
          const confirmed = args.userConfirmed === true && this.confirm.redeem(text(args, "confirmToken", 40), subject);
          if (!confirmed) {
            return good({
              needsConfirmation: true,
              confirmToken: this.confirm.issue(subject),
              question: `Cancel ${t.title} in ${placeSpoken(t)}? Work in progress is stopped.`,
            });
          }
        }
        const r = await orchestrator.cancel(t.taskId);
        return r.ok ? good({ task: taskView(store, r.value) }) : fail(r.error);
      }
      case "verify_task": {
        const t = taskOf();
        if (typeof t === "string") return fail(t);
        const r = orchestrator.verify(t.taskId, text(args, "note", 80));
        return r.ok ? good({ task: taskView(store, r.value) }) : fail(r.error);
      }
      case "pending_approvals": {
        return good({
          approvals: orchestrator.pendingApprovals().map((t) => ({
            taskId: t.taskId,
            ...placeFields(t),
            title: t.title,
            requestId: t.approval?.requestId,
            risk: t.approval?.risk,
            summary: t.approval?.summary,
            ...this.approvalView(t),
            needsConfirmation: t.approval ? needsConfirmation(t.approval.risk) : false,
          })),
        });
      }
      case "approve_safe": {
        const done: string[] = [];
        const left: string[] = [];
        for (const t of orchestrator.pendingApprovals()) {
          const id = t.approval?.requestId;
          const a = id ? orchestrator.assessmentFor(t.taskId, id) : undefined;
          if (!id || !a?.safe) {
            if (t.approval) left.push(t.approval.summary);
            continue;
          }
          const r = orchestrator.answerApproval(t.taskId, id, "approve");
          if (r.ok) done.push(t.approval?.summary ?? "a request");
          else left.push(t.approval?.summary ?? "a request");
        }
        return good({
          approved: done.length,
          stillAsking: left.length,
          ...(left.length ? { remaining: left.slice(0, 3) } : null),
        });
      }
      case "set_approval_policy": {
        if (typeof args.autoApproveSafe !== "boolean") return fail("autoApproveSafe (true or false) is required.");
        this.setApprovalPolicy({ autoApproveSafe: args.autoApproveSafe });
        return good({ autoApproveSafe: args.autoApproveSafe, note: "Risky requests are still always asked." });
      }
      case "answer_approval": {
        if (!text(args, "taskId", 40) && !text(args, "requestId", 80)) {
          const open = orchestrator.pendingApprovals();
          const only = open.length === 1 ? open[0] : undefined;
          if (!only?.approval) {
            return fail(open.length ? "Several approvals are pending; say which one." : "Nothing is waiting for approval.");
          }
          args = { ...args, taskId: only.taskId, requestId: only.approval.requestId };
        }
        const t = taskOf();
        if (typeof t === "string") return fail(t);
        const requestId = text(args, "requestId", 80);
        const decision = args.decision;
        if (!requestId || (decision !== "approve" && decision !== "deny")) {
          return fail("requestId and decision (approve or deny) are required.");
        }
        // Staleness first, so a token is never issued for a question that is gone.
        if (t.state !== "blocked" || t.approval?.requestId !== requestId) {
          return fail("Stale: that approval is not pending any more. Ask for pending approvals.");
        }
        const risk = t.approval.risk;
        if (decision === "approve" && (needsConfirmation(risk) || needsExplicitApproval(risk, this.policy))) {
          // Everything needing a deliberate answer needs userConfirmed; the worst tiers need a token too.
          if (needsConfirmation(risk)) {
            const subject = `approve:${t.taskId}:${requestId}`;
            const ok = args.userConfirmed === true && this.confirm.redeem(text(args, "confirmToken", 40), subject);
            if (!ok) {
              return good({
                needsConfirmation: true,
                confirmToken: this.confirm.issue(subject),
                risk,
                question: `Approve ${risk} action: ${t.approval.summary}? Ask the user to say yes.`,
              });
            }
          } else if (args.userConfirmed !== true) {
            return good({
              needsConfirmation: true,
              risk,
              question: `Approve ${risk} action: ${t.approval.summary}? Ask the user, then call again with userConfirmed true.`,
            });
          }
        }
        const r = orchestrator.answerApproval(t.taskId, requestId, decision);
        return r.ok ? good({ answered: decision, task: taskView(store, r.value) }) : fail(r.error);
      }
      case "recent_events": {
        const taskId = text(args, "taskId", 40);
        const since = int(args, "sinceEventId");
        const limit = Math.min(10, Math.max(1, int(args, "limit") ?? 6));
        const pool = since !== undefined ? store.eventsSince(since, 200) : store.recentEvents(taskId, 40);
        const events = coalesce(pool.filter((e) => !taskId || e.taskId === taskId), limit);
        return good({
          events: events.map((e) => ({ eventId: e.eventId, taskId: e.taskId, ...placeFields(e), kind: e.kind, text: e.text })),
        });
      }
      case "get_details": {
        const t = taskOf();
        if (typeof t === "string") return fail(t);
        return good({
          task: taskView(store, t),
          attempts: t.attempts,
          dependsOn: t.dependsOn,
          ...(t.lastOutput ? { lastOutput: t.lastOutput } : null),
          history: t.history.slice(-8).map((h) => ({ state: h.state, note: h.note })),
        });
      }
      case "remember_decision": {
        const body = text(args, "text", 300);
        if (!body) return fail("text is required.");
        store.addDecision(speakable(body, 300), text(args, "taskId", 40));
        return good({ remembered: true });
      }
      case "add_project_alias": {
        const id = text(args, "projectId", 40);
        const alias = text(args, "alias", 60);
        if (!id || !alias) return fail("projectId and alias are required.");
        const project = (await this.deps.projects()).find((p) => p.projectId === id);
        if (!project) return fail(`No project ${id}.`);
        await this.deps.rememberAlias(project.path, alias);
        return good({ remembered: true, project: project.name, alias });
      }
      case "create_worktree": {
        const query = text(args, "project", 100);
        if (!query) return fail("project is required.");
        if (!this.deps.createWorktree) return fail("This computer's pew2 cannot make worktrees.");
        const projects = await this.deps.projects();
        const r = resolveProject(query, projects);
        const meant = this.daveGuard(query, r);
        if (meant) return meant;
        if (!r.best) return this.clarify(r);
        const root = mainCheckoutOf(r.best, projects);
        if (!root) return fail(`The main checkout of ${r.best.worktree?.repo ?? r.best.name} is not known on this computer.`);
        const made = await this.deps.createWorktree(root.path, text(args, "branch", 60));
        if (!made.ok) return fail(speakable(made.error, 160));
        const entry = worktreeProject(made.value, root);
        return good({
          created: true,
          projectId: entry.projectId,
          project: made.value.repo,
          branch: made.value.branch,
          note: "Start work there with start_task, passing this projectId.",
        });
      }
      case "list_worktrees": {
        const query = text(args, "project", 100);
        if (!query) return fail("project is required.");
        const projects = await this.deps.projects();
        const r = resolveProject(query, projects);
        const meant = this.daveGuard(query, r);
        if (meant) return meant;
        if (!r.best) return this.clarify(r);
        const root = mainCheckoutOf(r.best, projects);
        if (!root) return fail(`The main checkout of ${r.best.worktree?.repo ?? r.best.name} is not known on this computer.`);
        const live = this.deps.runningSessions?.() ?? [];
        const active = store.tasks().filter((t) => !TERMINAL.has(t.state));
        const describe = (projectId: string, path: string) => {
          const tasks = active.filter((t) => t.projectId === projectId).map((t) => ({ title: t.title, state: t.state }));
          const sessions = live.filter((s) => s.cwd === path && s.state !== "idle").length;
          return { ...(tasks.length ? { tasks: tasks.slice(0, 3) } : null), ...(sessions ? { otherConversationsActive: sessions } : null) };
        };
        const listed = await (this.deps.registeredWorktrees?.(root.path) ?? Promise.resolve([] as RegisteredWorktree[])).catch(
          () => [] as RegisteredWorktree[],
        );
        const known = new Map(worktreesOf(root.projectId, projects).map((p) => [p.path, p]));
        const branches = listed
          .filter((w) => !w.gone)
          .map((w) => {
            const id = known.get(w.path)?.projectId ?? projectIdFor(w.path);
            return { projectId: id, branch: w.branch ?? basename(w.path), ...describe(id, w.path) };
          });
        // Ones the agents remember but git no longer lists (not read, or moved).
        for (const p of known.values()) {
          if (!listed.some((w) => w.path === p.path)) branches.push({ projectId: p.projectId, branch: branchName(p), ...describe(p.projectId, p.path) });
        }
        return good({
          project: root.name,
          main: { projectId: root.projectId, ...describe(root.projectId, root.path) },
          branches: branches.slice(0, 30),
          ...(branches.length > 30 ? { moreBranches: branches.length - 30 } : null),
        });
      }
      case "commit": {
        const note = text(args, "note", 200);
        let task: StoredTask | undefined;
        if (text(args, "taskId", 40)) {
          const t = taskOf();
          if (typeof t === "string") return fail(t);
          task = t;
        } else if (text(args, "project", 100)) {
          const projects = await this.deps.projects();
          const query = text(args, "project", 100) ?? "";
          const r = resolveProject(query, projects);
          const meant = this.daveGuard(query, r);
          if (meant) return meant;
          if (!r.best) return this.clarify(r);
          const project = r.best;
          // The task that worked in that exact checkout knows what it changed.
          task = store.tasks().find((t) => t.projectId === project.projectId && t.state !== "cancelled");
          if (!task) return this.startCommit(project, note);
        } else {
          const open = store.tasks().filter((t) => !TERMINAL.has(t.state) || t.state === "completed");
          if (open.length !== 1 || !open[0]) {
            return good({
              needsClarification: true,
              reason: open.length ? "Several tasks could be meant; ask which one to commit." : "No recent task; ask which project to commit.",
              candidates: open.slice(0, 6).map((t) => taskView(store, t)),
            });
          }
          task = open[0];
        }
        if (task.state === "cancelled") return fail("That task was cancelled; name its project to commit there instead.");
        const r = orchestrator.followUp(task.taskId, commitInstruction(task.providerId, note));
        return r.ok
          ? good({ committing: true, command: task.providerId === COMMIT_PROVIDER ? "/commit" : "commit instructions", task: taskView(store, r.value) })
          : fail(r.error);
      }
      default:
        return fail(`Unknown tool '${name}'.`);
    }
  }
}
