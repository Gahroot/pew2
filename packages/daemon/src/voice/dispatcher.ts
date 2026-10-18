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
import type { AskAnswer } from "../acp/connect-types.js";
import { humanError } from "../errors.js";
import { buildDebrief, TurnEvidence } from "./debrief.js";
import {
  assessApproval,
  type ApprovalAssessment,
  describeTool,
  pickOption,
  speakable,
  type PermissionOption,
} from "./safety.js";
import type { VoiceGoalChange } from "./types.js";
import { ACTIVE, TERMINAL, type NewTask, type StoredGoal, type StoredTask, type VoiceStore } from "./store.js";

/** The slice of Daemon the dispatcher needs; a fake in tests. */
/** A screenshot as a prompt carries it: the bytes, inline, and a name to call it by. */
export interface PromptImage {
  name: string;
  mimeType: string;
  /** Base64, no `data:` prefix. */
  data: string;
}

export interface VoiceHost {
  /** Open a session in `cwd` and announce it to clients. Resolves with the session id. */
  startSession(providerId: string, cwd: string, tag: string): Promise<string>;
  /**
   * Resolves when the turn ends; rejects if it failed. `attachments` go to the
   * agent the same way a chat prompt's do — which block form each takes is the
   * daemon's to decide from what the agent says it accepts.
   */
  prompt(sessionId: string, text: string, attachments?: readonly PromptImage[]): Promise<void>;
  cancel(sessionId: string): Promise<void>;
  answerPermission(sessionId: string, requestId: string, optionId: string): boolean;
  /** Answer the agent's open `ask_user` question. False when it is no longer open. */
  answerAsk(sessionId: string, requestId: string, result: AskAnswer): boolean;
  hasSession(sessionId: string): boolean;
  /** What the agent said at the end of the current turn. */
  lastText(sessionId: string): string | undefined;
}

/** What a goal task does once a turn ends; decided from the run on disk (`goalRuns.ts`). */
export type GoalTurnDecision =
  | { kind: "continue"; prompt: string; goal?: StoredGoal }
  | { kind: "complete"; goal?: StoredGoal }
  | { kind: "needs_you"; say: string; goal?: StoredGoal }
  | { kind: "failed"; say: string; goal?: StoredGoal }
  | { kind: "stalled"; say: string; goal?: StoredGoal }
  /** No run found yet: an ordinary turn. */
  | { kind: "ordinary" };

export interface GoalHooks {
  afterTurn(task: StoredTask): Promise<GoalTurnDecision>;
}

/** "Continue this run" turns per user instruction; `followUp` resets the count. */
export const MAX_GOAL_CONTINUES = 6;

export const GOAL_COMPLETED_TEXT = "The agent reports the goal passed: verifier and final audit recorded.";

export interface OrchestratorOptions {
  now?: () => number;
  maxConcurrent?: number;
  /** A running (not blocked) task with no sign of life for this long is failed. */
  taskTimeoutMs?: number;
  retryBackoffMs?: number;
  /**
   * Screenshots by id, read for a prompt. Throws a speakable error when one is
   * gone. Without it a task that names any fails rather than going out blind.
   */
  readAttachments?: (attachmentIds: readonly string[]) => Promise<PromptImage[]>;
  /** Drives goal tasks past one turn; without it a goal task ends like any other. */
  goals?: GoalHooks;
}

/** An open `ask_user`, kept so a spoken answer can be mapped onto its question ids. */
interface OpenAsk {
  requestId: string;
  questions: Array<{ id: string; options: Array<{ label: string; value?: string }> }>;
}

/** One message for a running task's next turn, with any screenshots that go with it. */
interface FollowUp {
  text: string;
  attachmentIds: string[];
}

interface Pending {
  params: unknown;
  options: PermissionOption[];
  assessment: ApprovalAssessment;
}

export type Outcome<T = StoredTask> = { ok: true; value: T } | { ok: false; error: string };

export class Orchestrator {
  private readonly now: () => number;
  private readonly maxConcurrent: number;
  private readonly timeoutMs: number;
  private readonly backoffMs: number;
  /** Open permission requests per task, with the options to answer them. */
  private readonly permissions = new Map<string, Map<string, Pending>>();
  private readonly followUps = new Map<string, FollowUp[]>();
  private readonly readAttachments?: OrchestratorOptions["readAttachments"];
  private readonly retryAt = new Map<string, number>();
  private readonly lastActivity = new Map<string, number>();
  /** Prompt loops currently awaiting an agent turn. */
  private readonly looping = new Set<string>();
  /** Tool calls seen since the task last started running, for the debrief. */
  private readonly evidence = new Map<string, TurnEvidence>();
  private readonly goals?: GoalHooks;
  /** Open agent questions per task. */
  private readonly asks = new Map<string, OpenAsk>();

  constructor(
    private readonly store: VoiceStore,
    private readonly host: VoiceHost,
    options: OrchestratorOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.maxConcurrent = options.maxConcurrent ?? 3;
    this.timeoutMs = options.taskTimeoutMs ?? 30 * 60_000;
    this.backoffMs = options.retryBackoffMs ?? 5_000;
    this.readAttachments = options.readAttachments;
    this.goals = options.goals;
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
  followUp(taskId: string, text: string, attachmentIds: readonly string[] = []): Outcome {
    const task = this.store.getTask(taskId);
    if (!task) return { ok: false, error: `No task ${taskId}.` };
    if (task.state === "cancelled") return { ok: false, error: "That task was cancelled." };
    const line = text.trim();
    if (!line) return { ok: false, error: "Empty instruction." };
    // `/commit` and friends are expanded by the agent only when the prompt
    // *starts* with them, so a command is always its own turn, sent verbatim.
    const command = isSlashCommand(line);
    // The user spoke to it: a goal gets a fresh run of continue turns.
    if (task.goal) this.store.patch(taskId, { goal: { ...task.goal, continues: 0, lastRunUpdatedAt: undefined } });
    // A goal parked on "keep going?" or "needs you" has no turn to queue behind.
    const parked = task.state === "blocked" && !this.looping.has(taskId) && !task.approval && !task.question;

    if (!parked && (ACTIVE.has(task.state) || task.state === "queued" || task.state === "paused")) {
      if ((task.state === "queued" || task.state === "paused") && !command) {
        // Not started: fold into the task's own prompt so the agent sees one
        // instruction, and its screenshots go out with that first prompt.
        this.store.patch(taskId, {
          prompt: `${task.prompt}\n\nAdditional instruction: ${line}`,
          ...withPending(task, attachmentIds),
        });
      } else {
        const list = this.followUps.get(taskId) ?? [];
        list.push({ text: line, attachmentIds: [...attachmentIds] });
        this.followUps.set(taskId, list);
        this.store.transition(taskId, task.state, "task.progress", `Follow-up queued: ${speakable(line, 80)}`);
      }
      return { ok: true, value: this.store.getTask(taskId) ?? task };
    }

    // Finished or failed: run again.
    const reuse = task.sessionId !== undefined && this.host.hasSession(task.sessionId);
    this.followUps.set(taskId, []);
    this.store.transition(taskId, "queued", "task.queued", `Queued follow-up: ${speakable(line, 80)}`, {
      prompt: reuse || command ? line : `Follow-up on an earlier task "${task.title}".\n\n${line}`,
      resume: reuse,
      sessionId: reuse ? task.sessionId : undefined,
      attempts: 0,
      error: undefined,
      interrupted: undefined,
      ...withPending(task, attachmentIds),
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
      this.asks.delete(taskId);
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
    this.asks.delete(taskId);
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

  /** How an open request was judged and worded; undefined once answered. */
  assessmentFor(taskId: string, requestId: string): ApprovalAssessment | undefined {
    return this.permissions.get(taskId)?.get(requestId)?.assessment;
  }

  /** Decides whether a safe request is answered without asking. Set by the voice service. */
  autoApprove: (() => boolean) | undefined;

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
        { startedAt: task.startedAt ?? now, debrief: undefined },
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
    await this.promptLoop(taskId, sessionId, { text: now.prompt, attachmentIds: now.pendingAttachmentIds ?? [] });
  }

  /**
   * One prompt to the agent, with its screenshots.
   *
   * The pictures are read *before* anything is sent: a prompt that says "use
   * the attached screenshot" and arrives without it would have the agent guess
   * at a fix it was never shown. A missing file therefore fails the turn with
   * a reason the user can act on ("attach it again").
   *
   * Recorded as sent once handed over, not once the turn ends — the agent has
   * it from that moment, and a turn that later fails still saw the picture.
   */
  private async sendTurn(taskId: string, sessionId: string, turn: FollowUp): Promise<void> {
    if (turn.attachmentIds.length === 0) {
      await this.host.prompt(sessionId, turn.text);
      return;
    }
    if (!this.readAttachments) throw new Error("Screenshots cannot be sent from here.");
    const images = await this.readAttachments(turn.attachmentIds);
    const names = images.map((image) => image.name).join(", ");
    const text = `${turn.text}\n\n${images.length === 1 ? "A screenshot is" : `${images.length} screenshots are`} attached (${names}), forwarded by the user. Look at ${images.length === 1 ? "it" : "them"} before acting on the instruction above.`;
    const task = this.store.getTask(taskId);
    const sent = [...new Set([...(task?.attachmentIds ?? []), ...turn.attachmentIds])];
    this.store.patch(taskId, { attachmentIds: sent, pendingAttachmentIds: undefined });
    for (const id of turn.attachmentIds) this.store.markScreenshotSent(id, taskId);
    await this.host.prompt(sessionId, text, images);
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

  private async promptLoop(taskId: string, sessionId: string, first: FollowUp) {
    this.looping.add(taskId);
    const evidence = new TurnEvidence();
    this.evidence.set(taskId, evidence);
    try {
      let next: FollowUp | undefined = first;
      for (;;) {
        while (next !== undefined) {
          await this.sendTurn(taskId, sessionId, next);
          const task = this.store.getTask(taskId);
          if (!task || !ACTIVE.has(task.state)) return; // cancelled, paused or timed out meanwhile
          this.lastActivity.set(taskId, this.now());
          next = this.followUps.get(taskId)?.shift();
        }
        const task = this.store.getTask(taskId);
        if (!task?.goal || !this.goals) break;
        const decision = await this.goalDecision(task);
        // Re-read after the await: a pause, cancel or timeout meanwhile wins, and nothing more is sent.
        const now = this.store.getTask(taskId);
        if (!now?.goal || now.state !== "running") return;
        const queued = this.followUps.get(taskId)?.shift();
        if (queued) {
          next = queued;
          continue;
        }
        if (decision.kind === "ordinary") break;
        if (this.finishGoalTurn(now, decision, evidence, sessionId)) return;
        if (decision.kind !== "continue") return;
        next = { text: decision.prompt, attachmentIds: [] };
      }
      const lastText = this.host.lastText(sessionId);
      const summary = speakable(lastText, 220);
      this.store.transition(
        taskId,
        "completed",
        "task.completed",
        summary ? `The agent says it finished: ${summary}` : "The agent says it finished.",
        { lastOutput: summary || undefined, activity: undefined, debrief: buildDebrief({ lastText, steps: evidence.list() }) },
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
      if (this.evidence.get(taskId) === evidence) this.evidence.delete(taskId);
      this.pump();
    }
  }

  // ---- goals ---------------------------------------------------------------

  private async goalDecision(task: StoredTask): Promise<GoalTurnDecision> {
    try {
      return (await this.goals?.afterTurn(task)) ?? { kind: "ordinary" };
    } catch {
      // An unreadable run is not a verdict on the work: end like an ordinary turn.
      return { kind: "ordinary" };
    }
  }

  /**
   * Apply a goal decision. Returns true when the task left the loop (finished,
   * blocked or failed); false only for a continue that is going out.
   */
  private finishGoalTurn(task: StoredTask, decision: Exclude<GoalTurnDecision, { kind: "ordinary" }>, evidence: TurnEvidence, sessionId: string): boolean {
    const goal: StoredGoal = decision.goal ?? (task.goal as StoredGoal);
    const runId = goal.runId;
    const extra = (change: VoiceGoalChange) => ({
      goal: { ...(runId ? { runId } : null), change },
    });
    switch (decision.kind) {
      case "continue": {
        if (goal.continues >= MAX_GOAL_CONTINUES) {
          this.store.transition(
            task.taskId,
            "blocked",
            "task.blocked",
            `The goal has had ${MAX_GOAL_CONTINUES} continue turns since you last spoke to it. Keep going?`,
            { goal, activity: undefined },
            extra("stalled"),
          );
          return true;
        }
        this.store.patch(task.taskId, { goal: { ...goal, continues: goal.continues + 1 } });
        this.lastActivity.set(task.taskId, this.now());
        return false;
      }
      case "complete": {
        const lastText = this.host.lastText(sessionId);
        const summary = speakable(lastText, 220);
        this.store.transition(task.taskId, "completed", "task.completed", GOAL_COMPLETED_TEXT, {
          goal,
          lastOutput: summary || undefined,
          activity: undefined,
          debrief: buildDebrief({ lastText, steps: evidence.list() }),
        }, extra("passed"));
        return true;
      }
      case "needs_you":
        this.store.transition(task.taskId, "blocked", "task.blocked", `The goal needs you: ${speakable(decision.say, 200)}`, { goal, activity: undefined }, extra("needs_you"));
        return true;
      case "failed":
        this.store.transition(task.taskId, "failed", "task.failed", speakable(decision.say, 200) || "The goal run failed.", { goal, activity: undefined, error: "goal run failed" }, extra("failed"));
        return true;
      case "stalled":
        this.store.transition(task.taskId, "blocked", "task.blocked", `${speakable(decision.say, 160)} Keep going, or try a different approach?`, { goal, activity: undefined }, extra("stalled"));
        return true;
    }
  }

  // ---- questions -----------------------------------------------------------

  /**
   * Answer the agent's open question. Checked against the question open *now*,
   * like approvals: an answer to an earlier question is refused, not applied.
   * A plain string answers every question, matched to an option label when one fits.
   */
  answerQuestion(taskId: string, requestId: string, answer: string | AskAnswer): Outcome {
    const task = this.store.getTask(taskId);
    if (!task) return { ok: false, error: `No task ${taskId}.` };
    if (!task.question) return { ok: false, error: "Stale: that task is not waiting on a question any more." };
    if (task.question.requestId !== requestId) {
      return { ok: false, error: "Stale: a different question is open now. Ask for open questions." };
    }
    const open = this.asks.get(taskId);
    if (!open || open.requestId !== requestId || !task.sessionId) {
      return { ok: false, error: "Stale: the agent is no longer waiting on that question." };
    }
    const result = typeof answer === "string" ? toAskAnswer(open, answer) : answer;
    if (!this.host.answerAsk(task.sessionId, requestId, result)) {
      return { ok: false, error: "Stale: the agent had already moved on from that question." };
    }
    this.closeQuestion(task, requestId, typeof answer === "string" ? `Answered: ${speakable(answer, 80)}` : "Question answered.");
    return { ok: true, value: this.store.getTask(taskId) ?? task };
  }

  private onAsk(task: StoredTask, requestId: string, record: { questions?: unknown }) {
    const questions = Array.isArray(record.questions) ? record.questions : [];
    const parsed: OpenAsk["questions"] = [];
    const spoken: string[] = [];
    const labels: string[] = [];
    for (const q of questions) {
      const item = q as { id?: unknown; question?: unknown; options?: unknown } | null;
      if (!item || typeof item.id !== "string") continue;
      const options = (Array.isArray(item.options) ? item.options : [])
        .map((o) => o as { label?: unknown; value?: unknown } | null)
        .filter((o): o is { label: string; value?: unknown } => !!o && typeof o.label === "string")
        .map((o) => ({ label: o.label, ...(typeof o.value === "string" ? { value: o.value } : null) }));
      parsed.push({ id: item.id, options });
      if (typeof item.question === "string") spoken.push(speakable(item.question, 160));
      for (const o of options) labels.push(speakable(o.label, 40));
    }
    this.asks.set(task.taskId, { requestId, questions: parsed });
    const text = speakable(spoken.filter(Boolean).join(" "), 240) || "The agent has a question.";
    const options = labels.filter(Boolean).slice(0, 8);
    this.store.transition(task.taskId, "blocked", "task.blocked", `Question: ${text}`, {
      question: { requestId, text, ...(options.length ? { options } : null) },
    });
  }

  private closeQuestion(task: StoredTask, requestId: string, note: string) {
    if (this.asks.get(task.taskId)?.requestId === requestId) this.asks.delete(task.taskId);
    if (task.question?.requestId !== requestId) return;
    this.lastActivity.set(task.taskId, this.now());
    const pendingApproval = !!task.approval;
    this.store.transition(task.taskId, pendingApproval ? "blocked" : "running", "task.progress", note, { question: undefined });
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
      update?: {
        sessionUpdate?: string;
        toolCallId?: unknown;
        title?: string;
        kind?: string;
        status?: string;
        rawInput?: unknown;
      };
    } | null;

    if (record?.kind === "permission_request" && typeof record.requestId === "string") {
      this.onPermission(task, record.requestId, record.params);
      return;
    }
    if (record?.kind === "ask_user" && typeof record.requestId === "string") {
      this.onAsk(task, record.requestId, record as { questions?: unknown });
      return;
    }
    if (record?.kind === "ask_user_closed" && typeof record.requestId === "string") {
      this.closeQuestion(task, record.requestId, "Question closed; continuing.");
      return;
    }
    const update = record?.update;
    if (!update?.sessionUpdate) return;
    this.evidence.get(task.taskId)?.record(update);

    // Any sign of progress while "blocked" means the request was answered elsewhere (the app's own sheet).
    if (task.state === "blocked" && !this.permissions.get(task.taskId)?.size && !task.question && this.looping.has(task.taskId)) {
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
    const assessment = assessApproval(tool, task.cwd);
    const risk = assessment.risk;
    const summary = assessment.speech || describeTool(tool);
    const bucket = this.permissions.get(task.taskId) ?? new Map<string, Pending>();
    bucket.set(requestId, { params, options: Array.isArray(p?.options) ? p.options : [], assessment });
    this.permissions.set(task.taskId, bucket);
    this.store.transition(
      task.taskId,
      "blocked",
      "task.approval",
      `Needs approval (${risk}): ${summary}`,
      { approval: { requestId, risk, summary } },
    );
    // Resolver is registered and the UI told above; only now may it be answered.
    if (assessment.safe && this.autoApprove?.()) {
      const r = this.answerApproval(task.taskId, requestId, "approve");
      if (r.ok) this.store.patch(r.value.taskId, { activity: `auto-approved: ${summary}` });
    }
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

/** A spoken answer as the agent expects it: each question gets the option it names, or the words. */
function toAskAnswer(open: OpenAsk, answer: string): AskAnswer {
  const said = answer.trim();
  const answers: Record<string, string> = {};
  for (const q of open.questions) {
    const option = q.options.find((o) => o.label.toLowerCase() === said.toLowerCase());
    answers[q.id] = option ? option.value ?? option.label : said;
  }
  return { action: "answer", answers };
}

/** `/name` at the very start: an agent command, not prose. */
export function isSlashCommand(text: string): boolean {
  return /^\/[a-z][\w-]*(\s|$)/i.test(text.trim());
}

/** A task's screenshots still to send, with `more` added and nothing twice. */
function withPending(task: StoredTask, more: readonly string[]): Partial<StoredTask> {
  if (more.length === 0) return {};
  return { pendingAttachmentIds: [...new Set([...(task.pendingAttachmentIds ?? []), ...more])] };
}
