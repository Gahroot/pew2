/**
 * Reaching chats that are not open: Pew's `open_chat` and `start_chat`.
 *
 * Without these Pew could only reach the sessions open at that moment (at
 * most `MAX_LIVE_SESSIONS`, and idle ones close after 15 minutes), so "what
 * about billing?" while jogging hit a wall unless the chat had been tapped on
 * the phone first. The model only ever says a *name*; every path and id used
 * here comes from this daemon's own history, so nothing it says reaches a
 * spawn unchecked.
 *
 * The matching is pure and tested; `runChatTool` drives it through a port.
 */
import { basename } from "node:path";
import type { SessionStatus } from "./session.js";

/** One stored conversation, as the daemon lists it for voice. */
export interface VoiceChat {
  providerId: string;
  agentName: string;
  agentSessionId: string;
  cwd: string;
  title?: string;
  updatedAt?: string;
  /** Set when this conversation is open right now. */
  liveSessionId?: string;
}

export interface ChatPort {
  chats(): Promise<VoiceChat[]>;
  agents(): { providerId: string; agentName: string }[];
  /** The agent of the chat the call started from, if any. */
  contextProvider(): string | undefined;
  /** Reopen a stored conversation; the live session id, or undefined when it failed. */
  resume(chat: VoiceChat): Promise<string | undefined>;
  /** Start a new conversation in a project path from history; its live session id. */
  start(providerId: string, cwd: string): Promise<string>;
  tellAgent(sessionId: string, text: string): { ok: boolean; queued?: boolean };
  statuses(sessionId?: string): SessionStatus[];
  mark?(sessionId: string, line?: { kind: "pew" | "note"; text: string }): void;
}

const words = (text: string) =>
  text
    .toLowerCase()
    .replace(/\b(the|chat|session|agent|project|repo|folder|one|my)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Project folder name as people say it. */
export const projectName = (cwd: string) => basename(cwd) || cwd;

/**
 * The projects a spoken name could mean: an exact (normalised) name wins,
 * else every project whose name contains it or is contained in it.
 */
export function matchProjects(said: string, cwds: readonly string[]): string[] {
  const want = words(said);
  if (!want) return [];
  const unique = [...new Set(cwds)];
  const whole = unique.filter((cwd) => words(projectName(cwd)) === want);
  if (whole.length > 0) return whole;
  const squash = (text: string) => text.replace(/ /g, "");
  return unique.filter((cwd) => {
    const name = squash(words(projectName(cwd)));
    return name.length > 0 && (name.includes(squash(want)) || squash(want).includes(name));
  });
}

/** The agent a spoken name means ("claude", "codex", "Claude Code"), when exactly one fits. */
export function matchAgent<T extends { providerId: string; agentName: string }>(said: string, agents: readonly T[]): T | undefined {
  const want = words(said).replace(/ /g, "");
  if (!want) return undefined;
  const key = (agent: T) => [agent.providerId, agent.agentName].map((name) => words(name).replace(/ /g, ""));
  const exact = agents.filter((agent) => key(agent).includes(want));
  if (exact.length === 1) return exact[0];
  const partial = agents.filter((agent) => key(agent).some((name) => name.includes(want) || want.includes(name)));
  return partial.length === 1 ? partial[0] : undefined;
}

/** How many of the asked-for words a chat's title holds. */
function titleScore(title: string | undefined, about: string): number {
  if (!title) return 0;
  const have = new Set(words(title).split(" "));
  return words(about)
    .split(" ")
    .filter((word) => word.length > 2 && have.has(word)).length;
}

export type ChatPick =
  | { kind: "found"; chat: VoiceChat }
  | { kind: "none"; say: string }
  | { kind: "ambiguous"; say: string; options: string[] };

/**
 * Which stored chat `open_chat` means: in the named project (and agent, when
 * named), the one whose title best fits `about`, else the newest. `chats`
 * arrives newest first.
 */
export function pickChat(
  chats: readonly VoiceChat[],
  agents: readonly { providerId: string; agentName: string }[],
  args: { project?: string; agent?: string; about?: string },
): ChatPick {
  let pool = [...chats];
  if (args.agent) {
    const agent = matchAgent(args.agent, agents);
    if (!agent) return { kind: "none", say: `I don't know an agent called ${args.agent}.` };
    pool = pool.filter((chat) => chat.providerId === agent.providerId);
  }
  if (args.project) {
    const cwds = matchProjects(args.project, pool.map((chat) => chat.cwd));
    if (cwds.length === 0) return { kind: "none", say: `I can't find a chat in ${args.project}.` };
    if (cwds.length > 1) {
      const options = [...new Set(cwds.map(projectName))];
      if (options.length > 1) return { kind: "ambiguous", say: `Which one: ${options.join(", ")}?`, options };
    }
    pool = pool.filter((chat) => cwds.includes(chat.cwd));
  }
  if (args.about) {
    const best = Math.max(0, ...pool.map((chat) => titleScore(chat.title, args.about!)));
    if (best > 0) pool = pool.filter((chat) => titleScore(chat.title, args.about!) === best);
    else if (!args.project) return { kind: "none", say: `I can't find a chat about ${args.about}.` };
  }
  const chat = pool[0];
  return chat ? { kind: "found", chat } : { kind: "none", say: "I can't find that chat." };
}

/**
 * Which agent `start_chat` uses in a project: the one named, else the one
 * last used there, else the one of the chat they called from.
 */
export function pickAgent(
  chats: readonly VoiceChat[],
  agents: readonly { providerId: string; agentName: string }[],
  cwd: string,
  said: string | undefined,
  contextProvider: string | undefined,
): { providerId: string; agentName: string } | { say: string } {
  if (said) return matchAgent(said, agents) ?? { say: `I don't know an agent called ${said}.` };
  const usable = new Set(agents.map((agent) => agent.providerId));
  const last = chats.find((chat) => chat.cwd === cwd && usable.has(chat.providerId));
  const id = last?.providerId ?? (contextProvider && usable.has(contextProvider) ? contextProvider : undefined);
  const agent = agents.find((entry) => entry.providerId === id);
  return agent ?? { say: "Which agent should I start?" };
}

/** How far back Pew's reach goes: projects worked in within this window. */
export const REACH_DAYS = 14;
/** At most this many projects in reach, newest first. */
export const REACH_PROJECTS = 8;

/**
 * The chats Pew may reach by voice: those open right now, and those in the
 * `REACH_PROJECTS` projects worked in most recently within `REACH_DAYS`.
 * Everything else in the history is out of reach (listing, opening and
 * starting alike): it once read out every project on the machine.
 */
export function withinReach(chats: readonly VoiceChat[], now: number): VoiceChat[] {
  const since = now - REACH_DAYS * 86_400_000;
  const recent = new Set<string>();
  for (const chat of chats) {
    const at = chat.updatedAt ? Date.parse(chat.updatedAt) : Number.NaN;
    if (!(at >= since)) continue;
    recent.add(chat.cwd);
    if (recent.size >= REACH_PROJECTS) break;
  }
  return chats.filter((chat) => chat.liveSessionId !== undefined || recent.has(chat.cwd));
}

/** Projects for the briefing: newest first, each once. */
export function recentProjects(chats: readonly VoiceChat[], max: number): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const chat of chats) {
    const name = projectName(chat.cwd);
    if (seen.has(name)) continue;
    seen.add(name);
    names.push(name);
    if (names.length >= max) break;
  }
  return names;
}

export const CHAT_TOOLS = new Set(["open_chat", "start_chat"]);

const out = (value: Record<string, unknown>) => ({ output: JSON.stringify(value) });
const fail = (say: string, error: string) => out({ ok: false, error, say });
const str = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);

function named(sessionId: string, port: ChatPort, fallback: { cwd: string; agentName: string }) {
  const status = port.statuses(sessionId)[0];
  return { project: status?.folder ?? projectName(fallback.cwd), agent: status?.agentName ?? fallback.agentName };
}

/** Run `open_chat` / `start_chat`. Never throws: a failure is something Pew says. */
export async function runChatTool(name: string, rawArgs: string, port: ChatPort): Promise<{ output: string }> {
  let args: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(rawArgs || "{}");
    if (parsed && typeof parsed === "object") args = parsed as Record<string, unknown>;
  } catch {
    // Treated as no arguments.
  }
  try {
    const chats = await port.chats();
    const agents = port.agents();

    if (name === "open_chat") {
      const project = str(args.project);
      const about = str(args.about);
      if (!project && !about) return fail("Which project?", "project or about required");
      const pick = pickChat(chats, agents, { project, agent: str(args.agent), about });
      if (pick.kind !== "found") return fail(pick.say, pick.kind);
      const { chat } = pick;
      const already = chat.liveSessionId;
      const sessionId = already ?? (await port.resume(chat));
      if (!sessionId) return fail("I couldn't reopen that chat.", "resume failed");
      port.mark?.(sessionId);
      const who = named(sessionId, port, chat);
      return out({
        ok: true,
        session_id: sessionId,
        project: who.project,
        agent: who.agent,
        ...(chat.title ? { title: chat.title } : {}),
        already_open: already !== undefined,
        last_reply: port.statuses(sessionId)[0]?.lastLines ?? [],
        say: `${who.project} is open.`,
      });
    }

    if (name === "start_chat") {
      const project = str(args.project);
      if (!project) return fail("Which project?", "project required");
      const cwds = matchProjects(project, chats.map((chat) => chat.cwd));
      if (cwds.length === 0) return fail(`I don't know a project called ${project}.`, "unknown project");
      const names = [...new Set(cwds.map(projectName))];
      if (names.length > 1) return fail(`Which one: ${names.join(", ")}?`, "ambiguous");
      const cwd = cwds[0]!;
      const agent = pickAgent(chats, agents, cwd, str(args.agent), port.contextProvider());
      if ("say" in agent) return fail(agent.say, "agent");
      const sessionId = await port.start(agent.providerId, cwd);
      const text = str(args.text);
      let queued = false;
      if (text) {
        const sent = port.tellAgent(sessionId, text);
        queued = sent.queued === true;
        port.mark?.(sessionId, { kind: "pew", text });
      } else {
        port.mark?.(sessionId);
      }
      return out({
        ok: true,
        session_id: sessionId,
        project: projectName(cwd),
        agent: agent.agentName,
        sent: text !== undefined,
        say: text ? `Started ${agent.agentName} in ${projectName(cwd)}${queued ? "; it's queued" : ""}.` : `${agent.agentName} is ready in ${projectName(cwd)}.`,
      });
    }

    return fail("I can't do that.", `unknown tool ${name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail("That didn't work on your computer.", message.slice(0, 300));
  }
}
