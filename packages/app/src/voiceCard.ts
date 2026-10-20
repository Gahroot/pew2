/**
 * The card a call puts on screen: a question or an approval from any session,
 * shown with the app's own sheets while Pew reads it out, so the user can tap
 * the answer, or say it and watch Pew's pick land on the card before it goes.
 *
 * Pure (no Expo): which item gets the card, what Pew's in-flight tool picked,
 * and the line Pew is told when the user taps instead of speaking. The sheets
 * and the timing live in `ui/CallScreen.tsx`.
 */
import type { CallState, VoiceInboxItem } from "./voiceCall";
import { EMPTY_DRAFT, optionValue, pickOption, questionOptions, typeOther, type AskDraft, type AskQuestion, type AskResult } from "./askUser";
import { isDenyApprovalOption, selectApprovalOptions } from "./approvalOptions";

/** An inbox item the call can draw: a question with its questions, or an approval with its choices. */
export type CardItem = VoiceInboxItem & ({ kind: "question"; questions: AskQuestion[] } | { kind: "approval"; options: NonNullable<VoiceInboxItem["options"]> });

/** Whether the daemon sent enough to draw this item (an older one sends titles only). */
export function isCardItem(item: VoiceInboxItem): item is CardItem {
  if (item.kind === "question") return (item.questions?.length ?? 0) > 0;
  if (item.kind === "approval") return (item.options?.length ?? 0) > 0;
  return false;
}

/** The answering tool in flight for an item, with its parsed arguments. */
function answeringTool(call: Pick<CallState, "tools">, itemId: string): { name: string; args: Record<string, unknown> } | undefined {
  for (const tool of call.tools) {
    if (tool.name !== "answer_question" && tool.name !== "answer_permission") continue;
    let args: unknown;
    try {
      args = JSON.parse(tool.arguments);
    } catch {
      continue;
    }
    if (typeof args === "object" && args !== null && (args as { item_id?: unknown }).item_id === itemId) {
      return { name: tool.name, args: args as Record<string, unknown> };
    }
  }
  return undefined;
}

/**
 * Which item gets the card: the one Pew is answering right now, else the
 * call's focus ("Talk it through"), else the oldest waiting. Oldest first is
 * also the order Pew is told to take them in, so the card and the voice stay
 * on the same item. `hidden` holds ids the user put away this call.
 */
export function cardFor(call: Pick<CallState, "inbox" | "tools" | "focus">, hidden: ReadonlySet<string>): CardItem | undefined {
  const open = (call.inbox ?? []).filter(isCardItem);
  const answering = open.find((item) => answeringTool(call, item.id));
  if (answering) return answering;
  const focus = open.find((item) => item.id === call.focus && !hidden.has(item.id));
  if (focus) return focus;
  return open.find((item) => !hidden.has(item.id));
}

/**
 * The card a lane can bring back: that session's oldest drawable item the
 * user put away. Undefined when there is none (nothing waits, or it is
 * already on screen), so the lane is only tappable when a tap does something.
 */
export function reopenable(inbox: readonly VoiceInboxItem[] | undefined, sessionId: string, hidden: ReadonlySet<string>): string | undefined {
  return (inbox ?? []).find((item) => item.sessionId === sessionId && isCardItem(item) && hidden.has(item.id))?.id;
}

/** What Pew's in-flight tool is choosing on this card: a question's draft, or an approval's option. */
export interface VoicePick {
  draft?: AskDraft;
  optionId?: string;
}

/**
 * A question's draft from Pew's `answers`. An answer matching an option's
 * value or label (any case) picks that option; anything else is typed into
 * "your own answer", exactly as the user would have.
 */
export function draftFromAnswers(questions: readonly AskQuestion[], answers: unknown): AskDraft {
  let draft = EMPTY_DRAFT;
  if (typeof answers !== "object" || answers === null) return draft;
  const given = answers as Record<string, unknown>;
  for (const question of questions) {
    const raw = given[question.id];
    const values = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
    const typed: string[] = [];
    for (const value of values) {
      if (typeof value !== "string" || !value.trim()) continue;
      const want = value.trim().toLowerCase();
      const option = questionOptions(question).find(
        (o) => optionValue(o).toLowerCase() === want || o.label.toLowerCase() === want,
      );
      if (option) draft = pickOption(draft, question, optionValue(option));
      else typed.push(value.trim());
    }
    if (typed.length > 0) draft = typeOther(draft, question, typed.join(", "));
  }
  return draft;
}

/**
 * The option an approval decision lands on, the way the daemon picks it:
 * allow is allow-once only (never "always"), deny is reject-once first.
 */
export function optionForDecision(options: NonNullable<VoiceInboxItem["options"]>, decision: unknown): string | undefined {
  if (decision !== "allow" && decision !== "deny") return undefined;
  const byKind = (kind: string) => options.find((o) => o.kind === kind)?.optionId;
  if (decision === "allow") {
    return byKind("allow_once") ?? selectApprovalOptions(options).find((o) => !isDenyApprovalOption(o))?.optionId;
  }
  return byKind("reject_once") ?? byKind("reject_always") ?? selectApprovalOptions(options).find(isDenyApprovalOption)?.optionId;
}

/** What Pew is choosing on `item`, while its tool is in flight; undefined otherwise. */
export function voicePick(call: Pick<CallState, "tools">, item: CardItem): VoicePick | undefined {
  const tool = answeringTool(call, item.id);
  if (!tool) return undefined;
  if (item.kind === "question" && tool.name === "answer_question") {
    return tool.args.cancel === true ? undefined : { draft: draftFromAnswers(item.questions, tool.args.answers) };
  }
  if (item.kind === "approval" && tool.name === "answer_permission") {
    const optionId = optionForDecision(item.options, tool.args.decision);
    return optionId ? { optionId } : undefined;
  }
  return undefined;
}

function where(item: VoiceInboxItem): string {
  return item.folder ? `${item.folder}'s` : "the";
}

/** The system line Pew gets when the user answered a question by tapping. */
export function tappedAnswerText(item: CardItem & { kind: "question" }, result: AskResult): string {
  if (result.action === "cancel") return `The user dismissed ${where(item)} question on screen (item_id ${item.id}). Skip it; don't ask again.`;
  const parts = item.questions.map((question) => {
    const answer = result.answers[question.id];
    const values = Array.isArray(answer) ? answer : answer === undefined ? [] : [answer];
    const words = values.map((value) => questionOptions(question).find((o) => optionValue(o) === value)?.label ?? value);
    return words.join(", ");
  });
  return `The user answered ${where(item)} question on screen (item_id ${item.id}): ${parts.filter(Boolean).join("; ")}. It is sent; confirm in a few words and move on.`;
}

/** The system line Pew gets when the user tapped an approval's button. */
export function tappedApprovalText(item: CardItem & { kind: "approval" }, optionId: string): string {
  const option = item.options.find((o) => o.optionId === optionId);
  const choice = option?.name ?? optionId;
  return `The user tapped "${choice}" on screen for ${where(item)} request: ${item.title} (item_id ${item.id}). It is sent; confirm in a few words and move on.`;
}
