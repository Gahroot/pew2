/**
 * Turns persisted tasks into real daemon sessions, and session activity back
 * into voice events.
 *
 * EZCODER (any ACP agent the daemon spawns) does the work; this only decides
 * when a task may start, relays follow-ups, and translates what the session
 * reports. It reuses the daemon's own session machinery through `VoiceHost`
 * rather than opening a second path to the agent.
 *
 * Honesty rule: "completed" means the agent's turn ended, and the text says
 * so. Nothing here ever says a thing worked on its own authority.
 */
import { humanError } from "../errors.js";
import {
  classifyRisk,
  describeTool,
  pickOption,
  speakable,
  type PermissionOption,
} from "./safety.js";
import { ACTIVE, TERMINAL, type NewTask, type StoredTask, type VoiceStore } from "./store.js";

/** The slice of Daemon the dispatcher needs; a fake in tests. */
export interface VoiceHost {
  /** Open a session in `cwd` and announce it to clients. Resolves with the session id. */
  startSession(providerId: string, cwd: string, tag: string): Promise<string>;
  /** Resolves when the turn ends; rejects if it failed. */
  prompt(sessionId: string, text: string): Promise<void>;
  cancel(sessionId: string): Promise<void>;
  answerPermission(sessionId: string, requestId: string, optionId: string): boolean;
  hasSession(sessionId: string): boolean;
  /** What the agent said at the end of the current turn. */
  lastText(sessionId: string): string | undefined;
}

export interface OrchestratorOptions {
  now?: () => number;
  maxConcurrent?: number;
  /** A running (not blocked) task with no sign of life for this long is failed. */
  taskTimeoutMs?: number;
  retryBackoffMs?: number;
}

interface Pending {
  params: unknown;
  options: PermissionOption[];
}

export type Outcome<T = StoredTask> = { ok: true; value: T } | { ok: false; error: string };

export class Orchestrator {
  private readonly now: () => number;
  private readonly maxConcurrent: number;
  private readonly timeoutMs: number;
  private readonly backoffMs: number;
  /** Open permission requests per task, with the options to answer them. */
  private readonly permissions = new Map<string, Map<string, Pending>>();
  private readonly followUps = new Map<string, string[]>();
  private readonly retryAt = new Map<string, number>();
  private readonly lastActivity = new Map<string, number>();
  /** Prompt loops currently awaiting an agent turn. */
  private readonly looping = new Set<string>();

  constructor(
    private readonly store: VoiceStore,
    private readonly host: VoiceHost,
    options: OrchestratorOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.maxConcurrent = options.maxConcurrent ?? 3;
    this.timeoutMs = options.taskTimeoutMs ?? 30 * 60_000;
    this.backoffMs = options.retryBackoffMs ?? 5_000;
  }

  // ---- startup -------------------------------------------------------------

  /**
   * Called once after the store loads. A task the previous process was running
   * has no agent behind it any more; it is failed as interrupted, never
   * completed, and the user is told it needs a decision.
   */
  reconcile(): StoredTask[] {
    const touched: StoredTask[] = [];
    for (const task of this.store.running()) {
      const result = this.store.transition(
        task.taskId,
        "failed",
        "task.failed",
        `Interrupted: the computer's pew2 restarted while this was running. Nothing was confirmed, so check the work before relying on it.`,
        { interrupted: true, error: "interrupted by daemon restart" },
      );
      if (result) touched.push(result.task);
    }
    this.pump();
    return touched;
  }

  // ---- commands ------------------------------------------------------------

  enqueue(input: NewTask): StoredTask {
    const task = this.store.createTask(input);
    this.pump();
    return this.store.getTask(task.taskId) ?? task;
  }

  /**
   * Send more instructions to a task. To a live turn it is queued behind the
   * current prompt (one prompt per session at a time); to a finished task it
   * reopens the same conversation, or starts a fresh one if the session is gone.
   */
  followUp(taskId: string, text: string): Outcome {
    const task = this.store.getTask(taskId);
    if (!task) return { ok: false, error: `No task ${taskId}.` };
    if (task.state === "cancelled") return { ok: false, error: "That task was cancelled." };
    const line = text.trim();
    if (!line) return { ok: false, error: "Empty instruction." };

    if (ACTIVE.has(task.state) || task.state === "queued" || task.state === "paused") {
      if (task.state === "queued" || task.state === "paused") {
        // Not started: fold into the task's own prompt so the agent sees one instruction.
        this.store.patch(taskId, { prompt: `${task.prompt}\n\nAdditional instruction: ${line}` });
      } else {
        const list = this.followUps.get(taskId) ?? [];
        list.push(line);
        this.followUps.set(taskId, list);
        this.store.transition(taskId, task.state, "task.progress", `Follow-up queued: ${speakable(line, 80)}`);
      }
      return { ok: true, value: this.store.getTask(taskId) ?? task };
    }

    // Finished or failed: run again.
    const reuse = task.sessionId !== undefined && this.host.hasSession(task.sessionId);
    this.followUps.set(taskId, []);
    this.store.transition(taskId, "queued", "task.queued", `Queued follow-up: ${speakable(line, 80)}`, {
      prompt: reuse ? line : `Follow-up on an earlier task "${task.title}".\n\n${line}`,
      resume: reuse,
      sessionId: reuse ? task.sessionId : undefined,
      attempts: 0,
      error: undefined,
      interrupted: undefined,
    });
    this.pump();
    return { ok: true, value: this.store.getTask(taskId) ?? task };
  }

  /** Pause: stop the agent's current turn and hold the task; resume continues it. */
  async pause(taskId: string): Promise<Outcome> {
    const task = this.store.getTask(taskId);
    if (!task) return { ok: false, error: `No task ${taskId}.` };
    if (task.state === "queued") {
      this.store.transition(taskId, "paused", "task.paused", `Paused: ${task.title}`);
    } else if (ACTIVE.has(task.state)) {
      this.store.transition(taskId, "paused", "task.paused", `Paused: ${task.title}`, {
        resume: true,
        activity: undefined,
      });
      this.permissions.delete(taskId);
      await this.safeCancel(task.sessionId);
      this.pump();
    } else {
      return { ok: false, error: `Task is ${task.state}, so it cannot be paused.` };
    }
    return { ok: true, value: this.store.getTask(taskId) ?? task };
  }

  resume(taskId: string): Outcome {
    const task = this.store.getTask(taskId);
    if (!task) return { ok: false, error: `No task ${taskId}.` };
    if (task.state !== "paused") return { ok: false, error: `Task is ${task.state}, not paused.` };
    const reuse = task.sessionId !== undefined && this.host.hasSession(task.sessionId);
    this.store.transition(taskId, "queued", "task.resumed", `Resumed: ${task.title}`, {
      resume: reuse,
      sessionId: reuse ? task.sessionId : undefined,
      prompt: reuse && task.startedAt ? "Continue the task where you stopped." : task.prompt,
      attempts: 0,
    });
    this.pump();
    return { ok: true, value: this.store.getTask(taskId) ?? task };
  }

  async cancel(taskId: string): Promise<Outcome> {
    const task = this.store.getTask(taskId);
    if (!task) return { ok: false, error: `No task ${taskId}.` };
    if (TERMINAL.has(task.state)) return { ok: false, error: `Task is already ${task.state}.` };
    const sessionId = task.sessionId;
    this.permissions.delete(taskId);
    this.followUps.delete(taskId);
    this.store.transition(taskId, "cancelled", "task.cancelled", `Cancelled: ${task.title}`);
    await this.safeCancel(sessionId);
    this.pump();
    return { ok: true, value: this.store.getTask(taskId) ?? task };
  }

  /** The user (or a check) confirmed the result. Only a completed task can be verified. */
  verify(taskId: string, note?: string): Outcome {
    const task = this.store.getTask(taskId);
    if (!task) return { ok: false, error: `No task ${taskId}.` };
    if (task.state !== "completed") {
      return { ok: false, error: `Task is ${task.state}; only a completed task can be verified.` };
    }
    this.store.transition(taskId, "verified", "task.verified", `Verified: ${task.title}${note ? ` (${speakable(note, 60)})` : ""}`);
    return { ok: true, value: this.store.getTask(taskId) ?? task };
  }

  setPriority(taskId: string, priority: number): Outcome {
    const task = this.store.getTask(taskId);
    if (!task) return { ok: false, error: `No task ${taskId}.` };
    this.store.setPriority(taskId, priority);
    this.pump();
    return { ok: true, value: this.store.getTask(taskId) ?? task };
  }

  // ---- approvals -----------------------------------------------------------

  /**
   * Answer the open approval. Validated against the task as it is *now*: the
   * request id must be the one currently pending, so a decision made about an
   * earlier question is rejected rather than applied to a later one.
   */
  answerApproval(taskId: string, requestId: string, decision: "approve" | "deny"): Outcome {
    const task = this.store.getTask(taskId);
    if (!task) return { ok: false, error: `No task ${taskId}.` };
    if (task.state !== "blocked" || !task.approval) {
      return { ok: false, error: "Stale: that task is not waiting for an approval any more." };
    }
    if (task.approval.requestId !== requestId) {
      return { ok: false, error: "Stale: a different approval is pending now. Ask for pending approvals." };
    }
    const pending = this.permissions.get(taskId)?.get(requestId);
    if (!pending || !task.sessionId) {
      return { ok: false, error: "Stale: the agent is no longer waiting on that request." };
    }
    const option = pickOption(pending.options, decision);
    if (!option) return { ok: false, error: "The agent offered no option for that decision." };
    if (!this.host.answerPermission(task.sessionId, requestId, option.optionId)) {
      return { ok: false, error: "Stale: the agent had already moved on from that request." };
    }
    this.permissions.get(taskId)?.delete(requestId);
    this.lastActivity.set(taskId, this.now());
    this.store.transition(
      taskId,
      "running",
      "task.progress",
      decision === "approve" ? `Approved: ${task.approval.summary}` : `Denied: ${task.approval.summary}`,
      { approval: undefined },
    );
    return { ok: true, value: this.store.getTask(taskId) ?? task };
  }

  /** An approval was answered outside voice (the app's own sheet): unblock and say so. */
  onPermissionAnswered(sessionId: string, requestId: string): void {
    const task = this.store.taskBySession(sessionId);
    if (!task) return;
    this.permissions.get(task.taskId)?.delete(requestId);
    if (task.state !== "blocked" || task.approval?.requestId !== requestId) return;
    this.lastActivity.set(task.taskId, this.now());
    this.store.transition(task.taskId, "running", "task.progress", "Approval answered on the phone or desktop; continuing.", {
      approval: undefined,
    });
  }

  pendingApprovals(): StoredTask[] {
    return this.store.tasks().filter((t) => t.state === "blocked" && t.approval);
  }

  // ---- scheduling ----------------------------------------------------------

  /** Start whatever may start now. Synchronous bookkeeping; the work is async. */
  pump(): void {
    let active = this.store.running().length;
    const now = this.now();
    for (const task of this.store.queue()) {
      const broken = this.store.brokenDependency(task);
      if (broken) {
        this.store.transition(
          task.taskId,
          "failed",
          "task.failed",
          `Not started: it depends on ${broken.taskId}, which did not finish.`,
          { error: `dependency ${broken.taskId} failed or was cancelled` },
        );
        continue;
      }
      if (active >= this.maxConcurrent) break;
      if (!this.store.dependenciesMet(task)) continue;
      if ((this.retryAt.get(task.taskId) ?? 0) > now) continue;
      if (!task.readOnly && this.store.lockHolder(task.projectId, task.taskId)) continue;
      this.retryAt.delete(task.taskId);
      this.store.transition(
        task.taskId,
        "running",
        task.resume ? "task.resumed" : "task.started",
        `${task.resume ? "Continuing" : "Started"}: ${task.title}`,
        { startedAt: task.startedAt ?? now },
      );
      this.lastActivity.set(task.taskId, now);
      active++;
      void this.execute(task.taskId);
    }
  }

  /** Periodic housekeeping: retry backoffs and stuck-task timeouts. */
  tick(): void {
    const now = this.now();
    for (const task of this.store.running()) {
      if (task.state !== "running") continue;
      const last = this.lastActivity.get(task.taskId) ?? task.updatedAt;
      if (now - last < this.timeoutMs) continue;
      const sessionId = task.sessionId;
      this.followUps.delete(task.taskId);
      this.store.transition(
        task.taskId,
        "failed",
        "task.failed",
        `Timed out: no activity for ${Math.round(this.timeoutMs / 60_000)} minutes. The agent was stopped.`,
        { error: "timeout" },
      );
      void this.safeCancel(sessionId);
    }
    this.pump();
  }

  private async execute(taskId: string): Promise<void> {
    const first = this.store.getTask(taskId);
    if (!first) return;
    this.store.patch(taskId, { attempts: first.attempts + 1 });
    let sessionId: string | undefined;
    try {
      const task = this.store.getTask(taskId);
      if (!task) return;
      if (task.resume && task.sessionId && this.host.hasSession(task.sessionId)) {
        sessionId = task.sessionId;
      } else {
        sessionId = await this.host.startSession(task.providerId, task.cwd, task.taskId);
        this.store.patch(taskId, { sessionId, resume: false });
      }
    } catch (error) {
      this.startFailed(taskId, error);
      return;
    }
    // Cancelled or paused while the session was opening.
    const now = this.store.getTask(taskId);
    if (!now || now.state !== "running") {
      await this.safeCancel(sessionId);
      return;
    }
    await this.promptLoop(taskId, sessionId, now.prompt);
  }

  private startFailed(taskId: string, error: unknown) {
    const task = this.store.getTask(taskId);
    if (!task || task.state !== "running") return;
    const reason = speakable(humanError(error), 140);
    if (task.attempts < task.maxAttempts) {
      this.retryAt.set(taskId, this.now() + this.backoffMs * task.attempts);
      this.store.transition(
        taskId,
        "queued",
        "task.progress",
        `Could not start the agent (${reason}). Retrying.`,
      );
      return;
    }
    this.store.transition(
      taskId,
      "failed",
      "task.failed",
      `Could not start the agent after ${task.attempts} tries: ${reason}`,
      { error: reason },
    );
    this.pump();
  }

  private async promptLoop(taskId: string, sessionId: string, firstText: string) {
    this.looping.add(taskId);
    try {
      let text: string | undefined = firstText;
      while (text !== undefined) {
        await this.host.prompt(sessionId, text);
        const task = this.store.getTask(taskId);
        if (!task || !ACTIVE.has(task.state)) return; // cancelled, paused or timed out meanwhile
        this.lastActivity.set(taskId, this.now());
        text = this.followUps.get(taskId)?.shift();
      }
      const summary = speakable(this.host.lastText(sessionId), 220);
      this.store.transition(
        taskId,
        "completed",
        "task.completed",
        summary ? `The agent says it finished: ${summary}` : "The agent says it finished.",
        { lastOutput: summary || undefined, activity: undefined },
      );
    } catch (error) {
      const task = this.store.getTask(taskId);
      if (!task || !ACTIVE.has(task.state)) return;
      const reason = speakable(humanError(error), 160);
      this.store.transition(taskId, "failed", "task.failed", `Failed: ${reason}`, {
        error: reason,
        activity: undefined,
      });
    } finally {
      this.looping.delete(taskId);
      this.permissions.delete(taskId);
      this.pump();
    }
  }

  // ---- session events ------------------------------------------------------

  /** Feed every recorded session payload here. Cheap for sessions that are not voice tasks. */
  onSessionPayload(sessionId: string, payload: unknown): void {
    const task = this.store.taskBySession(sessionId);
    if (!task || !ACTIVE.has(task.state)) return;
    this.lastActivity.set(task.taskId, this.now());
    const record = payload as {
      kind?: string;
      requestId?: string;
      params?: unknown;
      update?: { sessionUpdate?: string; title?: string; kind?: string; status?: string; rawInput?: unknown };
    } | null;

    if (record?.kind === "permission_request" && typeof record.requestId === "string") {
      this.onPermission(task, record.requestId, record.params);
      return;
    }
    const update = record?.update;
    if (!update?.sessionUpdate) return;

    // Any sign of progress while "blocked" means the request was answered elsewhere (the app's own sheet).
    if (task.state === "blocked" && !this.permissions.get(task.taskId)?.size) {
      this.store.transition(task.taskId, "running", "task.progress", "Approval handled; continuing.", {
        approval: undefined,
      });
    }
    if (update.sessionUpdate === "tool_call") {
      const activity = describeTool(update);
      this.store.transition(task.taskId, task.state === "blocked" ? "blocked" : "running", "task.tool", activity, {
        activity,
      });
    } else if (update.sessionUpdate === "tool_call_update" && update.status === "failed") {
      this.store.patch(task.taskId, { activity: "a step failed" });
    }
  }

  private onPermission(task: StoredTask, requestId: string, params: unknown) {
    const p = params as {
      toolCall?: { title?: string; kind?: string; rawInput?: unknown };
      options?: PermissionOption[];
    } | null;
    const tool = p?.toolCall ?? {};
    const risk = classifyRisk(tool);
    const summary = describeTool(tool);
    const bucket = this.permissions.get(task.taskId) ?? new Map<string, Pending>();
    bucket.set(requestId, { params, options: Array.isArray(p?.options) ? p.options : [] });
    this.permissions.set(task.taskId, bucket);
    this.store.transition(
      task.taskId,
      "blocked",
      "task.approval",
      `Needs approval (${risk}): ${summary}`,
      { approval: { requestId, risk, summary } },
    );
  }

  private async safeCancel(sessionId: string | undefined) {
    if (!sessionId) return;
    try {
      await this.host.cancel(sessionId);
    } catch {
      // The session may already be gone; the task state is what matters.
    }
  }
}
