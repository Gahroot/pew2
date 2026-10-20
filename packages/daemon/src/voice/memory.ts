/**
 * What a call leaves for the next one, besides its words (`threads.ts`):
 * what Pew did on it (`actionLine`), and why a callback is ringing
 * (`callbackLines`). Pure: the controller holds the values.
 */

/** A call answered within this long of a callback ring is that callback. */
export const CALLBACK_ANSWER_MS = 3 * 60_000;

/** At most this many actions are kept per call. */
export const MEMORY_ACTIONS = 12;

const clipText = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/**
 * One line for something Pew did on a call, from a tool call that worked:
 * the facts the next call needs ("Sent billing-api: run the tests").
 * Undefined for looking (status, inbox) or anything that failed.
 */
export function actionLine(name: string, rawArgs: string, output: string, nameOf: (sessionId: string) => string | undefined): string | undefined {
  let result: { ok?: unknown };
  let args: Record<string, unknown> = {};
  try {
    result = JSON.parse(output) as { ok?: unknown };
    const parsed = JSON.parse(rawArgs || "{}");
    if (parsed && typeof parsed === "object") args = parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (result.ok !== true) return undefined;
  const str = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
  const session = (id: unknown) => (typeof id === "string" ? (nameOf(id) ?? "a session") : "a session");
  const item = (id: unknown) => (typeof id === "string" ? session(id.split(":")[0]) : "a session");
  switch (name) {
    case "tell_agent":
      return `Sent ${session(args.session_id)}: "${clipText(str(args.text) ?? "", 160)}"`;
    case "answer_permission":
      return `${args.decision === "deny" ? "Denied" : "Approved"} ${item(args.item_id)}'s request`;
    case "answer_question":
      return `Answered ${item(args.item_id)}'s question: ${clipText(JSON.stringify(args.answers ?? {}), 120)}`;
    case "decide_plan":
      return `${args.action === "reject" ? "Rejected" : "Accepted"} ${item(args.item_id)}'s plan`;
    case "open_chat":
      return `Opened the ${str(args.project) ?? "asked"} chat`;
    case "start_chat":
      return `Started a chat in ${str(args.project) ?? "a project"}${str(args.text) ? `: "${clipText(str(args.text)!, 120)}"` : ""}`;
    case "call_me_back":
      return "Booked the callback they asked for";
    case "set_ring":
      return `Set ${session(args.session_id)} to ${args.on === false ? "not ring" : "ring"} them`;
    default:
      return undefined;
  }
}

const ago = (ms: number) => {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "moments ago";
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.round(minutes / 60)} h ago`;
};

/** Why this call is happening, when it is a callback: it leads the briefing (`THIS CALL:`). */
export function callbackLines(now: number, callback?: { askedAt: number }): string[] {
  if (!callback) return [];
  return [
    `THIS CALL: you rang them because ${ago(now - callback.askedAt)} they asked you to call them back, and they just picked up. Your first words: a short hello saying you're calling them back. Then wait for them.`,
  ];
}

/**
 * The session a tool call acted on, as the model named it: `session_id`, the
 * session part of an `item_id`, or (start/open chat) the session the result
 * reports. Undefined for tools that act on no session.
 */
export function actionTarget(name: string, rawArgs: string, output: string): string | undefined {
  let args: Record<string, unknown> = {};
  let result: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(rawArgs || "{}");
    if (parsed && typeof parsed === "object") args = parsed as Record<string, unknown>;
    const out = JSON.parse(output);
    if (out && typeof out === "object") result = out as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (name === "open_chat" || name === "start_chat") return typeof result.session_id === "string" ? result.session_id : undefined;
  if (typeof args.session_id === "string" && args.session_id) return args.session_id;
  if (typeof args.item_id === "string" && args.item_id) return args.item_id.split(":")[0];
  return undefined;
}
