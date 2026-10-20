/**
 * One inbox for the whole machine: every open approval, question and pending
 * plan across every session, oldest first.
 *
 * Built from live session state (the same maps catch-up reads), never from the
 * log. `since` is stamped the first time an item is seen, which is the moment
 * it was registered: the daemon touches the inbox right after each one.
 */
import { wire } from "@pew2/protocol";

/** What the inbox reads off one live session. */
export interface InboxSource {
  sessionId: string;
  folder?: string;
  agentName?: string;
  permissions?: ReadonlyMap<string, unknown>;
  asks?: ReadonlyMap<string, unknown[]>;
  plan?: wire.PlanState;
}

export const itemId = (sessionId: string, kind: wire.VoiceInboxItem["kind"], requestId: string) =>
  `${sessionId}:${kind}:${requestId}`;

const oneLine = (text: string, max = 160) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

export function permissionTitle(params: unknown): string {
  const title = (params as { toolCall?: { title?: unknown } } | null)?.toolCall?.title;
  return typeof title === "string" && title.trim() ? oneLine(title) : "Approve a tool";
}

/** An approval's choices, named, for the call screen's card. Unnamed or malformed ones are dropped. */
export function approvalChoices(params: unknown): NonNullable<wire.VoiceInboxItem["options"]> {
  const raw = (params as { options?: unknown } | null)?.options;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((option) => {
    const typed = option as { optionId?: unknown; kind?: unknown; name?: unknown } | null;
    if (typeof typed?.optionId !== "string" || typeof typed.name !== "string" || !typed.name.trim()) return [];
    return [{ optionId: typed.optionId, name: typed.name, ...(typeof typed.kind === "string" ? { kind: typed.kind } : {}) }];
  });
}

/** An approval's whole request text, uncapped, for the card (the title is one capped line). */
export function permissionDetail(params: unknown): string | undefined {
  const title = (params as { toolCall?: { title?: unknown } } | null)?.toolCall?.title;
  return typeof title === "string" && title.trim() ? title.trim() : undefined;
}

/** The questions the card can draw: each one checked against the wire schema, the rest dropped. */
export function cardQuestions(questions: unknown[]): wire.AskQuestion[] {
  return questions.flatMap((question) => {
    const parsed = wire.AskQuestion.safeParse(question);
    return parsed.success ? [parsed.data] : [];
  });
}

export function questionTitle(questions: unknown[]): string {
  const first = (questions[0] as { question?: unknown } | undefined)?.question;
  return typeof first === "string" && first.trim() ? oneLine(first) : "A question for you";
}

/**
 * The inbox, oldest first. `firstSeen` is read and updated in place, and
 * pruned of items that are gone.
 */
export function buildInbox(
  sources: Iterable<InboxSource>,
  firstSeen: Map<string, number>,
  now: number,
): wire.VoiceInboxItem[] {
  const items: wire.VoiceInboxItem[] = [];
  const add = (
    source: InboxSource,
    kind: wire.VoiceInboxItem["kind"],
    requestId: string,
    title: string,
    card: Pick<wire.VoiceInboxItem, "questions" | "options" | "detail"> = {},
  ) => {
    const id = itemId(source.sessionId, kind, requestId);
    let since = firstSeen.get(id);
    if (since === undefined) {
      since = now;
      firstSeen.set(id, since);
    }
    items.push({
      id,
      sessionId: source.sessionId,
      kind,
      requestId,
      ...(source.folder ? { folder: source.folder } : {}),
      ...(source.agentName ? { agentName: source.agentName } : {}),
      title,
      since,
      ...card,
    });
  };
  for (const source of sources) {
    for (const [requestId, params] of source.permissions ?? []) {
      const options = approvalChoices(params);
      const detail = permissionDetail(params);
      add(source, "approval", requestId, permissionTitle(params), {
        ...(options.length > 0 ? { options } : {}),
        ...(detail ? { detail } : {}),
      });
    }
    for (const [requestId, questions] of source.asks ?? []) {
      const card = cardQuestions(questions);
      add(source, "question", requestId, questionTitle(questions), card.length > 0 ? { questions: card } : {});
    }
    const pending = source.plan?.pending;
    if (pending) add(source, "plan", String(pending.generation), "Plan ready for review");
  }
  const present = new Set(items.map((item) => item.id));
  for (const id of [...firstSeen.keys()]) if (!present.has(id)) firstSeen.delete(id);
  return items.sort((a, b) => a.since - b.since || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Stable identity of an inbox, to broadcast only when it really changed. */
export function inboxSignature(items: readonly wire.VoiceInboxItem[]): string {
  return items.map((item) => `${item.id}\u0000${item.title}`).join("\u0001");
}

/** One spoken line per item, for the briefing and the push body. */
export function describeItem(item: wire.VoiceInboxItem): string {
  const where = item.folder ?? item.agentName ?? "an agent";
  switch (item.kind) {
    case "approval":
      return `${where} wants to run: ${item.title}`;
    case "question":
      return `${where} asks: ${item.title}`;
    case "plan":
      return `${where} has a plan ready for review`;
  }
}

/** "3 things waiting: pew2 wants to run: npm test; …" */
/**
 * Who a ring is about, for the lock screen: the one project waiting
 * ("billing"), or the first plus how many more ("billing +2"). Oldest first,
 * the order a call leads with. Undefined when nothing names a project.
 */
export function ringWho(items: readonly wire.VoiceInboxItem[]): string | undefined {
  const names: string[] = [];
  for (const item of [...items].sort((a, b) => a.since - b.since)) {
    const name = item.folder ?? item.agentName;
    if (name && !names.includes(name)) names.push(name);
  }
  if (names.length === 0) return undefined;
  const first = names[0]!.length > 24 ? `${names[0]!.slice(0, 23)}…` : names[0]!;
  return names.length === 1 ? first : `${first} +${names.length - 1}`;
}

export function summariseInbox(items: readonly wire.VoiceInboxItem[], max = 3): string {
  if (items.length === 0) return "Nothing waiting.";
  const head = items.length === 1 ? "1 thing waiting" : `${items.length} things waiting`;
  const shown = items.slice(0, max).map(describeItem).join("; ");
  const more = items.length > max ? `; and ${items.length - max} more` : "";
  return `${head}: ${shown}${more}`;
}
