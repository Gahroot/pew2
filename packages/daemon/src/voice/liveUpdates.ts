/**
 * Live news about voice tasks for a call in progress.
 *
 * The Realtime model only knows its briefing and what its tools return, so a
 * task that finishes mid-call would be announced nowhere. The service turns
 * the events worth interrupting for into a `voice.note`, which the phone adds
 * to the conversation and Pew says at the next pause.
 *
 * Pure, so the wording is tested.
 */
import { placeSpoken } from "./place.js";
import type { VoiceEvent, VoiceTask } from "./types.js";

/** The note for one event. Ids are for tool calls; the instructions say never to speak them. */
export function liveUpdateNote(event: VoiceEvent, task?: VoiceTask): string {
  // The repository, with any branch as a detail: work on a branch is that project's work.
  const lines = [`[Update] ${placeSpoken(event)} (taskId ${event.taskId}): ${event.text}`];
  if (event.class === "completed" && task?.debrief) {
    lines.push(`Debrief: ${JSON.stringify(task.debrief)}`);
  }
  if (event.class === "approval") {
    lines.push("Call list_waiting and ask about it. If nothing is waiting any more, say nothing.");
  } else {
    lines.push("Tell the user at the next pause, briefly. If you already told them this, say nothing.");
  }
  return lines.join("\n");
}
