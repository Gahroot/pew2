/**
 * Whether the agent just finished a turn on screen: the moment for the "done"
 * chime and buzz. Pure, so the rule is tested under `bun test`.
 *
 * `busy` going false is not enough. It also goes false when:
 *  - a conversation is opened: it is busy while its history loads, then idle
 *    (reopening a chat chimed every time);
 *  - you switch away from a conversation that was working to one that isn't.
 * Neither is a reply arriving, so neither may chime.
 */
export interface TurnFrame {
  busy: boolean;
  /** The conversation on screen. */
  sessionId: string | undefined;
  /** Its history is still loading (a resume or a reopen). */
  loading: boolean;
}

export function turnFinished(before: TurnFrame | undefined, now: TurnFrame): boolean {
  if (!before?.busy || now.busy) return false;
  if (before.sessionId !== now.sessionId) return false;
  // Busy only because it was loading: the history arriving, not a reply.
  if (before.loading) return false;
  return true;
}
