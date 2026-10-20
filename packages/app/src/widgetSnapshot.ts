/**
 * What the home and Lock Screen widgets show, and the links they open.
 *
 * Three widgets read one snapshot: Recent (the last conversations, to jump
 * back into), Agents (what is waiting on you, working, or new) and New chat
 * (a button).
 *
 * Pure and Expo-free (tested under bun); `ui/useHomeWidget.ts` writes it to
 * the App Group, and the widget itself is `targets/widget/*.swift`. The JSON
 * shape is a contract with that Swift (`targets/_shared/PewSnapshot.swift`),
 * and the notification service extension edits it in place when a push lands
 * while this app is asleep, so a field renamed here has to be renamed there.
 *
 * Deliberately no "connected" flag. The app is suspended seconds after it
 * leaves the screen, so the last thing it wrote would claim "online" for
 * hours. The widget says when it was last told anything instead.
 */

/**
 * The App Group both the app and the widget extension are entitled to:
 * `group.` + the app's bundle id, the rule `app.config.js` signs with. A fork
 * builds under its own id, and an App Group belongs to one Apple team, so a
 * fixed upstream name here would point the app at a group it is not entitled
 * to and the widget would never update. Undefined without a bundle id.
 */
export function widgetAppGroup(bundleId: string | null | undefined): string | undefined {
  return bundleId ? `group.${bundleId}` : undefined;
}

/** The key the snapshot is stored under, as a JSON string. */
export const WIDGET_KEY = "pew2.snapshot";

/** The most conversations any widget size shows (the large one). */
export const WIDGET_ROWS = 7;

/** How long a title is kept: a widget row is one line, and this is the store, not the layout. */
const TITLE_MAX = 80;

/**
 * What a conversation is doing, most urgent first.
 *
 * - `waiting`: stopped on an approval or a question from you.
 * - `working`: the agent is mid-turn.
 * - `unread`: a turn finished here and you have not opened it.
 * - `idle`: nothing new.
 */
export type WidgetState = "waiting" | "working" | "unread" | "idle";

const RANK: Record<WidgetState, number> = { waiting: 0, working: 1, unread: 2, idle: 3 };

export interface WidgetRow {
  id: string;
  title: string;
  /** Project folder, e.g. "pew2". */
  project?: string;
  /** The agent's display name. */
  agent?: string;
  /** The agent's colour, `#rrggbb`, for the working mark. */
  color?: string;
  state: WidgetState;
  /** Last activity, ms since the epoch: the time the drawer shows beside it. */
  at?: number;
}

export interface WidgetSnapshot {
  v: 1;
  /** The desktop this phone is paired with. */
  machine?: string;
  /** Conversations stopped on an answer, across every conversation (not just `rows`). */
  waiting: number;
  /** Conversations mid-turn, across every conversation. */
  working: number;
  /** For the Agents widget: most urgent first. */
  rows: WidgetRow[];
  /** For the Recent widget: most recently active first, whatever their state. */
  recent: WidgetRow[];
  /** When this was written, in ms since the epoch. */
  at: number;
}

/**
 * What the widget draws, before it is written. `at` is stamped at the write
 * (`useHomeWidget`), because that is the moment it describes, and because a
 * clock read while rendering would make the snapshot differ on every render.
 */
export type WidgetContent = Omit<WidgetSnapshot, "at">;

export interface WidgetInput {
  sessions: readonly {
    id: string;
    providerId: string;
    title: string;
    startedAt?: number;
    folder?: string;
    cwd?: string;
    busy?: boolean;
    unread?: boolean;
    permission?: unknown;
  }[];
  /** Open questions per conversation (`ggState.asks`). */
  asks: Readonly<Record<string, readonly unknown[] | undefined>>;
  providers: readonly { id: string; name: string; color?: string }[];
  machine?: string;
}

function stateOf(session: WidgetInput["sessions"][number], asked: boolean): WidgetState {
  if (session.permission || asked) return "waiting";
  if (session.busy) return "working";
  if (session.unread) return "unread";
  return "idle";
}

function lastSegment(path: string | undefined): string | undefined {
  const segment = path?.split(/[\\/]/).filter(Boolean).pop();
  return segment || undefined;
}

function clip(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
}

/**
 * Every conversation as a widget row, in the app's list order (newest first),
 * unsliced. The home dashboard reads the same rows, so the widget and the
 * screen never disagree about what is waiting or working.
 */
export function widgetRows(input: WidgetInput): WidgetRow[] {
  const providers = new Map(input.providers.map((provider) => [provider.id, provider]));
  return input.sessions
    .filter((session) => !session.id.startsWith("pending:"))
    .map((session) => {
      const provider = providers.get(session.providerId);
      const row: WidgetRow = {
        id: session.id,
        title: clip(session.title) || "New conversation",
        state: stateOf(session, (input.asks[session.id]?.length ?? 0) > 0),
      };
      const project = session.folder || lastSegment(session.cwd);
      if (project) row.project = project;
      if (provider?.name) row.agent = provider.name;
      if (provider?.color && /^#[0-9a-f]{6}$/i.test(provider.color)) row.color = provider.color.toLowerCase();
      if (session.startedAt && Number.isFinite(session.startedAt) && session.startedAt > 0) row.at = session.startedAt;
      return row;
    });
}

/**
 * Build the snapshot from what the app already holds.
 *
 * Rows are ordered by urgency, then by the order the app lists conversations
 * in (most recent first), so a widget too small for every row always keeps
 * the one that is waiting on you. A conversation still being opened
 * (`pending:`) has no id the app could open from a link, so it is left out.
 */
export function widgetSnapshot(input: WidgetInput): WidgetContent {
  const all = widgetRows(input).map((row, index) => ({ row, index }));
  // Same order as the drawer's times: newest first, ties keep the list order.
  const recent = [...all].sort((a, b) => (b.row.at ?? 0) - (a.row.at ?? 0) || a.index - b.index);
  all.sort((a, b) => RANK[a.row.state] - RANK[b.row.state] || a.index - b.index);
  const snapshot: WidgetContent = {
    v: 1,
    waiting: all.filter(({ row }) => row.state === "waiting").length,
    working: all.filter(({ row }) => row.state === "working").length,
    rows: all.slice(0, WIDGET_ROWS).map(({ row }) => row),
    recent: recent.slice(0, WIDGET_ROWS).map(({ row }) => row),
  };
  if (input.machine) snapshot.machine = input.machine;
  return snapshot;
}

/**
 * Whether two snapshots would draw the same widget, so the store is only
 * rewritten (and the widget's refresh budget only spent) on a real change.
 */
export function sameSnapshot(a: WidgetContent | undefined, b: WidgetContent): boolean {
  if (!a) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The link a widget row opens: one conversation. */
export function openConversationLink(sessionId: string): string {
  return `pew2://open?session=${encodeURIComponent(sessionId)}`;
}

/** The New chat widget's link. */
export const NEW_CHAT_LINK = "pew2://new";

/** What a widget link asks for. */
export type WidgetLink = { kind: "open"; sessionId: string } | { kind: "new" };

/**
 * Read a link a widget opened, if it is one.
 *
 * `pew2://new` leaves whatever conversation is on screen for an empty
 * composer: like `open`, it can change what is on screen and nothing else, so
 * accepting it from any app costs nothing.
 */
export function widgetLink(url: string): WidgetLink | undefined {
  if (url.trim() === NEW_CHAT_LINK) return { kind: "new" };
  const sessionId = conversationFromLink(url);
  return sessionId ? { kind: "open", sessionId } : undefined;
}

/**
 * The conversation a `pew2://open?session=…` link asks for, if it is one.
 *
 * The only link this app acts on, and all it can do is open a conversation
 * already in the list: nothing here pairs, prompts or approves, so a link from
 * another app can at worst change which chat is on screen. Anything else is
 * ignored rather than guessed at.
 */
export function conversationFromLink(url: string): string | undefined {
  const match = /^pew2:\/\/open\?(.*)$/.exec(url.trim());
  if (!match) return undefined;
  for (const pair of (match[1] ?? "").split("&")) {
    const [key, value] = pair.split("=");
    if (key !== "session" || !value) continue;
    try {
      const id = decodeURIComponent(value);
      // A session id is short and printable; anything else was not made here.
      return id.length <= 200 && /^[\x21-\x7e]+$/.test(id) ? id : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}
