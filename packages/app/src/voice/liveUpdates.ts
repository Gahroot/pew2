/**
 * Live news for an open voice conversation.
 *
 * The Realtime model only knows what it was told at `voice.open` and what its
 * tools return, so a task that finishes mid-call was announced nowhere: the
 * daemon skips the push ("the user is hearing it") and the model never heard
 * it. This turns a `voice.event` into a system note for the conversation —
 * LiveKit's async-tool pattern — and decides which events earn one.
 *
 * Pure: no Expo, so `bun test` can load it.
 */
import type { VoiceEvent, VoiceTask } from "./types";

/** Chatter (tool steps, queued, started) is never worth speaking over the user. */
const ANNOUNCED: ReadonlySet<VoiceEvent["class"]> = new Set(["completed", "blocked", "approval"]);

export interface AnnounceState {
  /** Highest eventId the model already has, from the opening snapshot. */
  since: number;
  /** Events already turned into a note this conversation. */
  sent: ReadonlySet<number>;
}

export function shouldAnnounce(event: VoiceEvent, state: AnnounceState): boolean {
  return ANNOUNCED.has(event.class) && event.eventId > state.since && !state.sent.has(event.eventId);
}

/** The system note for one event. Ids are for tool calls; the rules say never to speak them. */
export function liveUpdateNote(event: VoiceEvent, task?: VoiceTask): string {
  const lines = [`[Update] ${event.projectName} (taskId ${event.taskId}): ${event.text}`];
  if (event.class === "completed" && task?.debrief) {
    lines.push(`Debrief: ${JSON.stringify(task.debrief)}`);
  }
  if (event.class === "approval") {
    lines.push("Call pending_approvals and ask about it. If nothing is pending any more, say nothing.");
  } else {
    lines.push("Tell the user now, briefly. If you already told them this, say nothing.");
  }
  return lines.join("\n");
}
