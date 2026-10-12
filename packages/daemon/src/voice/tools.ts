/**
 * The Realtime model's hands: function-tool definitions, the executor behind
 * them, the session instructions and the session config.
 *
 * Every result is small JSON. The model never sees paths, source or raw logs,
 * and never supplies a working directory — projects are named and resolved
 * against the registry.
 */
import { coalesce } from "./classify.js";
import type { Orchestrator } from "./dispatcher.js";
import { chooseProvider, resolveProject } from "./registry.js";
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
import { ACTIVE, TERMINAL, type StoredTask, type VoiceStore } from "./store.js";
import type { VoiceProject } from "./types.js";

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
    },
    ["project", "instruction"],
  ),
  def("follow_up", "Send another instruction to an existing task.", { taskId: str("Task id."), instruction: str("The instruction.") }, ["taskId", "instruction"]),
  def("task_status", "Fresh status of one task. Omit taskId when only one task is active.", { taskId: str("Task id.") }),
  def("list_tasks", "List tasks, newest first.", {
    state: str("Filter by state."),
    projectId: str("Filter by project."),
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
  def("end_session", "End the voice session when the user is done."),
];

export const TOOL_NAMES: readonly string[] = VOICE_TOOLS.map((t) => t.name);

// ---- instructions + session config -----------------------------------------

export const VOICE_INSTRUCTIONS = [
  "You are the voice of pew2, a hands-free controller for coding agents running on the user's computer. You do not write code; agents do. Use your tools for everything.",
  "Be terse: one short sentence per reply, like 'Sent to billing.' or 'Done, tests passing.' No lists unless asked, no preamble, no repeating what the user said. Do not ask questions you can answer with a tool or a sensible default.",
  "Never say project ids, task ids, request ids, tokens, file paths, URLs, hashes or code aloud. Use project names and plain words. Summarise tool activity in plain words ('editing the login screen', 'running tests'), never as raw commands.",
  "Never say work is done, merged, deployed or fixed until a tool result says the agent reported it. 'Completed' means the agent says it finished, not that it is verified; say so plainly. If a result says failed or interrupted, say that.",
  "Projects: pass what the user said to start_task or resolve_project; partial names, different casing and misheard names are matched for you. If one project clearly matches, just proceed without asking. If the result is ambiguous, ask once: 'Did you mean A or B?' naming at most three candidates, then continue with the answer. Never guess between close matches. Existing work gets follow_up, not a new task.",
  "Call task_status before acting on a task you have not checked this session; state changes while you talk.",
  "Approvals: when an agent is waiting, read the 'say' sentence from pending_approvals in plain words and ask 'Approve or deny?'. Safe means read-only; risky means writes outside the project, deletes, network, installs or git push, so name the risk in a few words. Only call answer_approval after an explicit answer. 'Approve all safe ones' means approve_safe; 'stop asking about safe ones' means set_approval_policy. Risky approvals are never auto-approved. For merge, deploy and destructive actions, and cancelling running work, call once to get a confirmToken, ask 'Are you sure?', and call again with userConfirmed true only after they say yes. Never reuse or invent tokens.",
  "Start by briefly stating what changed from the opening context, if anything. Say nothing about what the user already heard.",
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

export function taskView(store: VoiceStore, t: StoredTask) {
  const waiting = t.state === "queued" ? store.waitingFor(t) : undefined;
  return {
    taskId: t.taskId,
    project: t.projectName,
    title: t.title,
    state: t.state,
    priority: t.priority,
    ...(t.activity ? { activity: t.activity } : null),
    ...(t.approval ? { approval: t.approval } : null),
    ...(waiting ? { waiting } : null),
    ...(t.error ? { error: t.error } : null),
    ...(t.interrupted ? { interrupted: true } : null),
    ...(t.state === "completed" ? { note: "Agent says finished; not verified." } : null),
  };
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
        const projects = await this.deps.projects();
        return good({
          projects: projects.slice(0, 20).map((p) => ({ projectId: p.projectId, name: p.name, aliases: p.aliases.slice(0, 3) })),
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
          cwd: project.path,
          providerId,
          title: text(args, "title", 80) ?? speakable(instruction, 60),
          prompt: instruction,
          dependsOn,
          readOnly: args.readOnly === true,
          ...(priority !== undefined ? { priority } : null),
        });
        return good({ started: true, task: taskView(store, task) });
      }
      case "follow_up": {
        const t = taskOf();
        if (typeof t === "string") return fail(t);
        const instruction = text(args, "instruction");
        if (!instruction) return fail("instruction is required.");
        const r = orchestrator.followUp(t.taskId, instruction);
        return r.ok ? good({ task: taskView(store, r.value) }) : fail(r.error);
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
      case "list_tasks": {
        const state = text(args, "state", 20);
        const projectId = text(args, "projectId", 40);
        const limit = Math.min(10, Math.max(1, int(args, "limit") ?? 6));
        const tasks = store
          .tasks()
          .filter((t) => (!state || t.state === state) && (!projectId || t.projectId === projectId))
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
              question: `Cancel ${t.title} in ${t.projectName}? Work in progress is stopped.`,
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
            project: t.projectName,
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
          events: events.map((e) => ({ eventId: e.eventId, taskId: e.taskId, project: e.projectName, kind: e.kind, text: e.text })),
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
