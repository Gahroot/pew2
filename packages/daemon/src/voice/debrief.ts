/**
 * What a finished agent turn amounted to, and the one next step worth offering.
 *
 * The voice model is the user's partner, so a completion has to come with
 * something to say beyond "it finished". This reads the evidence the session
 * already carried (tool calls, their status, the agent's closing message) and
 * turns it into a Ken-style verdict: the agent asked something, a check
 * failed, edits were never checked, edits were checked, or nothing changed.
 *
 * Deterministic and offline on purpose: no second model call, no network, no
 * cost, and nothing here may claim the work is right. `checks: "ran"` means a
 * check ran and the agent reported no failure — the voice rules forbid saying
 * "tests pass" on that alone.
 */
import { speakable } from "./safety.js";
import type { VoiceDebrief } from "./types.js";

/** One ACP tool call as the debrief needs it. */
export interface TurnStep {
  kind?: string;
  /** A test, lint or typecheck run. */
  check: boolean;
  status?: string;
}

const EDIT_KINDS = new Set(["edit", "delete", "move"]);

/** Commands whose result says something about whether the change works. */
const CHECK_COMMAND =
  /\b(?:tests?|specs?|vitest|jest|pytest|mocha|rspec|phpunit|lint|eslint|biome|ruff|typecheck|tsc|mypy|clippy|cargo\s+(?:test|check|clippy)|go\s+(?:test|vet))\b/i;

export function isCheckCommand(text: string | undefined): boolean {
  return text !== undefined && CHECK_COMMAND.test(text);
}

/** The agent ended its turn by handing a question back to the user. */
export function asksUser(text: string | undefined): boolean {
  if (!text) return false;
  const tail = text.trim().slice(-400);
  if (/\?\s*\**\s*$/.test(tail)) return true;
  return /\b(?:would you like|do you want|should I|shall I|want me to|let me know (?:if|whether|which|how))\b/i.test(tail);
}

/**
 * Collects the steps of one task's turn, keyed by ACP `toolCallId` so a
 * `tool_call_update` lands on the call it belongs to.
 */
export class TurnEvidence {
  private readonly steps = new Map<string, TurnStep>();
  private anonymous = 0;

  /** Feed an ACP `tool_call` or `tool_call_update`. Anything else is ignored. */
  record(update: {
    sessionUpdate?: string;
    toolCallId?: unknown;
    kind?: unknown;
    title?: unknown;
    status?: unknown;
    rawInput?: unknown;
  }): void {
    if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") return;
    const given = typeof update.toolCallId === "string" && update.toolCallId ? update.toolCallId : undefined;
    // An update with no id cannot be matched to its call.
    if (!given && update.sessionUpdate === "tool_call_update") return;
    const id = given ?? `#${++this.anonymous}`;
    const prior = this.steps.get(id);
    const kind = typeof update.kind === "string" ? update.kind : prior?.kind;
    const command =
      typeof update.rawInput === "object" && update.rawInput !== null
        ? (update.rawInput as { command?: unknown }).command
        : undefined;
    const label = [update.title, Array.isArray(command) ? command.join(" ") : command]
      .filter((x): x is string => typeof x === "string")
      .join(" ");
    this.steps.set(id, {
      kind,
      check: (prior?.check ?? false) || ((kind === "execute" || kind === undefined) && isCheckCommand(label)),
      status: typeof update.status === "string" ? update.status : prior?.status,
    });
  }

  list(): TurnStep[] {
    return [...this.steps.values()];
  }
}

export interface DebriefInput {
  /** The agent's closing text for the turn. */
  lastText?: string;
  steps: readonly TurnStep[];
}

export function buildDebrief(input: DebriefInput): VoiceDebrief {
  const edits = input.steps.filter((s) => s.kind !== undefined && EDIT_KINDS.has(s.kind)).length;
  const commands = input.steps.filter((s) => s.kind === "execute").length;
  const checkRuns = input.steps.filter((s) => s.check);
  const last = checkRuns[checkRuns.length - 1];
  const checks: VoiceDebrief["checks"] = !last ? "none" : last.status === "failed" ? "failed" : "ran";
  const said = speakable(input.lastText, 500) || undefined;
  const base = { ...(said ? { said } : null), edits, commands, checks };

  // The agent's own question outranks anything inferred: it is waiting on the user.
  if (asksUser(input.lastText)) return { outcome: "question", ...base };
  if (checks === "failed") {
    return {
      outcome: "checks_failed",
      ...base,
      nextStep: "Have it fix what's failing?",
      followUp: "The last check you ran failed. Find the cause, fix it, rerun the check and report the result.",
    };
  }
  if (edits > 0 && checks === "none") {
    return {
      outcome: "unchecked_edits",
      ...base,
      nextStep: "Have it run the tests on that?",
      followUp: "Run the project's tests and checks against these changes, fix anything that fails, and report the result.",
    };
  }
  if (edits > 0) {
    return {
      outcome: "checked_edits",
      ...base,
      nextStep: "Want it to commit that?",
      followUp: "Commit these changes with a clear message. Do not push.",
    };
  }
  return { outcome: "no_changes", ...base };
}
