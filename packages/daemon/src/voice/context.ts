/**
 * The compact picture a fresh Realtime session starts with.
 *
 * Small on purpose: the model gets what it needs to say the first sentence, and
 * pulls detail through tools. No transcripts, no source, no paths.
 */
import { coalesce, unheard } from "./classify.js";
import { toVoiceTask, TERMINAL, type StoredTask } from "./store.js";
import { placeSpoken } from "./place.js";
import type { TaskState, VoiceEvent, VoiceProject, VoiceSnapshot } from "./types.js";

export interface SnapshotInput {
  projects: readonly VoiceProject[];
  tasks: readonly StoredTask[];
  events: readonly VoiceEvent[];
  lastEventId: number;
  heardEventId: number;
  source?: string;
  focusTaskId?: string;
  focusEvent?: VoiceEvent;
}

const MAX_PROJECTS = 12;
const MAX_FINISHED = 4;

const SOURCE_LINES: Record<string, string> = {
  airpods: "Opened from AirPods.",
  action_button: "Opened from the Action Button.",
  siri_shortcut: "Opened from Siri.",
  in_app: "Opened in the app.",
  lock_screen: "Opened from the Lock Screen.",
};

/** One sentence on why this session exists. */
export function openingLine(input: SnapshotInput): string {
  if (input.focusEvent) {
    return `Opened from a notification: ${placeSpoken(input.focusEvent)}: ${input.focusEvent.text}`;
  }
  const base = SOURCE_LINES[input.source ?? ""] ?? "Opened from a notification.";
  const focus = input.focusTaskId ? input.tasks.find((t) => t.taskId === input.focusTaskId) : undefined;
  return focus ? `${base} Focus: ${placeSpoken(focus)}, ${focus.title} (${focus.state}).` : base;
}

export function buildSnapshot(input: SnapshotInput): VoiceSnapshot {
  const active = input.tasks.filter((t) => !TERMINAL.has(t.state));
  const finished = input.tasks.filter((t) => TERMINAL.has(t.state)).slice(0, MAX_FINISHED);
  // Projects with live work first, then repositories. An idle worktree is
  // left out entirely: it is a branch of a repo already listed, ezcoder makes
  // one per task, and a dozen `ez-…` checkouts would crowd every repo the user
  // can name out of a capped list. `list_projects` still names its branches.
  const busy = new Set(active.map((t) => t.projectId));
  const projects = [
    ...input.projects.filter((p) => busy.has(p.projectId)),
    ...input.projects.filter((p) => !busy.has(p.projectId) && !p.worktree),
  ].slice(0, MAX_PROJECTS);
  const focus = input.focusTaskId
    ? input.tasks.filter((t) => t.taskId === input.focusTaskId && !active.includes(t) && !finished.includes(t))
    : [];

  return {
    eventId: input.lastEventId,
    projects: projects.map((p) => ({
      projectId: p.projectId,
      name: p.name,
      path: "",
      aliases: p.aliases.slice(0, 4),
      ...(p.providerId ? { providerId: p.providerId } : null),
      ...(p.worktree ? { worktree: p.worktree } : null),
    })),
    tasks: [...active, ...finished, ...focus].map(toVoiceTask),
    unheard: coalesce(unheard(input.events, input.heardEventId)),
    opening: openingLine(input),
  };
}

/** Count of tasks per state, for one-line summaries. */
export function stateCounts(tasks: readonly StoredTask[]): Partial<Record<TaskState, number>> {
  const counts: Partial<Record<TaskState, number>> = {};
  for (const t of tasks) counts[t.state] = (counts[t.state] ?? 0) + 1;
  return counts;
}
