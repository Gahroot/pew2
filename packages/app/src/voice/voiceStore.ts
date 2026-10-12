/**
 * The task list the voice sheet shows, folded from what the daemon broadcasts.
 *
 * One stream drives both the screen and the voice model: `voice.event` (live),
 * `voice.state` (catch-up + snapshot) and, leniently, the `task` a tool result
 * may carry. The daemon's `eventId` is gapless and persisted, so:
 *  - an event at or below the cursor is a replay and is dropped (dedupe);
 *  - an event that skips ahead means a missed one, and asks for `voice.sync`;
 *  - a snapshot whose id is *below* the cursor means the daemon's history was
 *    reset, so the cursor follows it down rather than ignoring everything.
 *
 * Pure. The cursor is persisted by `preferences.ts`; the encoding is here.
 */
import { VoiceTaskSchema, type VoiceEvent, type VoiceSnapshot, type VoiceTask } from "./types";

/** Events kept for the "recent activity" list. */
export const RECENT_LIMIT = 30;

export interface VoiceStore {
  /** Highest eventId folded in. */
  cursor: number;
  tasks: Record<string, VoiceTask>;
  /** Newest last. */
  recent: VoiceEvent[];
  /** Set when an event skipped ahead; cleared by the next state/snapshot. */
  needsSync: boolean;
  /** Highest eventId the user was shown or told about while a sheet/session was open. */
  heardEventId: number;
}

export const emptyStore: VoiceStore = {
  cursor: 0,
  tasks: {},
  recent: [],
  needsSync: false,
  heardEventId: 0,
};

export type StoreAction =
  | { type: "event"; event: VoiceEvent; task?: VoiceTask }
  | { type: "state"; snapshot: VoiceSnapshot; events: VoiceEvent[] }
  | { type: "toolResult"; output: unknown }
  | { type: "heard"; eventId: number }
  | { type: "restore"; cursor: number; heardEventId?: number }
  | { type: "clear" };

function pushRecent(recent: VoiceEvent[], event: VoiceEvent): VoiceEvent[] {
  if (recent.some((e) => e.eventId === event.eventId)) return recent;
  const next = [...recent, event].sort((a, b) => a.eventId - b.eventId);
  return next.length > RECENT_LIMIT ? next.slice(next.length - RECENT_LIMIT) : next;
}

/** Newer `updatedAt` wins, so an out-of-order result never regresses a task. */
function putTask(tasks: Record<string, VoiceTask>, task: VoiceTask): Record<string, VoiceTask> {
  const existing = tasks[task.taskId];
  if (existing && existing.updatedAt > task.updatedAt) return tasks;
  return { ...tasks, [task.taskId]: task };
}

/**
 * A tool result is opaque to the app. If it happens to carry full tasks
 * (`{task}` or `{tasks: []}`) they are shown; anything else is ignored. This
 * never branches on a tool's name.
 */
export function tasksFromOutput(output: unknown): VoiceTask[] {
  if (typeof output !== "object" || output === null) return [];
  const record = output as Record<string, unknown>;
  const candidates = [record.task, ...(Array.isArray(record.tasks) ? record.tasks : [])];
  const out: VoiceTask[] = [];
  for (const candidate of candidates) {
    const parsed = VoiceTaskSchema.safeParse(candidate);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

export function reduce(store: VoiceStore, action: StoreAction): VoiceStore {
  switch (action.type) {
    case "event": {
      const { event, task } = action;
      if (event.eventId <= store.cursor) return store; // replay
      return {
        ...store,
        cursor: event.eventId,
        tasks: task ? putTask(store.tasks, task) : store.tasks,
        recent: pushRecent(store.recent, event),
        needsSync: store.needsSync || (store.cursor > 0 && event.eventId > store.cursor + 1),
      };
    }
    case "state": {
      const { snapshot, events } = action;
      const tasks: Record<string, VoiceTask> = {};
      for (const task of snapshot.tasks) tasks[task.taskId] = task;
      let recent = store.recent;
      for (const event of [...snapshot.unheard, ...events]) recent = pushRecent(recent, event);
      const top = Math.max(snapshot.eventId, ...events.map((e) => e.eventId));
      return {
        ...store,
        // Follows the daemon down as well as up (a reset history).
        cursor: top,
        tasks,
        recent: top < store.cursor ? recent.filter((e) => e.eventId <= top) : recent,
        needsSync: false,
        heardEventId: Math.min(store.heardEventId, top),
      };
    }
    case "toolResult": {
      let tasks = store.tasks;
      for (const task of tasksFromOutput(action.output)) tasks = putTask(tasks, task);
      return tasks === store.tasks ? store : { ...store, tasks };
    }
    case "heard":
      return action.eventId > store.heardEventId ? { ...store, heardEventId: action.eventId } : store;
    case "restore":
      return {
        ...store,
        cursor: Math.max(store.cursor, action.cursor),
        heardEventId: Math.max(store.heardEventId, action.heardEventId ?? 0),
      };
    case "clear":
      return emptyStore;
  }
}

// ---- views -----------------------------------------------------------------

const OPEN_STATES = new Set(["queued", "running", "paused", "blocked"]);

/** Tasks to show: blocked first, then running, queued, paused, then the finished ones newest first. */
export function orderedTasks(store: VoiceStore): VoiceTask[] {
  const rank = (t: VoiceTask) =>
    t.approval ? 0 : t.state === "blocked" ? 1 : t.state === "running" ? 2 : t.state === "queued" ? 3 : t.state === "paused" ? 4 : 5;
  return Object.values(store.tasks).sort(
    (a, b) => rank(a) - rank(b) || b.priority - a.priority || b.updatedAt - a.updatedAt || a.taskId.localeCompare(b.taskId),
  );
}

export function openTaskCount(store: VoiceStore): number {
  return Object.values(store.tasks).filter((t) => OPEN_STATES.has(t.state)).length;
}

export function pendingApprovals(store: VoiceStore): VoiceTask[] {
  return orderedTasks(store).filter((t) => t.approval !== undefined);
}

// ---- persistence -------------------------------------------------------------

export interface PersistedCursor {
  cursor: number;
  heardEventId: number;
}

export function encodeCursor(store: Pick<VoiceStore, "cursor" | "heardEventId">): string {
  return JSON.stringify({ cursor: store.cursor, heardEventId: store.heardEventId });
}

/** Anything unreadable is "no cursor": the daemon then sends everything it holds. */
export function decodeCursor(raw: string | null | undefined): PersistedCursor {
  const none = { cursor: 0, heardEventId: 0 };
  if (!raw) return none;
  try {
    const value = JSON.parse(raw) as Partial<PersistedCursor> | null;
    const ok = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0;
    return {
      cursor: ok(value?.cursor) ? value.cursor : 0,
      heardEventId: ok(value?.heardEventId) ? value.heardEventId : 0,
    };
  } catch {
    return none;
  }
}
