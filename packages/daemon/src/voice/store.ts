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
import type { TaskState, VoiceEvent, VoiceTask } from "./types.js";
import { writeFileAtomic } from "../atomic-file.js";
import { classifyKind, type EventKind } from "./classify.js";

export interface HistoryEntry {
  at: number;
  state: TaskState;
  note?: string;
}

export interface StoredTask {
  taskId: string;
  projectId: string;
  projectName: string;
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
  error?: string;
  /** Ended because the daemon restarted, not because the agent finished or failed. */
  interrupted?: boolean;
  /** Start by prompting the existing session instead of opening a new one. */
  resume?: boolean;
  attempts: number;
  maxAttempts: number;
  history: HistoryEntry[];
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
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
}

export const MAX_EVENTS = 2000;
export const MAX_JOURNAL = 500;
export const MAX_DECISIONS = 100;
const MAX_HISTORY = 50;

/** Task states that no longer need a worker. */
export const TERMINAL: ReadonlySet<TaskState> = new Set(["failed", "completed", "verified", "cancelled"]);
/** Task states that hold a project's worktree lock (unless read-only). */
export const ACTIVE: ReadonlySet<TaskState> = new Set(["running", "blocked"]);
/** A dependency is met once the agent said it finished. */
const DEP_MET: ReadonlySet<TaskState> = new Set(["completed", "verified"]);

export type Listener = (event: VoiceEvent, task: StoredTask) => void;

export interface NewTask {
  projectId: string;
  projectName: string;
  cwd: string;
  providerId: string;
  title: string;
  prompt: string;
  priority?: number;
  readOnly?: boolean;
  dependsOn?: string[];
  maxAttempts?: number;
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
  };
}

export function toVoiceTask(task: StoredTask): VoiceTask {
  return {
    taskId: task.taskId,
    projectId: task.projectId,
    projectName: task.projectName,
    ...(task.sessionId ? { sessionId: task.sessionId } : null),
    title: task.title,
    state: task.state,
    priority: task.priority,
    ...(task.activity ? { activity: task.activity } : null),
    ...(task.approval ? { approval: task.approval } : null),
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
      cwd: input.cwd,
      providerId: input.providerId,
      title: input.title,
      prompt: input.prompt,
      state: "queued",
      priority: input.priority ?? 0,
      readOnly: input.readOnly ?? false,
      dependsOn: [...(input.dependsOn ?? [])],
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
  ): { event: VoiceEvent; task: StoredTask } | undefined {
    const task = this.doc.tasks[taskId];
    if (!task) return undefined;
    const now = this.now();
    Object.assign(task, patch);
    if (task.state !== state) {
      task.state = state;
      task.history.push({ at: now, state, note: text.slice(0, 160) });
      if (task.history.length > MAX_HISTORY) task.history.splice(0, task.history.length - MAX_HISTORY);
    }
    if (TERMINAL.has(state) || state === "paused" || state === "queued") delete task.approval;
    task.updatedAt = now;
    const event = this.emit(task, kind, text);
    return { event, task };
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

  private emit(task: StoredTask, kind: EventKind, text: string): VoiceEvent {
    const event: VoiceEvent = {
      eventId: this.doc.nextEventId++,
      taskId: task.taskId,
      projectId: task.projectId,
      projectName: task.projectName,
      kind,
      class: classifyKind(kind),
      text,
      at: this.now(),
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
