/**
 * What Pew is told mid-call about a session it is watching (`voice.note`).
 * Pure, so the wording is tested; plain text, since Pew speaks it.
 */
import type { BoardSource } from "./board.js";
import { lastAgentLines } from "./replies.js";

/** How a session is named to Pew: its folder, and the agent when known. */
export function sessionName(source: { folder?: string; agentName?: string }): string {
  const folder = source.folder ?? "a session";
  return source.agentName && source.agentName !== folder ? `${folder} (${source.agentName})` : folder;
}

/**
 * A turn started or ended. A finished turn carries the agent's reply (its
 * last lines) and is spoken at the next pause, unless the session is now
 * waiting on the user: that arrives as its own new item, which Pew brings up.
 */
export function turnNote(
  source: Pick<BoardSource, "folder" | "agentName" | "events">,
  working: boolean,
  waitingOnUser: boolean,
): { text: string; speak?: boolean; about: string } {
  const name = sessionName(source);
  const about = source.folder ?? name;
  if (working) return { text: `${name} started working.`, about };
  const said = lastAgentLines(source.events, 8).join(" ").slice(0, 1200);
  const reply = said ? ` Its reply: ${said}` : " It said nothing.";
  if (waitingOnUser) return { text: `${name} finished its turn and is waiting on them.${reply}`, about };
  return {
    about,
    text: `${name} finished its turn.${reply} Tell them at the next pause, in a sentence or two: the outcome, not the details.`,
    speak: true,
  };
}
