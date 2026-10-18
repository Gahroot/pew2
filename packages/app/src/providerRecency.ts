/**
 * Ordering the drawer's app chips by last use.
 *
 * The chip row scrolls horizontally, so the app you reach for daily should not
 * be off-screen behind apps you tried once. "Used" means conversation activity:
 * a provider's recency is its newest session, and sessions from an agent's own
 * history carry the agent's `updatedAt`, so desk work counts the same as phone
 * work.
 *
 * Pure and React-free so the ordering rules are directly testable.
 */

interface ProviderLike {
  id: string;
  available: boolean;
}

interface SessionLike {
  providerId: string;
  startedAt: number;
}

/**
 * GG's own agents lead the row, always and in this order, whatever was used
 * last and even while unavailable — the user's call: they are the home team,
 * the rest are guests.
 */
export const PINNED_PROVIDERS = ["ggcoder", "gg-goals"] as const;

/**
 * The pinned agents first (see `PINNED_PROVIDERS`), then: available and used,
 * most recent activity leading; available but never used, in their original
 * order; unavailable last regardless of history — a chip you cannot open is
 * never worth prime positions.
 */
export function orderProvidersByRecency<P extends ProviderLike>(
  providers: readonly P[],
  sessions: readonly SessionLike[],
): P[] {
  const pinned = PINNED_PROVIDERS.flatMap((id) => providers.filter((p) => p.id === id));
  const rest = providers.filter((p) => !(PINNED_PROVIDERS as readonly string[]).includes(p.id));
  return goalsBesideAgents([...pinned, ...orderRest(rest, sessions)]);
}

/** Each goals provider and the agent it is synthesised from. */
const GOALS_AGENTS: Readonly<Record<string, string>> = {
  "gg-goals": "ggcoder",
  "ez-goals": "ezcoder",
};

/**
 * A goals provider immediately follows its agent wherever that agent landed
 * (EZ Goals right after EZ Coder); with its agent absent it keeps its place.
 */
function goalsBesideAgents<P extends ProviderLike>(ordered: readonly P[]): P[] {
  const present = new Set(ordered.map((p) => p.id));
  const follows = (p: P): boolean => {
    const agent = GOALS_AGENTS[p.id];
    return agent !== undefined && present.has(agent);
  };
  const out: P[] = [];
  for (const provider of ordered) {
    if (follows(provider)) continue;
    out.push(provider);
    for (const goals of ordered) {
      if (GOALS_AGENTS[goals.id] === provider.id) out.push(goals);
    }
  }
  return out;
}

function orderRest<P extends ProviderLike>(
  providers: readonly P[],
  sessions: readonly SessionLike[],
): P[] {
  const lastUsed = new Map<string, number>();
  for (const session of sessions) {
    lastUsed.set(
      session.providerId,
      Math.max(lastUsed.get(session.providerId) ?? 0, session.startedAt),
    );
  }

  const rank = (provider: P): number => {
    if (!provider.available) return 2;
    return lastUsed.has(provider.id) ? 0 : 1;
  };

  // `sort` is stable, so providers within a group keep their manifest order.
  return [...providers].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    if (ra === 0) return (lastUsed.get(b.id) ?? 0) - (lastUsed.get(a.id) ?? 0);
    return 0;
  });
}
