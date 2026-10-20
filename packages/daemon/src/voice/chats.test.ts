import { expect, test } from "bun:test";
import { REACH_PROJECTS, matchAgent, matchProjects, pickAgent, pickChat, recentProjects, runChatTool, withinReach, type ChatPort, type VoiceChat } from "./chats.js";

const agents = [
  { providerId: "claude", agentName: "Claude Code" },
  { providerId: "codex", agentName: "Codex" },
];

const chat = (providerId: string, cwd: string, agentSessionId: string, updatedAt: string, title?: string, liveSessionId?: string): VoiceChat => ({
  providerId,
  agentName: agents.find((a) => a.providerId === providerId)!.agentName,
  agentSessionId,
  cwd,
  updatedAt,
  ...(title ? { title } : {}),
  ...(liveSessionId ? { liveSessionId } : {}),
});

// Newest first, as the daemon lists them.
const chats = [
  chat("claude", "/w/billing-api", "b2", "2026-10-19T10:00:00Z", "Add rate limits"),
  chat("codex", "/w/storefront", "s1", "2026-10-19T09:00:00Z", "Fix checkout bug"),
  chat("claude", "/w/billing-api", "b1", "2026-10-18T10:00:00Z", "Stripe webhook retries"),
  chat("claude", "/w/docs", "d1", "2026-10-10T10:00:00Z"),
];

test("projects match by spoken name: exact first, then partial", () => {
  const cwds = chats.map((c) => c.cwd);
  expect(matchProjects("billing api", cwds)).toEqual(["/w/billing-api"]);
  expect(matchProjects("the billing project", cwds)).toEqual(["/w/billing-api"]);
  expect(matchProjects("store", cwds)).toEqual(["/w/storefront"]);
  expect(matchProjects("nothing", cwds)).toEqual([]);
});

test("agents match by id or name, and only when exactly one fits", () => {
  expect(matchAgent("claude", agents)?.providerId).toBe("claude");
  expect(matchAgent("Claude Code", agents)?.providerId).toBe("claude");
  expect(matchAgent("codex", agents)?.providerId).toBe("codex");
  expect(matchAgent("gemini", agents)).toBeUndefined();
});

test("open_chat picks the newest chat in the project, or the one whose title fits", () => {
  const newest = pickChat(chats, agents, { project: "billing" });
  expect(newest.kind === "found" && newest.chat.agentSessionId).toBe("b2");
  const about = pickChat(chats, agents, { project: "billing", about: "the stripe webhooks" });
  expect(about.kind === "found" && about.chat.agentSessionId).toBe("b1");
  const byTitle = pickChat(chats, agents, { about: "checkout" });
  expect(byTitle.kind === "found" && byTitle.chat.agentSessionId).toBe("s1");
  expect(pickChat(chats, agents, { project: "billing", agent: "codex" }).kind).toBe("none");
  expect(pickChat(chats, agents, { project: "nope" })).toMatchObject({ kind: "none", say: "I can't find a chat in nope." });
});

test("two projects sharing a spoken name are asked about, not guessed", () => {
  const two = [...chats, chat("claude", "/w/billing-web", "x1", "2026-10-01T00:00:00Z")];
  expect(pickChat(two, agents, { project: "billing" })).toMatchObject({ kind: "ambiguous" });
});

test("start_chat's agent: the one named, else the last used there, else the calling chat's", () => {
  expect(pickAgent(chats, agents, "/w/storefront", undefined, "claude")).toMatchObject({ providerId: "codex" });
  expect(pickAgent(chats, agents, "/w/storefront", "claude", undefined)).toMatchObject({ providerId: "claude" });
  expect(pickAgent(chats, agents, "/w/new", undefined, "codex")).toMatchObject({ providerId: "codex" });
  expect(pickAgent(chats, agents, "/w/new", undefined, undefined)).toEqual({ say: "Which agent should I start?" });
});

test("the briefing's projects are newest first, each once", () => {
  expect(recentProjects(chats, 2)).toEqual(["billing-api", "storefront"]);
});

function port(overrides: Partial<ChatPort> = {}) {
  const calls: string[] = [];
  const base: ChatPort = {
    chats: async () => chats,
    agents: () => agents,
    contextProvider: () => undefined,
    resume: async (c) => {
      calls.push(`resume ${c.agentSessionId} ${c.cwd}`);
      return "live-1";
    },
    start: async (providerId, cwd) => {
      calls.push(`start ${providerId} ${cwd}`);
      return "live-2";
    },
    tellAgent: (sessionId, text) => {
      calls.push(`tell ${sessionId} ${text}`);
      return { ok: true };
    },
    statuses: () => [],
    mark: (sessionId) => calls.push(`mark ${sessionId}`),
  };
  return { port: { ...base, ...overrides }, calls };
}

test("open_chat reopens the stored chat and marks it on the board", async () => {
  const { port: p, calls } = port();
  const result = JSON.parse((await runChatTool("open_chat", JSON.stringify({ project: "billing" }), p)).output);
  expect(result).toMatchObject({ ok: true, session_id: "live-1", project: "billing-api", already_open: false });
  expect(calls).toEqual(["resume b2 /w/billing-api", "mark live-1"]);
});

test("open_chat on a chat that is already open hands it straight back", async () => {
  const open = chats.map((c) => (c.agentSessionId === "b2" ? { ...c, liveSessionId: "s-live" } : c));
  const { port: p, calls } = port({ chats: async () => open });
  const result = JSON.parse((await runChatTool("open_chat", JSON.stringify({ project: "billing" }), p)).output);
  expect(result).toMatchObject({ ok: true, session_id: "s-live", already_open: true });
  expect(calls).toEqual(["mark s-live"]);
});

test("start_chat starts the agent last used in the project and sends the first message", async () => {
  const { port: p, calls } = port();
  const result = JSON.parse(
    (await runChatTool("start_chat", JSON.stringify({ project: "storefront", text: "Fix the checkout bug" }), p)).output,
  );
  expect(result).toMatchObject({ ok: true, session_id: "live-2", agent: "Codex", sent: true });
  expect(calls).toEqual(["start codex /w/storefront", "tell live-2 Fix the checkout bug", "mark live-2"]);
});

test("failures are something Pew can say, never a throw", async () => {
  const { port: failing } = port({ resume: async () => undefined });
  expect(JSON.parse((await runChatTool("open_chat", '{"project":"docs"}', failing)).output)).toMatchObject({ ok: false, say: "I couldn't reopen that chat." });
  const { port: broken } = port({
    start: async () => {
      throw new Error("spawn failed");
    },
  });
  expect(JSON.parse((await runChatTool("start_chat", '{"project":"docs"}', broken)).output)).toMatchObject({ ok: false });
  expect(JSON.parse((await runChatTool("start_chat", '{"project":"mars"}', broken)).output)).toMatchObject({
    say: "I don't know a project called mars.",
  });
  expect(JSON.parse((await runChatTool("open_chat", "not json", broken)).output)).toMatchObject({ say: "Which project?" });
});

test("Pew's reach: open chats, plus the newest projects of the last two weeks, never the whole history", () => {
  const now = Date.parse("2026-10-20T00:00:00Z");
  const reach = withinReach(chats, now);
  // docs was last touched on the 10th, inside two weeks; all four stay.
  expect(reach.map((c) => c.agentSessionId)).toEqual(["b2", "s1", "b1", "d1"]);
  const later = Date.parse("2026-10-30T00:00:00Z");
  // Ten days on, only billing and storefront are inside the window.
  expect(withinReach(chats, later).map((c) => c.cwd)).toEqual(["/w/billing-api", "/w/storefront", "/w/billing-api"]);
  // An old chat that is open right now stays reachable.
  const open = chats.map((c) => (c.agentSessionId === "d1" ? { ...c, liveSessionId: "live" } : c));
  expect(withinReach(open, later).map((c) => c.agentSessionId)).toContain("d1");
  // Many recent projects: only the newest few.
  const many = Array.from({ length: 20 }, (_, i) => chat("claude", `/w/p${i}`, `x${i}`, `2026-10-19T${String(23 - i).padStart(2, "0")}:00:00Z`));
  expect(new Set(withinReach(many, now).map((c) => c.cwd)).size).toBe(REACH_PROJECTS);
});
