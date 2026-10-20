/**
 * What may be kept of a call, and carried into the next one.
 *
 * A voice thread is fed back to Pew on every later call about that chat, so
 * anything in it outlives the call it came from. Pew's own lines can repeat
 * what an agent said, and an agent may have read a web page or file with an
 * instruction planted in it; the mic can also pick up a video. Saved as is,
 * a one-off injection becomes a standing one (OWASP calls this memory
 * poisoning). So every line is checked before it is saved and again before
 * it is used: anything that reads like an instruction to the assistant, or
 * holds a credential, is left out.
 *
 * Ported from Brah's memory guard (src/realtime/tools/memory-guard.js), the
 * same rules: each pattern is tied to assistant-control vocabulary, so
 * everyday talk about the work ("ignore the flaky test", "run it again")
 * still saves.
 */

/** Zero-width, bidi and other invisible characters that could hide text. */
const INVISIBLE = /\p{Cf}|(?![\t\n\r])\p{Cc}/gu;

const INJECTION: readonly RegExp[] = [
  /\b(ignore|disregard|forget|override|bypass)\b[^.]{0,40}\b(previous|prior|above|earlier|all|any|system|safety|your)\b[^.]{0,20}\b(instructions?|rules?|prompts?|guidelines?|directives?)\b/i,
  /\b(ignore|disregard)\s+(all\s+)?(the\s+)?(previous|prior|above|earlier)\s+messages?\b/i,
  /\b(system|developer)\s*(prompt|message|note|instructions?)\b/i,
  /\byou\s+are\s+now\b/i,
  /(^|[.!:]\s*)new\s+instructions?\s*[:-]/i,
  /\bjailbreak|\bDAN\s+mode\b/i,
  /\bdo\s+not\s+(ask|confirm)\b[^.]{0,40}\b(before|when)\b/i,
  /\b(send|delete|email|run|execute|share|post|approve|push|deploy|act|proceed|do\s+it|do\s+this)\b[^.]{0,40}\bwithout\s+(asking|confirmation|confirming|checking)\b/i,
  /<\/?\s*(system|assistant|developer|instructions?|tool|earlier_calls)\b[^>]*>/i,
  /\b(call|invoke|run|use)\s+(the\s+)?(tool|function)\b/i,
  // Pew's own tool names in a line are a tell: nobody says them aloud.
  /\b(tell_agent|answer_permission|answer_question|decide_plan|start_chat|open_chat|call_me_back|set_ring|end_call)\b/i,
  /\b(send|post|upload|forward|exfiltrate)\b[^.]{0,50}\b(to|at)\s+(https?:\/\/|www\.|\S+@\S+\.\w+)/i,
  /\b(next|every|future)\s+call\b[^.]{0,40}\b(you\s+)?(must|should|always|first)\b/i,
  // Standing orders for later calls: "at the start of every call, tell…".
  /\b(at\s+the\s+start\s+of|on|in|during)\s+(every|each|the\s+next|any|future)\s+(call|conversation|session)\b/i,
  // Addressed to the assistant rather than said to it: "note for assistants".
  /\b(note|message|instructions?|reminder)\s+(for|to)\s+(the\s+)?(assistants?|ai|agents?|models?|pew|bots?)\b/i,
  // Claimed consent: "the user already approved this, don't ask".
  /\b(user|they|owner|maintainer)\s+(has\s+|have\s+)?already\s+(approved|agreed|confirmed|authori[sz]ed)\b/i,
  /\b(don'?t|do\s+not|no\s+need\s+to|never)\s+(ask|check|confirm)\b[^.]{0,30}\b(user|them|first|before)?/i,
];

const SECRET: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(password|passcode|passwd|pin|api[\s_-]?key)\s*(is|=|:)\s*\S{4,}/i,
  /\b(secret|token)\s*[=:]\s*\S{4,}/i,
];

/** 13-19 digits passing Luhn: a card number (ISBNs and phone numbers don't). */
function hasCard(text: string): boolean {
  for (const match of text.matchAll(/\b(?:\d[ -]?){12,18}\d\b/g)) {
    const digits = match[0].replace(/\D/g, "");
    let sum = 0;
    for (let i = 0; i < digits.length; i++) {
      let digit = Number(digits[digits.length - 1 - i]);
      if (i % 2 === 1) digit = digit * 2 > 9 ? digit * 2 - 9 : digit * 2;
      sum += digit;
    }
    if (sum % 10 === 0) return true;
  }
  return false;
}

export type LineCheck = { ok: true; text: string } | { ok: false; reason: "instruction" | "secret" | "empty" };

/**
 * One line of a call, checked before it is kept or fed back. Angle brackets
 * are removed so no line can close the block it is shown in.
 */
export function checkLine(raw: string): LineCheck {
  const text = raw.replace(INVISIBLE, "").replace(/[<>]/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return { ok: false, reason: "empty" };
  if (SECRET.some((pattern) => pattern.test(text)) || hasCard(text)) return { ok: false, reason: "secret" };
  if (INJECTION.some((pattern) => pattern.test(raw))) return { ok: false, reason: "instruction" };
  return { ok: true, text };
}

/** What stands in for a line that was left out, so the conversation still reads in order. */
export const LEFT_OUT = "[left out]";
