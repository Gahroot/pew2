/**
 * The one rule for how a conversation reads at a glance, shared by the sidebar's
 * animation and the voice dashboard so the two cannot disagree: blocked on you
 * beats working beats an unread reply. Pure; the daemon's `runningSessions()`
 * applies the same ranking from the same `working`/`permissions` flags.
 */
export type Mark = "live" | "attention" | "unread" | undefined;

export function sessionMark(row: { busy?: boolean; deskBusy?: boolean; unread?: boolean; permission?: unknown }): Mark {
  if (row.permission) return "attention";
  if (row.busy || row.deskBusy) return "live";
  if (row.unread) return "unread";
  return undefined;
}
