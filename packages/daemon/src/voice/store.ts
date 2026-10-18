/**
 * Persistent task + event state for voice orchestration.
 *
 * GPT Realtime is disposable, so everything it needs to be useful again lives
 * here, on disk, outside it: tasks, a gapless event log, a command journal and
 * the decisions the user spoke. One JSON document written atomically after each
 * change; a daemon that dies mid-turn reloads it and reconciles honestly.
 *
 * Mutators are synchronous (the in-memory state is the truth the dispatcher
 * reads), persistence is queued behind them, and `flush()` is how a caller
 * waits for the disk — the command journal does, before it dispatches.
 */
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { TaskState, VoiceDebrief, VoiceEvent, VoiceGoalProgress, VoiceQuestion, VoiceTask } from "./types.js";
import { writeFileAtomic } from "../atomic-file.js";
import { classifyKind, type EventKind } from "./classify.js";

export interface HistoryEntry {
  at: number;
  state: TaskState;
  note?: string;
}

/**
 * What makes a task an EZ Coder goal run rather than one turn. The run itself
 * lives in ezcoder's own goal state on disk; this is how the task finds it and
 * how far the loop that keeps it going has got.
 */
export interface StoredGoal {
  /** The objective as the user gave it. */
  objective: string;
  /** Epoch ms the goal was asked for; the run is the newest created after it. */
  requestedAt: number;
  /** ezcoder's run id, once the run is found. */
  runId?: string;
  /** "Continue this run" turns sent since the user last spoke to it. */
  continues: number;
  /** The run's `updatedAt` when last read, for stall detection. */
  lastRunUpdatedAt?: string;
  progress?: VoiceGoalProgress;
}

/**
 * Something the conversation has been about, so "that" and "the other
 * project" resolve to real ids. Persisted so it survives a new voice session.
 */
export interface FocusRef {
  kind: "project" | "task" | "goal" | "result" | "question";
  id: string;
  /** Speakable name for it. */
  label: string;
  projectId?: string;
  projectName?: string;
  /** Epoch ms it was last mentioned. */
  at: number;
  via: "user" | "tool" | "event";
  /** The id of a ref this one overrides ("actually, the other one"). */
  corrects?: string;
}

/** What the last opening check-in already covered. */
export interface CheckinState {
  /** DAVE project name -> its top objective id when last seen. */
  daveSeen?: Record<string, string>;
  /** Epoch ms of the last check-in. */
  at?: number;
  /** Highest eventId the last check-in covered. */
  eventId?: number;
}

export interface StoredTask {
  taskId: string;
  projectId: string;
  projectName: string;
  /** The repository a worktree task belongs to; see `VoiceTask.repo`. */
  repo?: NonNullable<VoiceTask["repo"]>;
  /** Where the agent runs. Taken from the registry, never from the model. */
  cwd: string;
  providerId: string;
  title: string;
  /** The instruction as given; follow-ups are appended to history, not here. */
  prompt: string;
  state: TaskState;
  priority: number;
  /** Read-only tasks never hold the project's worktree lock. */
  readOnly: boolean;
  dependsOn: string[];
  sessionId?: string;
  activity?: string;
  approval?: NonNullable<VoiceTask["approval"]>;
  /** Last thing the agent said, already speakable. */
  lastOutput?: string;
  /** What the last finished turn amounted to; cleared when the task runs again. */
  debrief?: VoiceDebrief;
  error?: string;
  /** Ended because the daemon restarted, not because the agent finished or failed. */
  interrupted?: boolean;
  /** Start by prompting the existing session instead of opening a new one. */
  resume?: boolean;
  /** Screenshots to go with the next prompt this task sends; see `screenshots.ts`. */
  pendingAttachmentIds?: string[];
  /** Screenshots already handed to this task's agent, oldest first. */
  attachmentIds?: string[];
  /** Set on a task that runs an EZ Coder goal; see `StoredGoal`. */
  goal?: StoredGoal;
  /** An open question from the agent; cleared when it closes or the task stops. */
  question?: VoiceQuestion;
  /**
   * Set when the user cleared this finished task off their screens. It stays
   * on disk (the model can still be asked about it) but leaves snapshots, and
   * any later event for it clears this so news is never hidden.
   */
  dismissedAt?: number;
  attempts: number;
  maxAttempts: number;
  history: HistoryEntry[];
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
}

/** A screenshot held for voice. `path` stays on this machine; clients get `VoiceAttachment`. */
export interface StoredScreenshot {
  attachmentId: string;
  name: string;
  mimeType: string;
  size: number;
  path: string;
  at: number;
  sentTo: string[];
}

export interface Decision {
  at: number;
  text: string;
  taskId?: string;
}

export interface JournalEntry {
  name: string;
  at: number;
  status: "pending" | "done";
  result?: unknown;
}

interface Document {
  version: 1;
  nextEventId: number;
  nextTask: number;
  tasks: Record<string, StoredTask>;
  events: VoiceEvent[];
  journal: Record<string, JournalEntry>;
  decisions: Decision[];
  heardEventId: number;
  /** Absent from a file written before screenshots existed; `open` fills it in. */
  screenshots: Record<string, StoredScreenshot>;
  nextScreenshot: number;
  /** Absent from a file written before references existed. */
  focus?: FocusRef[];
  /** Absent from a file written before the opening check-in existed. */
  checkin?: CheckinState;
}

export const MAX_EVENTS = 2000;
export const MAX_JOURNAL = 500;
export const MAX_DECISIONS = 100;
export const MAX_FOCUS = 50;
const MAX_HISTORY = 50;

/** Task states that no longer need a worker. */
export const TERMINAL: ReadonlySet<TaskState> = new Set(["failed", "completed", "verified", "cancelled"]);
/** Task states that hold a project's worktree lock (unless read-only). */
export const ACTIVE: ReadonlySet<TaskState> = new Set(["running", "blocked"]);
/** A dependency is met once the agent said it finished. */
const DEP_MET: ReadonlySet<TaskState> = new Set(["completed", "verified"]);

export type Listener = (event: VoiceEvent, task: StoredTask) => void;

/** Optional fields an event carries beyond the task's own. */
export interface EventExtra {
  goal?: VoiceEvent["goal"];
}

export interface NewTask {
  projectId: string;
  projectName: string;
  /** Screenshots to send with the task's first prompt. */
  attachmentIds?: string[];
  repo?: NonNullable<VoiceTask["repo"]>;
  cwd: string;
  providerId: string;
  title: string;
  prompt: string;
  priority?: number;
  readOnly?: boolean;
  dependsOn?: string[];
  maxAttempts?: number;
  goal?: StoredGoal;
}

export type JournalBegin =
  | { status: "new" }
  | { status: "done"; result: unknown }
  | { status: "pending" };

function emptyDocument(): Document {
  return {
    version: 1,
    nextEventId: 1,
    nextTask: 1,
    tasks: {},
    events: [],
    journal: {},
    decisions: [],
    heardEventId: 0,
    screenshots: {},
    nextScreenshot: 1,
  };
}

export function toVoiceTask(task: StoredTask): VoiceTask {
  return {
    taskId: task.taskId,
    projectId: task.projectId,
    projectName: task.projectName,
    ...(task.repo ? { repo: task.repo } : null),
    ...(task.sessionId ? { sessionId: task.sessionId } : null),
    title: task.title,
    state: task.state,
    priority: task.priority,
    ...(task.activity ? { activity: task.activity } : null),
    ...(task.approval ? { approval: task.approval } : null),
    ...(task.debrief ? { debrief: task.debrief } : null),
    ...(task.attachmentIds?.length ? { attachmentIds: [...task.attachmentIds] } : null),
    // A goal task says so even before its run is found: it is not one turn.
    ...(task.goal ? { goal: task.goal.progress ? { ...task.goal.progress } : { done: 0, total: 0 } } : null),
    ...(task.question ? { question: { ...task.question, ...(task.question.options ? { options: [...task.question.options] } : null) } } : null),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

export class VoiceStore {
  private doc: Document;
  private readonly listeners = new Set<Listener>();
  private dirty = false;
  private writing: Promise<void> = Promise.resolve();
  /** The last persistence failure, so a caller can report a disk that is not taking writes. */
  lastWriteError?: string;

  private constructor(
    private readonly path: string | undefined,
    private readonly now: () => number,
    doc: Document,
  ) {
    this.doc = doc;
  }

  /** In-memory only, for tests and for a daemon with no data dir. */
  static memory(now: () => number = Date.now): VoiceStore {
    return new VoiceStore(undefined, now, emptyDocument());
  }

  static async open(path: string, now: () => number = Date.now): Promise<VoiceStore> {
    let doc = emptyDocument();
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<Document> | null;
      if (parsed && typeof parsed === "object" && parsed.version === 1) {
        doc = { ...emptyDocument(), ...parsed };
      }
    } catch {
      // Missing or corrupt starts empty; a voice state file is never worth refusing to boot over.
    }
    // Never hand out an id already used, even if the counters were lost.
    const lastEvent = doc.events.reduce((m, e) => Math.max(m, e.eventId), 0);
    doc.nextEventId = Math.max(doc.nextEventId, lastEvent + 1);
    const lastTask = Object.keys(doc.tasks).reduce((m, id) => Math.max(m, Number(id.slice(2)) || 0), 0);
    doc.nextTask = Math.max(doc.nextTask, lastTask + 1);
    return new VoiceStore(path, now, doc);
  }

  // ---- persistence ---------------------------------------------------------

  private persist() {
    if (!this.path || this.dirty) return;
    this.dirty = true;
    const path = this.path;
    this.writing = this.writing.then(async () => {
      this.dirty = false;
      try {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await writeFileAtomic(path, JSON.stringify(this.doc));
        this.lastWriteError = undefined;
      } catch (error) {
        this.lastWriteError = error instanceof Error ? error.message : String(error);
      }
    });
  }

  /** Resolves once everything changed so far is on disk. */
  flush(): Promise<void> {
    return this.writing;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ---- tasks ---------------------------------------------------------------

  getTask(taskId: string): StoredTask | undefined {
    return this.doc.tasks[taskId];
  }

  /** All tasks, newest first, ties by id for determinism. */
  tasks(): StoredTask[] {
    return Object.values(this.doc.tasks).sort(
      (a, b) => b.createdAt - a.createdAt || b.taskId.localeCompare(a.taskId, "en", { numeric: true }),
    );
  }

  taskBySession(sessionId: string): StoredTask | undefined {
    return Object.values(this.doc.tasks).find(
      (t) => t.sessionId === sessionId && !TERMINAL.has(t.state),
    );
  }

  /** Create a queued task and announce it. */
  createTask(input: NewTask): StoredTask {
    const now = this.now();
    const taskId = `t_${this.doc.nextTask++}`;
    const task: StoredTask = {
      taskId,
      projectId: input.projectId,
      projectName: input.projectName,
      ...(input.repo ? { repo: input.repo } : null),
      cwd: input.cwd,
      providerId: input.providerId,
      title: input.title,
      prompt: input.prompt,
      state: "queued",
      priority: input.priority ?? 0,
      readOnly: input.readOnly ?? false,
      dependsOn: [...(input.dependsOn ?? [])],
      ...(input.attachmentIds?.length ? { pendingAttachmentIds: [...input.attachmentIds] } : null),
      ...(input.goal ? { goal: { ...input.goal } } : null),
      attempts: 0,
      maxAttempts: input.maxAttempts ?? 2,
      history: [{ at: now, state: "queued" }],
      createdAt: now,
      updatedAt: now,
    };
    this.doc.tasks[taskId] = task;
    this.emit(task, "task.queued", `Queued: ${task.title}`);
    return task;
  }

  /**
   * Move a task to `state` and record why. Always announces; a no-op move
   * (same state) is allowed because some events, like progress, change nothing
   * but the activity line.
   */
  transition(
    taskId: string,
    state: TaskState,
    kind: EventKind,
    text: string,
    patch: Partial<StoredTask> = {},
    eventExtra: EventExtra = {},
  ): { event: VoiceEvent; task: StoredTask } | undefined {
    const task = this.doc.tasks[taskId];
    if (!task) return undefined;
    const now = this.now();
    Object.assign(task, patch);
    // Something new happened to it: it is worth showing again.
    delete task.dismissedAt;
    if (task.state !== state) {
      task.state = state;
      task.history.push({ at: now, state, note: text.slice(0, 160) });
      if (task.history.length > MAX_HISTORY) task.history.splice(0, task.history.length - MAX_HISTORY);
    }
    if (TERMINAL.has(state) || state === "paused" || state === "queued") delete task.approval;
    // Nobody is waiting on an answer from a task that stopped.
    if (TERMINAL.has(state) || state === "paused") delete task.question;
    task.updatedAt = now;
    const event = this.emit(task, kind, text, eventExtra);
    return { event, task };
  }

  /**
   * Record which repository each task belongs to, for tasks saved before that
   * was tracked. Silent and idempotent: it announces nothing, never overwrites
   * a `repo` already set, and writes only when something changed. Events
   * already logged are history and keep what they said.
   */
  backfillRepos(repoOf: (task: StoredTask) => StoredTask["repo"]): number {
    let filled = 0;
    for (const task of Object.values(this.doc.tasks)) {
      if (task.repo) continue;
      const repo = repoOf(task);
      if (!repo) continue;
      task.repo = repo;
      filled += 1;
    }
    if (filled > 0) this.persist();
    return filled;
  }

  // ---- dismissal -----------------------------------------------------------

  /**
   * Mark finished tasks as cleared by the user and return the ones that
   * changed. A task still live is never dismissed, whatever was asked, so a
   * tap on a stale screen cannot hide work in progress. Silent: no event, as
   * dismissing is a view choice, not something that happened to the task.
   */
  dismiss(match: (task: StoredTask) => boolean): StoredTask[] {
    const now = this.now();
    const dismissed = Object.values(this.doc.tasks)
      .filter((t) => TERMINAL.has(t.state) && t.dismissedAt === undefined && match(t))
      .sort((a, b) => a.taskId.localeCompare(b.taskId, "en", { numeric: true }));
    for (const task of dismissed) task.dismissedAt = now;
    if (dismissed.length > 0) this.persist();
    return dismissed;
  }

  /** Dismissed tasks that still have events in the log, id order. */
  dismissedWithEvents(): string[] {
    const ids = new Set<string>();
    for (const e of this.doc.events) if (this.doc.tasks[e.taskId]?.dismissedAt !== undefined) ids.add(e.taskId);
    return [...ids].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  }

  // ---- screenshots ---------------------------------------------------------

  /** Record a screenshot already written to `path`. Ids are this store's, never the phone's. */
  addScreenshot(input: Omit<StoredScreenshot, "attachmentId" | "at" | "sentTo">): StoredScreenshot {
    const shot: StoredScreenshot = {
      ...input,
      attachmentId: `a_${this.doc.nextScreenshot++}`,
      at: this.now(),
      sentTo: [],
    };
    this.doc.screenshots[shot.attachmentId] = shot;
    this.persist();
    return shot;
  }

  /** The id an `addScreenshot` call will hand out, so its file can be named first. */
  peekScreenshotId(): string {
    return `a_${this.doc.nextScreenshot}`;
  }

  screenshot(attachmentId: string): StoredScreenshot | undefined {
    return this.doc.screenshots[attachmentId];
  }

  /** Oldest first. */
  screenshots(): StoredScreenshot[] {
    return Object.values(this.doc.screenshots).sort((a, b) => a.at - b.at || a.attachmentId.localeCompare(b.attachmentId, "en", { numeric: true }));
  }

  /** Note that `taskId`'s agent has been handed it. Idempotent. */
  markScreenshotSent(attachmentId: string, taskId: string): void {
    const shot = this.doc.screenshots[attachmentId];
    if (!shot || shot.sentTo.includes(taskId)) return;
    shot.sentTo.push(taskId);
    this.persist();
  }

  removeScreenshot(attachmentId: string): StoredScreenshot | undefined {
    const shot = this.doc.screenshots[attachmentId];
    if (!shot) return undefined;
    delete this.doc.screenshots[attachmentId];
    // Not handed to anyone yet: nothing will send it now.
    for (const task of Object.values(this.doc.tasks)) {
      if (task.pendingAttachmentIds?.includes(attachmentId)) {
        task.pendingAttachmentIds = task.pendingAttachmentIds.filter((id) => id !== attachmentId);
      }
    }
    this.persist();
    return shot;
  }

  /**
   * Drop what is past its age or beyond the count, oldest first, and return
   * them so the caller can delete their files. A screenshot still waiting to
   * go out with a queued task is kept whatever its age: that task will send it.
   */
  pruneScreenshots(maxCount: number, maxAgeMs: number): StoredScreenshot[] {
    const waiting = new Set(Object.values(this.doc.tasks).flatMap((t) => (TERMINAL.has(t.state) ? [] : t.pendingAttachmentIds ?? [])));
    const all = this.screenshots();
    const cutoff = this.now() - maxAgeMs;
    const excess = Math.max(0, all.length - maxCount);
    const removed = all.filter((shot, index) => !waiting.has(shot.attachmentId) && (index < excess || shot.at < cutoff));
    for (const shot of removed) delete this.doc.screenshots[shot.attachmentId];
    if (removed.length > 0) this.persist();
    return removed;
  }

  /** Update fields without announcing (activity line, last output, session id). */
  patch(taskId: string, patch: Partial<StoredTask>): StoredTask | undefined {
    const task = this.doc.tasks[taskId];
    if (!task) return undefined;
    Object.assign(task, patch);
    task.updatedAt = this.now();
    this.persist();
    return task;
  }

  /** Change the priority of a task still waiting. */
  setPriority(taskId: string, priority: number): StoredTask | undefined {
    return this.patch(taskId, { priority });
  }

  addDependency(taskId: string, dependsOn: string): StoredTask | undefined {
    const task = this.doc.tasks[taskId];
    if (!task || task.dependsOn.includes(dependsOn)) return task;
    return this.patch(taskId, { dependsOn: [...task.dependsOn, dependsOn] });
  }

  // ---- scheduling queries --------------------------------------------------

  /** The writer currently holding this project's worktree, if any. */
  lockHolder(projectId: string, exceptTaskId?: string): StoredTask | undefined {
    return Object.values(this.doc.tasks).find(
      (t) =>
        t.projectId === projectId &&
        t.taskId !== exceptTaskId &&
        !t.readOnly &&
        ACTIVE.has(t.state),
    );
  }

  /** Every dependency met? A missing or failed dependency never is. */
  dependenciesMet(task: StoredTask): boolean {
    return task.dependsOn.every((id) => {
      const dep = this.doc.tasks[id];
      return dep !== undefined && DEP_MET.has(dep.state);
    });
  }

  /** A dependency that can never be met (failed or cancelled), if any. */
  brokenDependency(task: StoredTask): StoredTask | undefined {
    for (const id of task.dependsOn) {
      const dep = this.doc.tasks[id];
      if (!dep || dep.state === "failed" || dep.state === "cancelled") {
        return dep ?? ({ taskId: id } as StoredTask);
      }
    }
    return undefined;
  }

  /** Why a queued task is not running yet, in a speakable phrase. */
  waitingFor(task: StoredTask): string | undefined {
    const unmet = task.dependsOn.find((id) => {
      const dep = this.doc.tasks[id];
      return !dep || !DEP_MET.has(dep.state);
    });
    if (unmet) return `waiting for ${unmet}`;
    if (!task.readOnly) {
      const holder = this.lockHolder(task.projectId, task.taskId);
      if (holder) return `waiting for ${holder.taskId} to finish in ${task.projectName}`;
    }
    return undefined;
  }

  /** Queued tasks in dispatch order: priority desc, then oldest first. */
  queue(): StoredTask[] {
    return Object.values(this.doc.tasks)
      .filter((t) => t.state === "queued")
      .sort(
        (a, b) =>
          b.priority - a.priority ||
          a.createdAt - b.createdAt ||
          a.taskId.localeCompare(b.taskId, "en", { numeric: true }),
      );
  }

  running(): StoredTask[] {
    return Object.values(this.doc.tasks).filter((t) => ACTIVE.has(t.state));
  }

  // ---- events --------------------------------------------------------------

  private emit(task: StoredTask, kind: EventKind, text: string, extra: EventExtra = {}): VoiceEvent {
    const event: VoiceEvent = {
      eventId: this.doc.nextEventId++,
      taskId: task.taskId,
      projectId: task.projectId,
      projectName: task.projectName,
      kind,
      class: classifyKind(kind),
      text,
      at: this.now(),
      // Every report of this event can then name the repository, not the checkout.
      ...(task.repo ? { repo: task.repo } : null),
      ...(extra.goal ? { goal: { ...extra.goal } } : null),
    };
    this.doc.events.push(event);
    if (this.doc.events.length > MAX_EVENTS) this.doc.events.splice(0, this.doc.events.length - MAX_EVENTS);
    this.persist();
    for (const listener of this.listeners) {
      try {
        listener(event, task);
      } catch {
        // A broken listener must not stop the state change that already happened.
      }
    }
    return event;
  }

  get lastEventId(): number {
    return this.doc.nextEventId - 1;
  }

  eventsSince(since: number, limit = 200): VoiceEvent[] {
    return this.doc.events.filter((e) => e.eventId > since).slice(0, limit);
  }

  recentEvents(taskId: string | undefined, limit: number): VoiceEvent[] {
    const list = taskId ? this.doc.events.filter((e) => e.taskId === taskId) : this.doc.events;
    return list.slice(-limit);
  }

  // ---- heard cursor + decisions ---------------------------------------------

  get heardEventId(): number {
    return this.doc.heardEventId;
  }

  /** Monotone: a late or replayed close can never move the cursor backwards. */
  markHeard(eventId: number): number {
    if (eventId > this.doc.heardEventId) {
      this.doc.heardEventId = Math.min(eventId, this.lastEventId);
      this.persist();
    }
    return this.doc.heardEventId;
  }

  addDecision(text: string, taskId?: string): Decision {
    const decision: Decision = { at: this.now(), text, ...(taskId ? { taskId } : null) };
    this.doc.decisions.push(decision);
    if (this.doc.decisions.length > MAX_DECISIONS) this.doc.decisions.shift();
    this.persist();
    return decision;
  }

  decisions(): readonly Decision[] {
    return this.doc.decisions;
  }

  // ---- conversational focus + check-in ------------------------------------

  /** What the conversation has been about, oldest first. Empty for an old file. */
  focusRefs(): readonly FocusRef[] {
    return this.doc.focus ?? [];
  }

  /** Replace the focus list, keeping the newest `MAX_FOCUS`. */
  setFocusRefs(refs: readonly FocusRef[]): void {
    const kept = refs.slice(-MAX_FOCUS).map((ref) => ({ ...ref }));
    this.doc.focus = kept;
    this.persist();
  }

  /** What the last opening check-in covered. Empty for an old file. */
  checkinState(): CheckinState {
    const state = this.doc.checkin ?? {};
    return { ...state, ...(state.daveSeen ? { daveSeen: { ...state.daveSeen } } : null) };
  }

  setCheckinState(state: CheckinState): void {
    this.doc.checkin = { ...state, ...(state.daveSeen ? { daveSeen: { ...state.daveSeen } } : null) };
    this.persist();
  }

  // ---- command journal -----------------------------------------------------

  /**
   * Record that a command is about to run. Call, then `await flush()`, then
   * execute: a crash after this point leaves a `pending` entry, which a retry
   * reads as "outcome unknown" rather than running the command a second time.
   */
  journalBegin(callId: string, name: string): JournalBegin {
    const existing = this.doc.journal[callId];
    if (existing) {
      return existing.status === "done"
        ? { status: "done", result: existing.result }
        : { status: "pending" };
    }
    this.doc.journal[callId] = { name, at: this.now(), status: "pending" };
    const ids = Object.keys(this.doc.journal);
    if (ids.length > MAX_JOURNAL) {
      for (const id of ids.slice(0, ids.length - MAX_JOURNAL)) delete this.doc.journal[id];
    }
    this.persist();
    return { status: "new" };
  }

  journalFinish(callId: string, result: unknown): void {
    const entry = this.doc.journal[callId];
    if (!entry) return;
    entry.status = "done";
    entry.result = result;
    this.persist();
  }
}
