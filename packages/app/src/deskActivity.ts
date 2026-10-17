/**
 * Conversations running at the computer that the daemon does not hold
 * (started in a terminal), as `desktop.activity` reports them. Folded into the
 * session list as `deskBusy`, never `busy`, so it cannot fight the turn
 * machinery. Pure and Expo-free so `bun test` can load it.
 */
import { agentSessionKey } from "./agentHistory";
import type { Provider, Session } from "./daemonTypes";

/** Mirrors `wire.DesktopSession`. */
export interface DeskEntry {
  providerId: string;
  agentSessionId: string;
  cwd: string;
  title?: string;
  state: "working" | "idle";
  updatedAt: number;
  tool?: string;
}

const MAX_ENTRIES = 64;

function readEntry(value: unknown): DeskEntry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.providerId !== "string" || !v.providerId) return undefined;
  if (typeof v.agentSessionId !== "string" || !v.agentSessionId) return undefined;
  if (typeof v.cwd !== "string") return undefined;
  if (v.state !== "working" && v.state !== "idle") return undefined;
  if (typeof v.updatedAt !== "number" || !Number.isFinite(v.updatedAt)) return undefined;
  const entry: DeskEntry = {
    providerId: v.providerId,
    agentSessionId: v.agentSessionId,
    cwd: v.cwd,
    state: v.state,
    updatedAt: v.updatedAt,
  };
  if (typeof v.title === "string" && v.title.trim()) entry.title = v.title.trim().slice(0, 200);
  if (typeof v.tool === "string" && v.tool) entry.tool = v.tool;
  return entry;
}

/** The entries of a `desktop.activity` frame; undefined for any other message. */
export function readDesktopActivity(message: unknown): DeskEntry[] | undefined {
  if (!message || typeof message !== "object") return undefined;
  const m = message as Record<string, unknown>;
  if (m.t !== "desktop.activity" || !Array.isArray(m.sessions)) return undefined;
  const out: DeskEntry[] = [];
  for (const raw of m.sessions.slice(0, MAX_ENTRIES)) {
    const entry = readEntry(raw);
    if (entry) out.push(entry);
  }
  return out;
}

const keyOf = (providerId: string, agentSessionId: string) =>
  `${providerId}\u0000${agentSessionId}`;

/**
 * Mark rows running at the computer, clear the rest. Unchanged rows keep their
 * identity and the same array comes back when nothing changed. A working entry
 * with no row becomes a history stub (as `mergeAgentSessions` builds them), so
 * a later probe dedupes against it on `agentSessionId`.
 */
export function applyDesktopActivity(
  sessions: Session[],
  providers: readonly Pick<Provider, "id">[],
  entries: readonly DeskEntry[],
  now: number,
): Session[] {
  const working = new Map<string, DeskEntry>();
  for (const e of entries)
    if (e.state === "working") working.set(keyOf(e.providerId, e.agentSessionId), e);

  let changed = false;
  const matched = new Set<string>();
  const next = sessions.map((s) => {
    const key = s.agentSessionId ? keyOf(s.providerId, s.agentSessionId) : undefined;
    const running = key !== undefined && working.has(key);
    if (running && key) matched.add(key);
    if (running === (s.deskBusy === true)) return s;
    changed = true;
    if (running) return { ...s, deskBusy: true };
    const { deskBusy: _dropped, ...rest } = s;
    return rest;
  });

  const known = new Set(providers.map((p) => p.id));
  const added: Session[] = [];
  for (const [key, e] of working) {
    if (matched.has(key) || !known.has(e.providerId)) continue;
    added.push({
      id: agentSessionKey(e.providerId, e.agentSessionId),
      providerId: e.providerId,
      title: e.title?.trim() || "Untitled conversation",
      startedAt: Number.isFinite(e.updatedAt) && e.updatedAt > 0 ? e.updatedAt : now,
      turns: [],
      configOptions: [],
      agentSessionId: e.agentSessionId,
      cwd: e.cwd,
      deskBusy: true,
    });
  }

  if (added.length === 0) return changed ? next : sessions;
  return [...next, ...added].sort((a, b) => b.startedAt - a.startedAt);
}
