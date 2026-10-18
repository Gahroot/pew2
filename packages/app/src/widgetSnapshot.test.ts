import { describe, expect, it } from "bun:test";
import {
  NEW_CHAT_LINK,
  WIDGET_ROWS,
  conversationFromLink,
  widgetLink,
  openConversationLink,
  sameSnapshot,
  widgetAppGroup,
  widgetSnapshot,
  type WidgetInput,
} from "./widgetSnapshot";

describe("widgetAppGroup", () => {
  it("is group. + the bundle id the build was signed with", () => {
    // A fork signs under its own id and team, so its group follows that id.
    expect(widgetAppGroup("com.prestyj.pew2")).toBe("group.com.prestyj.pew2");
    expect(widgetAppGroup("io.github.kenkaiii.pew2")).toBe("group.io.github.kenkaiii.pew2");
  });

  it("names no group without a bundle id", () => {
    expect(widgetAppGroup(undefined)).toBeUndefined();
    expect(widgetAppGroup(null)).toBeUndefined();
    expect(widgetAppGroup("")).toBeUndefined();
  });
});

const providers = [
  { id: "claude", name: "Claude Code", color: "#D97757" },
  { id: "gg", name: "GG Coder" },
];

function session(id: string, extra: Partial<WidgetInput["sessions"][number]> = {}) {
  return { id, providerId: "claude", title: `Chat ${id}`, folder: "pew2", ...extra };
}

describe("widgetSnapshot", () => {
  it("puts what is waiting on you first, then what is working, then what is new", () => {
    const snapshot = widgetSnapshot({
      sessions: [
        session("idle"),
        session("new", { unread: true }),
        session("busy", { busy: true }),
        session("asks"),
        session("perm", { permission: { requestId: "r1" }, busy: true }),
      ],
      asks: { asks: [{}] },
      providers,
    });
    expect(snapshot.rows.map((row) => [row.id, row.state])).toEqual([
      ["asks", "waiting"],
      ["perm", "waiting"],
      ["busy", "working"],
      ["new", "unread"],
      ["idle", "idle"],
    ]);
    expect(snapshot.waiting).toBe(2);
    expect(snapshot.working).toBe(1);
  });

  it("counts every conversation even when only a few fit", () => {
    // The large widget shows six; the count on the small one must not stop there.
    const sessions = Array.from({ length: 9 }, (_, i) => session(`s${i}`, { busy: true }));
    const snapshot = widgetSnapshot({ sessions, asks: {}, providers });
    expect(snapshot.rows).toHaveLength(WIDGET_ROWS);
    expect(snapshot.working).toBe(9);
  });

  it("names the project and the agent, and keeps only a colour Swift can read", () => {
    const snapshot = widgetSnapshot({
      sessions: [session("a", { startedAt: 1000 }), session("b", { providerId: "gg", folder: undefined, cwd: "/Users/k/site/" })],
      asks: {},
      providers,
      machine: "Ken's Mac",
    });
    expect(snapshot.rows[0]).toEqual({
      id: "a",
      title: "Chat a",
      project: "pew2",
      agent: "Claude Code",
      color: "#d97757",
      state: "idle",
      at: 1000,
    });
    expect(snapshot.rows[1]?.project).toBe("site");
    expect(snapshot.rows[1]?.color).toBeUndefined();
    expect(snapshot.machine).toBe("Ken's Mac");
  });

  it("leaves out a conversation still being opened, which no link could reach", () => {
    const snapshot = widgetSnapshot({ sessions: [session("pending:1", { busy: true })], asks: {}, providers });
    expect(snapshot.rows).toEqual([]);
    expect(snapshot.working).toBe(0);
  });

  it("keeps a title to one tidy line", () => {
    const title = `Fix\n\nthe   build ${"x".repeat(200)}`;
    const [row] = widgetSnapshot({ sessions: [session("a", { title })], asks: {}, providers }).rows;
    expect(row?.title.startsWith("Fix the build x")).toBe(true);
    expect(row?.title.length).toBe(80);
    expect(row?.title.endsWith("…")).toBe(true);
  });
});

describe("recent", () => {
  it("lists the latest conversations newest first, whatever they are doing", () => {
    // The Recent widget is for getting back in, so a quiet chat from a minute
    // ago comes before one waiting on you since yesterday.
    const snapshot = widgetSnapshot({
      sessions: [
        session("old-waiting", { startedAt: 100, permission: { requestId: "r" } }),
        session("newest", { startedAt: 900 }),
        session("middle", { startedAt: 500, busy: true }),
      ],
      asks: {},
      providers,
    });
    expect(snapshot.recent.map((row) => [row.id, row.at])).toEqual([
      ["newest", 900],
      ["middle", 500],
      ["old-waiting", 100],
    ]);
    // The Agents widget still leads with what needs you.
    expect(snapshot.rows[0]?.id).toBe("old-waiting");
  });

  it("keeps the list order for conversations with no time, and never invents one", () => {
    const snapshot = widgetSnapshot({ sessions: [session("a"), session("b")], asks: {}, providers });
    expect(snapshot.recent.map((row) => row.id)).toEqual(["a", "b"]);
    expect(snapshot.recent[0]?.at).toBeUndefined();
  });

  it("holds at most what the large widget shows", () => {
    const sessions = Array.from({ length: 9 }, (_, i) => session(`s${i}`, { startedAt: i + 1 }));
    const snapshot = widgetSnapshot({ sessions, asks: {}, providers });
    expect(snapshot.recent).toHaveLength(WIDGET_ROWS);
    expect(snapshot.recent[0]?.id).toBe("s8");
  });
});

describe("sameSnapshot", () => {
  it("only reports a change when the widget would look different", () => {
    const input = { sessions: [session("a")], asks: {}, providers };
    const first = widgetSnapshot(input);
    expect(sameSnapshot(first, widgetSnapshot(input))).toBe(true);
    expect(sameSnapshot(first, widgetSnapshot({ ...input, sessions: [session("a", { busy: true })] }))).toBe(false);
    expect(sameSnapshot(undefined, first)).toBe(false);
  });
});

describe("conversation links", () => {
  it("round-trips a session id, including characters a URL has to escape", () => {
    const id = "claude:abc/123?x=1";
    expect(conversationFromLink(openConversationLink(id))).toBe(id);
  });

  it("reads the New chat widget's link, and nothing that merely starts like it", () => {
    expect(widgetLink(NEW_CHAT_LINK)).toEqual({ kind: "new" });
    expect(widgetLink("pew2://new?prompt=rm%20-rf")).toBeUndefined();
    expect(widgetLink(openConversationLink("abc"))).toEqual({ kind: "open", sessionId: "abc" });
  });

  it("ignores every other link rather than guessing", () => {
    expect(conversationFromLink("pew2://pair?key=abc")).toBeUndefined();
    expect(conversationFromLink("https://example.com/open?session=a")).toBeUndefined();
    expect(conversationFromLink("pew2://open?other=a")).toBeUndefined();
    expect(conversationFromLink("pew2://open?session=")).toBeUndefined();
  });

  it("refuses an id no session could have", () => {
    expect(conversationFromLink("pew2://open?session=a%20b")).toBeUndefined();
    expect(conversationFromLink("pew2://open?session=%E0%A4%A")).toBeUndefined();
    expect(conversationFromLink(`pew2://open?session=${"a".repeat(201)}`)).toBeUndefined();
  });
});
