/**
 * What an agent said and is doing, read from its session log, in plain text
 * (no markdown marks) for Pew to speak and the call screen to show.
 */
import { plainText, type wire } from "@pew2/protocol";
import { deriveLines } from "./board.js";

/**
 * The last few lines the agent said, newest last: agent text since the most
 * recent user turn, read back from the end of the log.
 */
export function lastAgentLines(events: readonly wire.SessionEvent[], max = 3): string[] {
  const parts: string[] = [];
  let scanned = 0;
  for (let index = events.length - 1; index >= 0 && scanned < 400; index -= 1, scanned += 1) {
    const update = (events[index]?.payload as { update?: { sessionUpdate?: unknown; content?: unknown } } | null)
      ?.update;
    if (update?.sessionUpdate === "user_message_chunk" && parts.length > 0) break;
    if (update?.sessionUpdate !== "agent_message_chunk") continue;
    const content = update.content;
    const text = Array.isArray(content)
      ? content.map((block: { type?: unknown; text?: unknown }) => (block?.type === "text" && typeof block.text === "string" ? block.text : "")).join("")
      : typeof (content as { text?: unknown } | null)?.text === "string"
        ? ((content as { text: string }).text)
        : "";
    parts.push(text);
    if (parts.join("").length > 2000) break;
  }
  return parts
    .reverse()
    .join("")
    .split("\n")
    .map((line) => plainText(line).replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0)
    .slice(-max)
    .map((line) => (line.length > 200 ? `${line.slice(0, 199)}…` : line));
}

/**
 * What a working agent is doing right now, in a few words: its latest tool
 * ("Edit checkout/cart.tsx") or, between tools, its latest line. Undefined
 * when nothing in the log says.
 */
export function currentActivity(events: readonly wire.SessionEvent[]): string | undefined {
  const last = deriveLines(events).at(-1);
  if (!last) return undefined;
  if (last.kind === "tool") return last.text;
  if (last.kind === "result") return `Finished ${last.text}`;
  return last.text;
}
