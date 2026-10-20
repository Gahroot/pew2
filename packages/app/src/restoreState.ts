import type { Session, Status } from "./useDaemon";

export type RestoreTarget = Pick<Session, "id" | "providerId" | "agentSessionId" | "title" | "cwd">;
export function restoreTarget(session: Session): RestoreTarget {
  return { id: session.id, providerId: session.providerId, agentSessionId: session.agentSessionId, title: session.title, cwd: session.cwd };
}
export function matchesRestore(target: RestoreTarget | undefined, message: { providerId?: string; agentSessionId?: string }): boolean {
  // Older peers may omit either optional identity field. Never guess past a
  // field they did supply, particularly when two restores cross in flight.
  return !!target && (!message.providerId || message.providerId === target.providerId) &&
    (!message.agentSessionId || message.agentSessionId === target.agentSessionId);
}
/** `starting`: a goal just launched, its conversation not yet begun (never derived here; App sets it). */
export type RestorePresentation = "loading" | "reconnecting" | "starting" | "failed" | "empty" | undefined;
export function restorePresentation(target: RestoreTarget | undefined, loading: boolean, error: string | undefined, count: number, status: Status): RestorePresentation {
  if (!target) return undefined;
  if (error) return "failed";
  if (count > 0) return undefined;
  if (loading) return status === "online" ? "loading" : "reconnecting";
  return "empty";
}

/** How long the loader waits before it shows at all (`ConversationRestore`). */
export const RESTORE_GRACE_MS = 250;
export interface RestoreReveal {
  /** Hold the transcript at opacity 0 until its first layout, then dissolve it in. */
  holdList: boolean;
  /** The loader was on screen: fade it out over the arriving transcript. */
  fadeLoader: boolean;
}
/**
 * The hand-over from "Reopening" to the conversation, decided when the first
 * batch lands. `loadingSince` is when the empty restore began (undefined: this
 * batch is not a restore, e.g. a live first prompt, which animates per row).
 * A load faster than the grace never showed the loader, so only the list moves.
 */
export function restoreReveal(batch: number, loadingSince: number | undefined, now: number): RestoreReveal {
  // Every opening reveals as one beat, a cached one too: it used to cut in
  // whenever the loader never got to show, which read as abrupt.
  if (batch <= 0) return { holdList: false, fadeLoader: false };
  return { holdList: true, fadeLoader: loadingSince !== undefined && now - loadingSince >= RESTORE_GRACE_MS };
}

/** How long a conversation takes to come in when opened: unhurried, not snappy. */
export const OPEN_REVEAL_MS = 560;
/** It rises this far (pt) as it comes in, settling into place. */
export const OPEN_REVEAL_RISE = 14;
/** Pew "unlocks" the conversation: a short beat of celebration where he waited… */
export const UNLOCK_BEAT_MS = 220;
/** …then he swells and dissolves while the conversation (already rising in) settles. */
export const UNLOCK_EXIT_MS = 380;
