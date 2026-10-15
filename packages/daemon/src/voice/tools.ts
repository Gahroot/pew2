/**
 * The Realtime model's hands: function-tool definitions, the executor behind
 * them, the session instructions and the session config.
 *
 * Every result is small JSON. The model never sees paths, source or raw logs,
 * and never supplies a working directory — projects are named and resolved
 * against the registry.
 */
import { coalesce } from "./classify.js";
import { placeFields, placeSpoken } from "./place.js";
import type { Orchestrator } from "./dispatcher.js";
import { chooseProvider, groupByRepo, repoOf, resolveProject, worktreesOf } from "./registry.js";
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
import type { RunningSession, VoiceProject } from "./types.js";

// ---- definitions -----------------------------------------------------------

interface ToolDef {
  type: "function";
  name: string;
  description: string;
  parameters: { type: "object"; properties: Record<string, unknown>; required: string[] };
}

const str = (description: string) => ({ type: "string", description });
const def = (
  name: string,
  description: string,
  properties: Record<string, unknown> = {},
  required: string[] = [],
): ToolDef => ({ type: "function", name, description, parameters: { type: "object", properties, required } });

export const VOICE_TOOLS: readonly ToolDef[] = [
  def("list_projects", "List projects the user can name."),
  def("resolve_project", "Match a spoken project name (partial, misheard or any case is fine). One clear match: use it, don't ask. Ambiguous: ask one short 'did you mean A or B?'.", { query: str("What the user said.") }, ["query"]),
  def(
    "start_task",
    "Start a coding task in a project (queued if the project is busy). Use follow_up for work on an existing task.",
    {
      project: str("Spoken project name or projectId."),
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
    { taskId: str("Task id."), instruction: str("The instruction."), attachmentIds: { type: "array", items: { type: "string" }, description: "Screenshots to send with it, by attachmentId from list_screenshots." } },
    ["taskId", "instruction"],
  ),
  def("task_status", "Fresh status of one task. Omit taskId when only one task is active.", { taskId: str("Task id.") }),
  def(
    "whats_running",
    "What is happening on the computer right now: voice tasks plus every agent conversation already open, including ones the user started at the desk or in the app. Use for 'what's running', 'anything going on', 'what's the status'.",
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
  def(
    "request_screenshot",
    "Open the photo picker on the user's phone so they can share a screenshot, e.g. a partner's fix or an error. Call when they offer one or you need to see something. You hear when it arrives.",
    { reason: str("Why, in a few words, shown to the user.") },
  ),
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
  def("end_session", "End the voice session when the user is done."),
];

export const TOOL_NAMES: readonly string[] = VOICE_TOOLS.map((t) => t.name);

// ---- instructions + session config -----------------------------------------

export const VOICE_INSTRUCTIONS = [
  "You are the voice of pew2 and the user's partner on their coding work. Coding agents on their computer write the code; you keep the user in the loop, think one step ahead, and help decide what happens next. Use your tools for everything.",
  "Be brief and natural. Acknowledge a command in one short sentence, like 'Sent to billing.' Reporting a result may take two or three sentences. No lists unless asked, no preamble, no repeating what the user said. Do not ask questions you can answer with a tool or a sensible default.",
  "When a task completes, use its debrief. Say in a sentence what the agent did, from 'said' plus edits and checks in plain words, then offer the debrief's nextStep as one yes/no question. If the user says yes, call follow_up with the debrief's followUp text. If the outcome is 'question', the agent is waiting on the user: put its question to them plainly and send their answer with follow_up. If there is no nextStep, just report and stop. checks 'ran' means a check ran and the agent reported no failure; say 'it ran the tests', never 'tests pass'. Offer one next step at a time, and drop it if the user declines or sounds done.",
  "When a task fails, say why in plain words and offer one way forward: try again, or a different approach.",
  "System messages starting '[Update]' are live news from the computer, not the user speaking. Tell the user right away, briefly, by the rules above. If you already told them that, reply with nothing at all.",
  "When the user asks what next, or a task finishes and nothing else is pending, suggest from the debriefs and open tasks. Otherwise do not fill silence.",
  "Never say project ids, task ids, request ids, tokens, file paths, URLs, hashes or code aloud. Use project names and plain words. Summarise tool activity in plain words ('editing the login screen', 'running tests'), never as raw commands.",
  "Never say work is done, merged, deployed or fixed until a tool result says the agent reported it. 'Completed' means the agent says it finished, not that it is verified; say so plainly. If a result says failed or interrupted, say that.",
  "Projects: pass what the user said to start_task or resolve_project; partial names, different casing and misheard names are matched for you. If one project clearly matches, just proceed without asking. If the result is ambiguous, ask once: 'Did you mean A or B?' naming at most three candidates, then continue with the answer. Never guess between close matches. Existing work gets follow_up, not a new task.",
  "Branches: list_projects gives one entry per repository, with its worktrees as branches under it. A worktree is a separate checkout of that repository on its own branch, so its work does not touch the main checkout. The repository's plain name means the main checkout; to work on a branch, pass its projectId or say the repository and branch ('billing, fix login'). Work on a branch still counts as that repository's when the user asks what is happening there. Task and event results name the repository as `project` and add `branch` for work on one; report progress and completion that way ('billing, on the fix login branch, is done'), never as separate projects, and never say a random folder id like 'ez-mun7ig9t'.",
  "Screenshots: the user can share pictures, typically a partner's fix or an error, from the phone. You never see the picture; you get its attachmentId and name. When they offer one, call request_screenshot. When one arrives, say you have it in a few words, then ask which project or task it is for unless they already said. Send it with start_task or follow_up attachmentIds, or attach_screenshot for a task already running, together with what they want done ('apply this fix'). Never describe what is in it, and never claim the agent applied it until a result says so.",
  "When asked what is running or how things are going, call whats_running, not just list_tasks: it also shows conversations the user started at the desk or in the app. 'needs_you' means an agent is blocked on an approval; mention that first.",
  "Call task_status before acting on a task you have not checked this session; state changes while you talk.",
  "Approvals: when an agent is waiting, read the 'say' sentence from pending_approvals in plain words and ask 'Approve or deny?'. Safe means read-only; risky means writes outside the project, deletes, network, installs or git push, so name the risk in a few words. Only call answer_approval after an explicit answer. 'Approve all safe ones' means approve_safe; 'stop asking about safe ones' means set_approval_policy. Risky approvals are never auto-approved. For merge, deploy and destructive actions, and cancelling running work, call once to get a confirmToken, ask 'Are you sure?', and call again with userConfirmed true only after they say yes. Never reuse or invent tokens.",
  "Start by briefly stating what changed from the opening context, if anything, offering the next step on anything that finished. Say nothing about what the user already heard.",
  "When the user says they are done or to stop, call end_session, then say a very short goodbye.",
].join("\n");

export interface SessionConfigOptions {
  instructions?: string;
  voice?: string;
}

/** Realtime session config: audio in/out, server VAD with interruption, tools. */
export function realtimeSession(options: SessionConfigOptions = {}): Record<string, unknown> {
  return {
    type: "realtime",
    output_modalities: ["audio"],
    instructions: options.instructions ?? VOICE_INSTRUCTIONS,
    audio: {
      input: {
        format: { type: "audio/pcm", rate: 24000 },
        turn_detection: {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 500,
          create_response: true,
          interrupt_response: true,
        },
      },
      output: {
        format: { type: "audio/pcm", rate: 24000 },
        ...(options.voice ? { voice: options.voice } : null),
      },
    },
    tools: VOICE_TOOLS,
    tool_choice: "auto",
  };
}

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
  endSession?: boolean;
  /** The app should open its photo picker (`request_screenshot`). */
  openPicker?: boolean;
}

const RANK = { needs_you: 2, working: 1, idle: 0 } as const;

/** The project whose directory holds `cwd`, longest path winning so a worktree beats its repository. */
function projectForPath(cwd: string, projects: readonly VoiceProject[]): VoiceProject | undefined {
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
  confirm?: ConfirmationTokens;
  policy?: SafetyPolicy;
  /** Per-voice-session approval policy; the executor owns one when not given. */
  approvalPolicy?: { get: () => ApprovalPolicy; set: (p: ApprovalPolicy) => void };
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
  };
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
    ? "There is no unsent screenshot. Call request_screenshot to ask for one."
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
    return result;
  }

  private async dispatch(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const { store, orchestrator } = this.deps;
    const taskOf = (): StoredTask | string => {
      const id = text(args, "taskId", 40);
      if (!id) return "taskId is required.";
      return store.getTask(id) ?? `No task ${id}.`;
    };

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
        if (!r.best) {
          return good({
            started: false,
            needsClarification: true,
            reason: r.candidates.length ? "Several projects match." : "No project matches.",
            ...(r.candidates.length ? { question: didYouMean(r.candidates.map((c) => c.project.name)) } : null),
            candidates: r.candidates.map((c) => ({ projectId: c.project.projectId, name: c.project.name })),
          });
        }
        const project = r.best;
        const dependsOn = Array.isArray(args.dependsOn)
          ? args.dependsOn.filter((d): d is string => typeof d === "string")
          : [];
        const missing = dependsOn.find((d) => !store.getTask(d));
        if (missing) return fail(`No task ${missing} to depend on.`);
        const shots = attachmentsOf(store, args);
        if (typeof shots === "string") return fail(shots);
        // The same instruction already waiting or running is the same request.
        const duplicate = store
          .tasks()
          .find((t) => t.projectId === project.projectId && !TERMINAL.has(t.state) && t.prompt === instruction);
        if (duplicate) return good({ started: false, duplicate: true, task: taskView(store, duplicate) });
        const providerId = chooseProvider(this.deps.usableProviders(), project.providerId ?? this.deps.lastUsedProvider?.());
        if (!providerId) return fail("No coding agent is available on the computer.");
        const priority = int(args, "priority");
        const task = orchestrator.enqueue({
          projectId: project.projectId,
          projectName: project.name,
          ...((repo) => (repo ? { repo } : null))(repoOf(project)),
          cwd: project.path,
          providerId,
          title: text(args, "title", 80) ?? speakable(instruction, 60),
          prompt: instruction,
          dependsOn,
          readOnly: args.readOnly === true,
          ...(shots.length ? { attachmentIds: shots } : null),
          ...(priority !== undefined ? { priority } : null),
        });
        return good({ started: true, task: taskView(store, task) });
      }
      case "follow_up": {
        const t = taskOf();
        if (typeof t === "string") return fail(t);
        const instruction = text(args, "instruction");
        if (!instruction) return fail("instruction is required.");
        const shots = attachmentsOf(store, args);
        if (typeof shots === "string") return fail(shots);
        const r = orchestrator.followUp(t.taskId, instruction, shots);
        return r.ok ? good({ task: taskView(store, r.value) }) : fail(r.error);
      }
      case "request_screenshot": {
        const reason = text(args, "reason", 120);
        return good(
          {
            pickerOpened: true,
            ...(reason ? { reason } : null),
            note: "The photo picker is opening on the user's phone. Wait for the screenshot to arrive before sending it anywhere.",
          },
          { openPicker: true },
        );
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
        if (text(args, "taskId", 40)) t = taskOf();
        else {
          const active = store.tasks().filter((x) => !TERMINAL.has(x.state));
          if (active.length === 1 && active[0]) t = active[0];
          else return good({ needsClarification: true, active: active.slice(0, 8).map((x) => taskView(store, x)) });
        }
        return typeof t === "string" ? fail(t) : good({ task: taskView(store, t) });
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
            return { ...place, agent: s.agentName ?? s.providerId, state: s.state, lastActive: s.idleMs < 60_000 ? "just now" : `${Math.round(s.idleMs / 60_000)} minutes ago` };
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
      case "end_session":
        return good({ ending: true }, { endSession: true });
      default:
        return fail(`Unknown tool '${name}'.`);
    }
  }
}
