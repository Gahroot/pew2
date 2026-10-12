/**
 * Which events are worth interrupting for, and how to group the rest.
 *
 * Urgent (approval, blocked, and failures, which block the user) go out at once.
 * Everything else is held for a debounce window and coalesced per task, so ten
 * tool calls become one line instead of ten push notifications.
 */
import type { EventClass, VoiceEvent } from "./types.js";

export type EventKind = VoiceEvent["kind"];

export function classifyKind(kind: EventKind): EventClass {
  switch (kind) {
    case "task.approval":
      return "approval";
    case "task.blocked":
    case "task.failed":
      return "blocked";
    case "task.completed":
      return "completed";
    default:
      return "informational";
  }
}

export function isUrgent(cls: EventClass): boolean {
  return cls === "approval" || cls === "blocked";
}

export interface BatchOptions {
  /** Hold time for informational updates. */
  informationalMs: number;
  /** Short hold for completions, so a quick follow-on event folds into one line. */
  completedMs: number;
}

export const DEFAULT_BATCH: BatchOptions = { informationalMs: 30_000, completedMs: 4_000 };

interface Held {
  event: VoiceEvent;
  dueAt: number;
}

/**
 * Debounce + coalesce, clock passed in.
 *
 * `add` returns what to deliver now (urgent events, plus any held updates for
 * the same task, so the user never hears a blocker without its context ordered
 * before it). `due` returns whatever has aged out. Per task only the latest
 * held event survives, and a later one never moves an earlier deadline.
 */
export class EventBatcher {
  private readonly held = new Map<string, Held>();

  constructor(private readonly options: BatchOptions = DEFAULT_BATCH) {}

  add(event: VoiceEvent, now: number): VoiceEvent[] {
    if (isUrgent(event.class)) {
      this.held.delete(event.taskId);
      return [event];
    }
    const wait = event.class === "completed" ? this.options.completedMs : this.options.informationalMs;
    const existing = this.held.get(event.taskId);
    // A completion is never replaced by a later chatter event.
    if (existing?.event.class === "completed" && event.class === "informational") return [];
    this.held.set(event.taskId, {
      event,
      dueAt: existing ? Math.min(existing.dueAt, now + wait) : now + wait,
    });
    return [];
  }

  due(now: number): VoiceEvent[] {
    const ready: Held[] = [];
    for (const [taskId, entry] of this.held) {
      if (entry.dueAt <= now) {
        ready.push(entry);
        this.held.delete(taskId);
      }
    }
    return ready.sort((a, b) => a.event.eventId - b.event.eventId).map((e) => e.event);
  }

  /** Drop held updates for a task, e.g. because the user is already talking about it. */
  discard(taskId: string): void {
    this.held.delete(taskId);
  }

  get pending(): number {
    return this.held.size;
  }
}

/**
 * Collapse a run of events to what is worth saying: the latest per task, with
 * urgent ones kept in full, ordered by id. Used for "what did I miss".
 */
export function coalesce(events: readonly VoiceEvent[], max = 8): VoiceEvent[] {
  const latest = new Map<string, VoiceEvent>();
  const urgent: VoiceEvent[] = [];
  for (const event of events) {
    if (isUrgent(event.class)) urgent.push(event);
    const prior = latest.get(event.taskId);
    if (!prior || prior.class !== "completed" || event.class !== "informational") {
      latest.set(event.taskId, event);
    }
  }
  const byId = new Map<number, VoiceEvent>();
  for (const e of [...latest.values(), ...urgent]) byId.set(e.eventId, e);
  const merged = [...byId.values()].sort((a, b) => a.eventId - b.eventId);
  return merged.slice(-max);
}

/** Events the user has not heard, given the highest id they did. */
export function unheard(events: readonly VoiceEvent[], heardEventId: number): VoiceEvent[] {
  return events.filter((e) => e.eventId > heardEventId);
}
