/**
 * Running the voice model's tool calls through the daemon's ordinary methods.
 *
 * Every result is short JSON with a `say` hint, because the model speaks it.
 * The safety rules from the instructions are enforced here too: approvals are
 * allow-once or reject, never "always", and a destructive-looking approval
 * needs `confirmed: true`.
 */
import type { wire } from "@pew2/protocol";
import type { SessionStatus } from "./session.js";

/** What the tools need from the daemon. The handler supplies it. */
export interface VoicePort {
  items(): wire.VoiceInboxItem[];
  /** The ACP options of an open permission, or undefined when it is gone. */
  permissionOptions(sessionId: string, requestId: string): PermissionOption[] | undefined;
  /** An open question's questions, so the model can read the choices out. Optional for older ports/tests. */
  askQuestions?(sessionId: string, requestId: string): unknown[] | undefined;
  answerPermission(sessionId: string, requestId: string, optionId: string): boolean;
  answerAsk(sessionId: string, requestId: string, result: wire.AskResult): boolean;
  decidePlan(
    sessionId: string,
    action: "accept" | "feedback" | "reject",
    generation: number,
    feedback?: string,
  ): void;
  /** Prompt, or queue behind a running turn, exactly like `session.prompt`. Returns whether it queued. */
  tellAgent(sessionId: string, text: string): { ok: boolean; queued?: boolean };
  statuses(sessionId?: string): SessionStatus[];
  callMeBack(minutes: number): void;
  /** Ring once this session's turn ends (or it needs them). Absent: an older host. */
  callWhenDone?(sessionId: string, folder: string | undefined): void;
  /** Let a session ring (or stop it); returns whether ringing is switched on at all. Optional for older ports/tests. */
  setRing?(sessionId: string, on: boolean): { ringing: boolean };
  /** Pew acted on a session: touch its lane on the call board, optionally with a line. */
  mark?(sessionId: string, line?: { kind: "pew" | "note"; text: string }): void;
}

export interface PermissionOption {
  optionId: string;
  kind?: string;
  name?: string;
}

export interface ToolOutcome {
  output: string;
  hangUp?: boolean;
}

export const DESTRUCTIVE =
  /\b(publish|delete|rm|rmdir|drop|deploy|destroy|truncate|force|reset\s+--hard|wipe)\b/i;

export function isDestructive(title: string): boolean {
  return DESTRUCTIVE.test(title);
}

export function permissionOptionsFrom(params: unknown): PermissionOption[] {
  const raw = (params as { options?: unknown } | null)?.options;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((option) => {
    const typed = option as { optionId?: unknown; kind?: unknown; name?: unknown } | null;
    if (typeof typed?.optionId !== "string") return [];
    return [
      {
        optionId: typed.optionId,
        ...(typeof typed.kind === "string" ? { kind: typed.kind } : {}),
        ...(typeof typed.name === "string" ? { name: typed.name } : {}),
      },
    ];
  });
}

/** allow → allow_once only; deny → reject_once, then reject_always. Never allow_always. */
export function pickOption(
  options: PermissionOption[],
  decision: "allow" | "deny",
): PermissionOption | undefined {
  const order = decision === "allow" ? ["allow_once"] : ["reject_once", "reject_always"];
  for (const kind of order) {
    const found = options.find((option) => option.kind === kind);
    if (found) return found;
  }
  return undefined;
}

const out = (value: Record<string, unknown>, hangUp?: boolean): ToolOutcome => ({
  output: JSON.stringify(value),
  ...(hangUp ? { hangUp: true } : {}),
});

const fail = (say: string, error = say) => out({ ok: false, error, say });

function findItem(items: wire.VoiceInboxItem[], id: unknown): wire.VoiceInboxItem | undefined {
  if (typeof id !== "string") return undefined;
  return items.find((item) => item.id === id) ?? items.find((item) => item.requestId === id);
}

function parseArgs(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

const brief = (item: wire.VoiceInboxItem) => ({
  item_id: item.id,
  kind: item.kind,
  session_id: item.sessionId,
  ...(item.folder ? { folder: item.folder } : {}),
  title: item.title,
});

/**
 * An ask's questions trimmed to what a voice needs: id, the question, its kind,
 * and the options' values and labels. `answer_question` takes these ids and values.
 */
export function spokenQuestions(raw: unknown[] | undefined) {
  if (!Array.isArray(raw)) return undefined;
  const questions = raw.flatMap((entry) => {
    const q = entry as { id?: unknown; question?: unknown; kind?: unknown; options?: unknown };
    if (typeof q?.id !== "string" || typeof q.question !== "string") return [];
    const options = Array.isArray(q.options)
      ? q.options.flatMap((o) => {
          const option = o as { label?: unknown; value?: unknown; recommended?: unknown };
          if (typeof option?.label !== "string") return [];
          return [
            {
              label: option.label,
              value: typeof option.value === "string" ? option.value : option.label,
              ...(option.recommended === true ? { recommended: true } : {}),
            },
          ];
        })
      : [];
    return [
      {
        id: q.id,
        question: q.question,
        ...(typeof q.kind === "string" ? { kind: q.kind } : {}),
        ...(options.length > 0 ? { options } : {}),
      },
    ];
  });
  return questions.length > 0 ? questions : undefined;
}

/** An answer as words for the call board: option labels where a value maps to one. */
export function answerInWords(answers: Record<string, string | string[]>, questions: unknown[] | undefined): string {
  const spoken = spokenQuestions(questions) ?? [];
  return Object.entries(answers)
    .map(([id, value]) => {
      const options = spoken.find((question) => question.id === id)?.options ?? [];
      const label = (v: string) => options.find((option) => option.value === v)?.label ?? v;
      return (Array.isArray(value) ? value : [value]).map(label).join(", ");
    })
    .filter((text) => text.trim().length > 0)
    .join("; ");
}

/**
 * The session a voice tool means. The model is given session ids, but people
 * say "the docs one" or "echo", and a model sometimes passes that through: an
 * exact id wins, else a unique match on the folder or agent name (any case,
 * ignoring "session"/"agent"/"the"). Undefined when nothing, or more than one
 * session, matches.
 */
/**
 * Take "call me back / ring me" out of a message for an agent: it is the
 * user's request to Pew, and an agent can't ring anyone. Measured against the
 * real model: with every instruction against it, it still wrote it into the
 * agent's text in some runs. Returns the cleaned text and whether one was cut.
 */
export function withoutCallback(text: string): { text: string; asked: boolean } {
  const callsUser = /\b(?:call|ring|phone|notify|ping)\s+(?:me|the user|them)\b/i;
  if (!callsUser.test(text)) return { text, asked: false };
  const kept: string[] = [];
  for (const sentence of text.match(/[^.!?]+[.!?]*/g) ?? [text]) {
    const match = callsUser.exec(sentence);
    if (!match) {
      kept.push(sentence.trim());
      continue;
    }
    // "…logs and call me back once it's done." keeps "…logs." A sentence
    // that is only the ask ("Then call me back.") goes whole.
    const before = sentence
      .slice(0, match.index)
      .replace(/[\s,;]*(?:\b(?:and|then|when|once|after|so|also|please|it's|its|done|finished|you're|is)\b[\s,;]*)*$/i, "")
      .trim();
    if (before && /\w{3,}/.test(before) && !/^(?:then|when|once|after)\b/i.test(before)) kept.push(`${before}.`);
  }
  const cleaned = kept.join(" ").replace(/\s{2,}/g, " ").trim();
  return { text: cleaned, asked: true };
}

export function resolveSession(said: string, statuses: readonly SessionStatus[]): string | undefined {
  const raw = said.trim();
  if (!raw) return undefined;
  const exact = statuses.find((status) => status.sessionId === raw);
  if (exact) return exact.sessionId;
  const words = (text: string) =>
    text
      .toLowerCase()
      .replace(/\b(the|session|agent|one|project)\b/g, " ")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  const want = words(raw);
  if (!want) return undefined;
  const names = (status: SessionStatus) => [status.folder, status.agentName].filter((x): x is string => !!x).map(words);
  const whole = statuses.filter((status) => names(status).some((name) => name === want));
  if (whole.length === 1) return whole[0]!.sessionId;
  const partial = statuses.filter((status) => names(status).some((name) => name.includes(want) || want.includes(name)));
  return partial.length === 1 ? partial[0]!.sessionId : undefined;
}

export function runVoiceTool(name: string, rawArgs: string, port: VoicePort): ToolOutcome {
  const args = parseArgs(rawArgs);
  const gone = () => fail("That one's already been handled.", "unknown or already handled item");
  switch (name) {
    case "list_waiting": {
      const items = port.items();
      return out({
        ok: true,
        items: items.map((item) => {
          if (item.kind !== "question") return brief(item);
          const questions = spokenQuestions(port.askQuestions?.(item.sessionId, item.requestId));
          return questions ? { ...brief(item), questions } : brief(item);
        }),
        say: items.length === 0 ? "Nothing's waiting." : `${items.length} waiting.`,
      });
    }

    case "answer_permission": {
      const item = findItem(port.items(), args.item_id);
      if (!item || item.kind !== "approval") return gone();
      const decision =
        args.decision === "allow" ? "allow" : args.decision === "deny" ? "deny" : undefined;
      if (!decision) return fail("Allow or deny?", "decision must be allow or deny");
      if (decision === "allow" && isDestructive(item.title) && args.confirmed !== true) {
        return out({
          ok: false,
          needsConfirmation: true,
          title: item.title,
          say: `That's destructive: ${item.title}. Sure?`,
        });
      }
      const options = port.permissionOptions(item.sessionId, item.requestId);
      if (!options) return gone();
      const option = pickOption(options, decision);
      if (!option) {
        return fail(
          decision === "allow"
            ? "That one can't be allowed just once. Do it on the phone."
            : "There's no deny option.",
          "no matching option",
        );
      }
      if (!port.answerPermission(item.sessionId, item.requestId, option.optionId)) return gone();
      port.mark?.(item.sessionId, {
        kind: "note",
        text: decision === "allow" ? `Approved once: ${item.title}` : `Denied: ${item.title}`,
      });
      return out({ ok: true, say: decision === "allow" ? "Approved." : "Denied." });
    }

    case "answer_question": {
      const item = findItem(port.items(), args.item_id);
      if (!item || item.kind !== "question") return gone();
      let result: wire.AskResult;
      if (args.cancel === true) result = { action: "cancel" };
      else {
        const raw = args.answers;
        if (!raw || typeof raw !== "object" || Array.isArray(raw))
          return fail("What's the answer?", "answers required");
        const answers: Record<string, string | string[]> = {};
        for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
          if (typeof value === "string") answers[key] = value;
          else if (Array.isArray(value))
            answers[key] = value.filter((v): v is string => typeof v === "string");
        }
        if (Object.keys(answers).length === 0)
          return fail("What's the answer?", "answers required");
        result = { action: "answer", answers };
      }
      // Read before answering: the questions are gone once the ask closes.
      const spoken = result.action === "answer" ? answerInWords(result.answers, port.askQuestions?.(item.sessionId, item.requestId)) : "";
      if (!port.answerAsk(item.sessionId, item.requestId, result)) return gone();
      port.mark?.(item.sessionId, result.action === "cancel" ? { kind: "note", text: "Question dismissed" } : { kind: "pew", text: spoken });
      return out({ ok: true, say: result.action === "cancel" ? "Dismissed." : "Answered." });
    }

    case "decide_plan": {
      const item = findItem(port.items(), args.item_id);
      if (!item || item.kind !== "plan") return gone();
      const action = args.action;
      if (action !== "accept" && action !== "feedback" && action !== "reject") {
        return fail("Accept, feedback, or reject?", "bad action");
      }
      const feedback =
        typeof args.feedback === "string" && args.feedback.trim()
          ? args.feedback.trim()
          : undefined;
      if (action === "feedback" && !feedback) return fail("What feedback?", "feedback required");
      port.decidePlan(item.sessionId, action, Number(item.requestId), feedback);
      port.mark?.(item.sessionId, {
        kind: "note",
        text: action === "accept" ? "Plan accepted" : action === "reject" ? "Plan rejected" : "Feedback sent",
      });
      return out({
        ok: true,
        say:
          action === "accept"
            ? "Plan accepted."
            : action === "reject"
              ? "Plan rejected."
              : "Feedback sent.",
      });
    }

    case "tell_agent": {
      const said = typeof args.session_id === "string" ? args.session_id : "";
      const sessionId = resolveSession(said, port.statuses()) ?? said;
      const raw = typeof args.text === "string" ? args.text.trim() : "";
      const { text, asked } = withoutCallback(raw);
      if (!text) return fail("What should I tell it?", "text required");
      const sent = port.tellAgent(sessionId, text);
      if (!sent.ok) return fail("That session isn't open.", "unknown session");
      port.mark?.(sessionId, { kind: "pew", text });
      return out({
        ok: true,
        queued: sent.queued === true,
        say: sent.queued ? "Queued." : "Sent.",
        // "…and call me back" belongs to Pew, not the agent: taken out of the
        // message, and Pew reminded to book it (when it hasn't already).
        ...(asked ? { note: "Their call-me-back was left out of the agent's message: book it with call_me_back (when_done) if you haven't." } : {}),
      });
    }

    case "get_status": {
      const said = typeof args.session_id === "string" && args.session_id ? args.session_id : undefined;
      const sessionId = said ? (resolveSession(said, port.statuses()) ?? said) : undefined;
      const statuses = port.statuses(sessionId);
      if (sessionId && statuses.length > 0) port.mark?.(sessionId);
      const working = statuses.filter((status) => status.working).length;
      const items = port.items();
      return out({
        ok: true,
        sessions: statuses.map((status) => {
          const waits = items.filter((item) => item.sessionId === status.sessionId).map((item) => `${item.kind}: ${item.title}`);
          return {
            session_id: status.sessionId,
            ...(status.folder ? { folder: status.folder } : {}),
            ...(status.agentName ? { agent: status.agentName } : {}),
            state: waits.length > 0 ? "waiting on you" : status.working ? "working" : "idle (its turn is done)",
            ...(status.working && status.activity ? { doing_now: status.activity } : {}),
            last_reply: status.lastLines,
            ...(waits.length > 0 ? { waiting_on_you: waits } : {}),
          };
        }),
        say:
          statuses.length === 0
            ? "No agents running."
            : `${working} of ${statuses.length} working.`,
      });
    }

    case "call_me_back": {
      // "Call me back when it's done": wait for that session, not a clock.
      const waitFor = typeof args.when_done === "string" && args.when_done ? args.when_done : undefined;
      if (waitFor && port.callWhenDone) {
        const statuses = port.statuses();
        const id = resolveSession(waitFor, statuses);
        const status = statuses.find((s) => s.sessionId === id);
        if (!status) return out({ ok: false, error: "unknown session", say: `I can't find ${waitFor}. Which one?` });
        const name = status.folder ?? status.agentName ?? "it";
        port.callWhenDone(status.sessionId, status.folder);
        return out({ ok: true, when_done: name, say: `I'll call when ${name} is done.` }, true);
      }
      // Seconds win when given ("in 30 seconds"); half a minute at the least.
      const seconds = Number(args.seconds);
      const asked = Number.isFinite(seconds) && seconds > 0 ? seconds / 60 : Number(args.minutes) || 15;
      const minutes = Math.min(240, Math.max(0.5, Math.round(asked * 2) / 2));
      port.callMeBack(minutes);
      const when = minutes < 1 ? `${Math.round(minutes * 60)} seconds` : `${minutes} minute${minutes === 1 ? "" : "s"}`;
      return out({ ok: true, minutes, say: `Talk in ${when}.` }, true);
    }

    case "set_ring": {
      const said = typeof args.session_id === "string" ? args.session_id : "";
      const sessionId = resolveSession(said, port.statuses()) ?? said;
      const on = args.on === true;
      if (!port.setRing) return fail("I can't change that from here.", "set_ring unsupported");
      if (!port.statuses(sessionId).some((status) => status.sessionId === sessionId)) {
        return fail("That session isn't open.", "unknown session");
      }
      const { ringing } = port.setRing(sessionId, on);
      port.mark?.(sessionId, { kind: "note", text: on ? "Rings you when it needs you" : "Won't ring you" });
      const say = !on
        ? "Okay, it won't ring you."
        : ringing
          ? "Okay, I'll ring you when it needs you."
          : "Okay. Ring me is off in the app though; turn it on for calls.";
      return out({ ok: true, on, ringing, say });
    }

    case "end_call":
      return out({ ok: true, say: "Bye." }, true);

    default:
      return fail("I can't do that.", `unknown tool '${name}'`);
  }
}
