/**
 * The last few spoken lines, for the voice screen. Pure; held by the controller,
 * never persisted or replayed (the daemon rebuilds context on every open).
 */
export type TranscriptRole = "user" | "assistant";

export interface TranscriptLine {
  id: number;
  role: TranscriptRole;
  text: string;
}

export const TRANSCRIPT_LIMIT = 6;
const MAX_LINE = 400;

/** Appends a finished utterance; blank text is ignored, the oldest lines fall off. */
export function appendLine(lines: readonly TranscriptLine[], role: TranscriptRole, raw: string): TranscriptLine[] {
  const text = raw.replace(/\s+/g, " ").trim();
  if (!text) return lines as TranscriptLine[];
  const id = (lines[lines.length - 1]?.id ?? 0) + 1;
  const clipped = text.length > MAX_LINE ? `${text.slice(0, MAX_LINE - 1)}…` : text;
  const next = [...lines, { id, role, text: clipped }];
  return next.length > TRANSCRIPT_LIMIT ? next.slice(next.length - TRANSCRIPT_LIMIT) : next;
}
