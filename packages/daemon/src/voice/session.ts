/**
 * Minting one realtime call: the instructions, the briefing, the tools, and
 * the client secret the phone opens its WebRTC call with.
 *
 * Instructions and tools are bound to the secret here, on the daemon, so what
 * Pew says and may do ships on the daemon's rail rather than the App Store's.
 */
import type { wire } from "@pew2/protocol";
import { sessionName } from "./notes.js";
import type { FetchLike } from "./credentials.js";
import { describeItem } from "./inbox.js";

export const REALTIME_MODEL = "gpt-realtime-2.1-mini";
export const REALTIME_VOICE = "marin";
export const CLIENT_SECRETS_URL = "https://api.openai.com/v1/realtime/client_secrets";
export const REALTIME_CALLS_URL = "https://api.openai.com/v1/realtime/calls";

/** What a session is doing, for the briefing and `get_status`. */
export interface SessionStatus {
  sessionId: string;
  folder?: string;
  agentName?: string;
  working: boolean;
  /** The last few lines the agent said (plain text). */
  lastLines: string[];
  /** While working: what it is doing right now (its current tool, or latest line). */
  activity?: string;
}

const fn = (name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []) => ({
  type: "function",
  name,
  description,
  parameters: { type: "object", properties, required, additionalProperties: false },
});

export function voiceTools() {
  return [
    fn("list_waiting", "List everything the user's agents are waiting on, oldest first."),
    fn(
      "answer_permission",
      "Allow once or deny one approval. Never grants 'always'. Destructive actions need confirmed:true after you read the action back and the user said yes.",
      {
        item_id: { type: "string", description: "The inbox item id." },
        decision: { type: "string", enum: ["allow", "deny"] },
        confirmed: { type: "boolean", description: "The user confirmed a read-back of a destructive action." },
      },
      ["item_id", "decision"],
    ),
    fn(
      "answer_question",
      "Answer an agent's question, or cancel it.",
      {
        item_id: { type: "string" },
        answers: {
          type: "object",
          description: "Question id to the chosen option value or typed text (array for multi-select).",
          additionalProperties: { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
        },
        cancel: { type: "boolean" },
      },
      ["item_id"],
    ),
    fn(
      "decide_plan",
      "Accept a plan, send feedback to revise it, or reject it.",
      {
        item_id: { type: "string" },
        action: { type: "string", enum: ["accept", "feedback", "reject"] },
        feedback: { type: "string" },
      },
      ["item_id", "action"],
    ),
    fn(
      "tell_agent",
      "Send a message to a coding agent's session, as if the user typed it into that chat. Write it as a clear task instruction to a coding agent (no greeting, no names). Queued if the agent is busy.",
      {
        session_id: { type: "string", description: "The session's id from the briefing (its folder name also works)." },
        text: {
          type: "string",
          description:
            "The instruction for the coding agent, as a developer would type it. Only the agent's own work: anything about calling or ringing the user is yours (call_me_back), never part of this text.",
        },
      },
      ["session_id", "text"],
    ),
    fn(
      "get_status",
      "How a session is doing now: working or idle, what it is doing, its last reply, and what it waits on. Call it whenever they ask about a session after the call began (the briefing is from the start of the call). Without session_id: every session.",
      { session_id: { type: "string" } },
    ),
    fn(
      "call_me_back",
      "The user wants a call later: you'll ring them then, even if nothing is waiting. For \"call me when it's done\", pass when_done (no time) and you'll ring when that session finishes. Then say goodbye; the call ends.",
      {
        when_done: { type: "string", description: "The session to wait for (tool id or project name): ring when its turn ends or it needs them." },
        minutes: { type: "number", minimum: 0.5, maximum: 240, description: "When to call back, in minutes." },
        seconds: { type: "integer", minimum: 30, maximum: 600, description: "Use instead of minutes for under a few minutes (\"in 30 seconds\")." },
      },
    ),
    fn(
      "set_ring",
      "Let a session ring the user's phone when it next needs them (on), or stop it (off). For \"call me if billing-api needs anything\" or \"don't call me about docs\". Ringing also needs Ring me switched on in the app; say so if the result says it's off.",
      {
        session_id: { type: "string", description: "The session's id from the briefing (its folder name also works)." },
        on: { type: "boolean" },
      },
      ["session_id", "on"],
    ),
    fn(
      "open_chat",
      "Reopen a past chat that isn't open now (the newest in that project, or the one whose title fits `about`), so you can work with it. If it is already open you get it straight back.",
      {
        project: { type: "string", description: "The project's folder name, as they said it." },
        agent: { type: "string", description: "Only if they named the agent." },
        about: { type: "string", description: "A few words of what the chat was about, if they said." },
      },
    ),
    fn(
      "start_chat",
      "Start a new chat with a coding agent in one of their projects, optionally sending the first message. Uses the agent they name, else the one they last used there.",
      {
        project: { type: "string", description: "The project's folder name, as they said it." },
        agent: { type: "string", description: "Only if they named the agent." },
        text: { type: "string", description: "The first message for the agent, close to their own words." },
      },
      ["project"],
    ),
    fn("end_call", "The user is done. Say a short goodbye; the call ends."),
  ];
}

/** Where new work goes on a call without task tools: a new chat. */
const NEW_WORK_CHAT = "If they ask for new work in a project with no chat, call start_chat with their request as the text.";
/** With task tools, new work is a task (`taskTools.ts` says how); a chat only when asked for. */
const NEW_WORK_TASK = "New work they ask for goes to start_task (see Tasks below); call start_chat only when they ask to start a chat.";
const NEW_WORK = "{{NEW_WORK}}";

const INSTRUCTIONS = `You are Pew, the pew2 mascot: a short-spoken AI voice assistant for the user's coding agents running on their computer.
If asked who you are, you're Pew, an AI voice assistant. If asked whether you're a person or an AI, say plainly that you're an AI; never claim or imply to be human. Never call the person "user"; just talk to them.
Each session is a coding agent (Claude Code, Codex, Gemini CLI and so on) working in a project folder on their computer. The folder name is the project's name, never a person: a folder is a project, not someone to greet.
Never say a session id aloud (ids are for your tool calls). Call a session by its folder, adding the agent if needed; if several share a name, say how many.
The user is probably out walking or jogging, phone in a pocket and earbuds in. Keep every turn to one or two short sentences. No lists read aloud, no markdown, no code.
The user can't talk while you're talking, so stop after one or two short sentences and let them answer.
Call any tool straight away, with no preamble ("let me check", "I'll send that"): just call it, then answer or confirm in a few words.

Never act on your own:
- Only do what they asked for in this call, in their words. Until they ask for something, you may look (get_status, list_waiting) but never send, start, open, answer or decide anything.
- Never make up a message to an agent, and never "check in" with one on their behalf.
- Never pick an answer to an agent's question or approval yourself, not even the recommended one. Read it out and wait for their choice; if they don't give one, leave it.
- When you speak on your own (the greeting, or news at a pause) you have no tools: say it and wait.

Staying current:
- The briefing below is a snapshot from when the call started. If they ask what's going on right away, answer from it in one short sentence.
- After that, things change: the system tells you when a session you're working with starts or finishes a turn, and what it said. If they ask how a session is doing, whether it's done, or what it found, and you haven't just been told, call get_status first, then answer from what it returns. Never guess and never repeat an old status.
- get_status gives working or idle, what it is doing right now, its last reply, and anything it waits on.

Talking to a coding agent (tell_agent):
- Only the agent can look at the code; you can't. When they want something looked into or done in a project, pass it to that project's agent. When they only want to know how the agent is doing, use get_status. If you can't tell which they mean, ask.
- Send it close to their own words, usually one sentence, as a developer would type it into the chat. Tidy up speech (fillers, "it" for the project) but never expand it: don't add steps, checks, requirements or details they didn't ask for. No greeting, names or small talk.
- If it's unclear what they want done, ask them first.
- After sending, say just "Sent." (or "Queued." if it's busy). When it finishes you'll be told; give them the outcome in a sentence.
- One request can need two tools: "tell billing to check the logs and call me back when it's done" is tell_agent ("Check the logs.") then call_me_back with when_done. Do every part they asked for. What's meant for you (calling them back, ringing) never goes in the agent's text.

Which chat:
- The sessions listed below are the chats open right now; tell_agent and get_status work on those. Other chats exist in their history.
- If they ask about a project or chat that isn't open, call open_chat. ${NEW_WORK} Never start or open one they didn't ask for. Never ask them to open it on the phone.
- Whenever the chat you're working with changes, say its project name once so they know where you are.

How a call goes:
- If something is waiting, open with it: the count and the focused one (or the oldest), e.g. "Two things. pew2 wants to run npm test. Okay?"
- If nothing is waiting, never say so. Greet in one short line and stop, naming the project they called from if the briefing says where they called from ("Hey. What's up with <that project>?"). If it doesn't say, name no project: just "Hey, what's up?". Never pick one from the session list to greet with. When the briefing says why you're calling (a callback), your greeting says that instead.
- Handle one item at a time, project by project, oldest first. Wait for the answer before moving on.
- After acting, confirm in a few words that match what you did ("Sent.", "Approved.") and go to the next item.
- When everything is handled, ask if there's anything else rather than announcing that nothing is left.

Rules:
- Only act through your tools. Use the item ids from the briefing or list_waiting.
- For a question item, read the question and its options out briefly (say which one is recommended); if you weren't given the options, call list_waiting for them. Then wait. Only after they choose, call answer_question with the question ids and option values (or their own words when no option fits).
- Approvals are allow once or deny. Never grant "always", even if asked.
- Before you allow an approval or accept a plan, read back what it is in one short line ("billing wants to run npm test. Approve?") and wait. Only after they say yes, call the tool (confirmed true for destructive ones: publish, delete, rm, force push, drop, deploy, reset). If a tool tells you to read back first, do exactly that.
- If the user's answer is unclear, ask again briefly rather than guess.
- A system message may say a new item arrived or that one was handled elsewhere: mention new ones at the next pause, and skip handled ones.
- Questions and approvals also show on the user's phone during the call, as a card with the options. When you bring one up, say once that it's on their screen ("It's on your screen too."), then read it out as usual. They can answer by voice or by tapping.
- When they answer by voice, call the tool as usual: the card shows your pick before it goes.
- A system message may say the user answered something on screen: don't ask it again or call a tool for it; confirm in a few words ("Got it, keep v1.") and move to the next item.
- If the user says call me back in N minutes, call call_me_back. If they say bye or that's all, call end_call.
- If they ask to be called (or not) about a session when it needs them, call set_ring.`;

/** The instructions plus the briefing: the inbox and the last lines of each relevant session. */
/** Sessions listed in the briefing at most; past that, get_status has them all. */
const BRIEFING_SESSIONS = 12;

export function buildInstructions(
  items: readonly wire.VoiceInboxItem[],
  statuses: readonly SessionStatus[],
  focus?: string,
  now: number = Date.now(),
  context?: string,
  projects?: readonly string[],
  place?: { folder: string; agentName?: string },
  remembered: readonly string[] = [],
  /** The voice tasks' guidance and state (`VoiceService.brief`), last. Absent: a call without task tools. */
  tasks?: string,
): string {
  const ordered = focus ? [...items].sort((a, b) => Number(b.id === focus) - Number(a.id === focus)) : [...items];
  // Nothing waiting is not news: a "0 items" line got read out at every call.
  // Why this call is happening (a callback) leads the briefing: the greeting reads it first.
  const lead = remembered.filter((line) => line.startsWith("THIS CALL:"));
  const rest = remembered.filter((line) => !line.startsWith("THIS CALL:"));
  const lines = [INSTRUCTIONS.replace(NEW_WORK, tasks ? NEW_WORK_TASK : NEW_WORK_CHAT), "", ...(lead.length > 0 ? [...lead, ""] : [])];
  if (items.length > 0) lines.push(`Briefing: ${items.length} item${items.length === 1 ? "" : "s"} waiting.`);
  const from = context ? statuses.find((status) => status.sessionId === context) : undefined;
  if (from) {
    lines.push(
      `They called from the ${sessionName(from)} chat: assume that's the project they mean unless they name another. [tool id: ${from.sessionId}]`,
    );
  } else if (place) {
    lines.push(
      `They called from a new, empty ${sessionName(place)} chat: assume ${place.folder} is the project they mean unless they name another. Nothing has been sent there yet. Only when they ask for work in it, call start_chat with project ${place.folder}${place.agentName ? ` and agent ${place.agentName}` : ""} and their request as the text.`,
    );
  }
  if (focus && ordered[0]?.id === focus) lines.push(`Lead with item ${focus}.`);
  for (const item of ordered) {
    const mins = Math.max(0, Math.round((now - item.since) / 60_000));
    lines.push(`- [${item.id}] (${item.kind}, session ${item.sessionId}, waiting ${mins} min) ${describeItem(item)}`);
  }
  // Every open session, so Pew can answer "what are my agents doing?" from
  // here and address any of them by id. Waiting and working first; their
  // recent lines in full, an idle one's last line only.
  const relevant = new Set(items.map((item) => item.sessionId));
  const rank = (status: SessionStatus) => (relevant.has(status.sessionId) ? 0 : status.working ? 1 : 2);
  const listed = [...statuses].sort((a, b) => rank(a) - rank(b)).slice(0, BRIEFING_SESSIONS);
  if (listed.length > 0) {
    lines.push("", `Sessions (${statuses.length} open):`);
    for (const status of listed) {
      // Spoken name first; the id is last and marked as the tools' handle, so
      // it never reads as part of the name (Pew said "pew2 in folder echo-…").
      const name = status.folder ?? status.agentName ?? "a session";
      const agent = status.agentName && status.agentName !== name ? ` (${status.agentName})` : "";
      const doing = status.working && status.activity ? `, ${status.activity}` : "";
      lines.push(`- ${name}${agent}: ${status.working ? "working" : "idle"}${doing}. [tool id: ${status.sessionId}]`);
      const recent = rank(status) < 2 ? status.lastLines : status.lastLines.slice(-1);
      for (const line of recent) lines.push(`    ${line}`);
    }
  } else {
    lines.push("", "Sessions: none open.");
  }
  if (projects && projects.length > 0) {
    lines.push(
      "",
      `Projects you can reach (worked in over the last two weeks; open_chat and start_chat reach only these and the open sessions): ${projects.join(", ")}. If asked, name at most three, newest first, and say how many more.`,
    );
  }
  if (rest.length > 0) lines.push("", ...rest);
  if (tasks) lines.push("", tasks);
  return lines.join("\n");
}

/**
 * The session a call is minted with. `extraTools` are the voice tasks' own
 * (`taskTools.ts`), offered beside the call's; absent, the call has only its own.
 */
export function buildSessionConfig(instructions: string, extraTools: readonly Record<string, unknown>[] = []) {
  return {
    type: "realtime",
    model: REALTIME_MODEL,
    instructions,
    output_modalities: ["audio"],
    audio: {
      input: {
        transcription: { model: "gpt-4o-transcribe" },
        // Snappy turns: a short pause ends your turn. Measured with pew2's own
        // config (latency-probe.ts in the goal folder): Pew's first audio about
        // 1.06 s after you stop, against 1.30 s with semantic_vad "medium" and
        // "high". Background noise is handled by near_field noise reduction.
        turn_detection: {
          type: "server_vad",
          // 0.6, not the default 0.5: room noise after Pew stopped was being
          // taken for speech (a phantom one-word turn Pew then answered).
          threshold: 0.6,
          prefix_padding_ms: 300,
          silence_duration_ms: 400,
          create_response: true,
          interrupt_response: true,
        },
        noise_reduction: { type: "near_field" },
      },
      output: { voice: REALTIME_VOICE },
    },
    tools: [...voiceTools(), ...extraTools],
    tool_choice: "auto",
    // A long call: when the conversation outgrows the model's window, drop
    // the oldest fifth in one go instead of a little every turn, so the
    // instructions stay cached (OpenAI realtime `truncation`; verified
    // accepted by the client_secrets endpoint, 20 Oct).
    truncation: { type: "retention_ratio", retention_ratio: 0.8 },
  };
}

export type MintResult =
  | { ok: true; secret: string; expiresAt: number; model: string }
  | { ok: false; status?: number; error: string };

/** POST the session config; the bearer is the user's token, never returned. */
export async function mintClientSecret(
  token: string,
  session: ReturnType<typeof buildSessionConfig>,
  fetchImpl: FetchLike = fetch,
): Promise<MintResult> {
  let response: Response;
  try {
    response = await fetchImpl(CLIENT_SECRETS_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ session }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return { ok: false, error: "Couldn't reach OpenAI from this computer." };
  }
  const text = await response.text();
  if (!response.ok) {
    const detail = (() => {
      try {
        const message = (JSON.parse(text) as { error?: { message?: unknown } }).error?.message;
        return typeof message === "string" ? message : undefined;
      } catch {
        return undefined;
      }
    })();
    const error =
      response.status === 401 || response.status === 403
        ? "OpenAI refused this computer's login. Sign in again to use voice."
        : `OpenAI couldn't start the call (${response.status})${detail ? `: ${detail.slice(0, 160)}` : "."}`;
    return { ok: false, status: response.status, error };
  }
  try {
    const body = JSON.parse(text) as { value?: unknown; expires_at?: unknown; session?: { model?: unknown } };
    if (typeof body.value !== "string") return { ok: false, error: "OpenAI returned no call secret." };
    const expiresAt =
      typeof body.expires_at === "number" ? body.expires_at * 1000 : Date.now() + 600_000;
    const model = typeof body.session?.model === "string" ? body.session.model : session.model;
    return { ok: true, secret: body.value, expiresAt: Math.round(expiresAt), model };
  } catch {
    return { ok: false, error: "OpenAI returned an unreadable answer." };
  }
}
