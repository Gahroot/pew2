/**
 * What a live voice call hears when a conversation at the computer (one the
 * daemon does not hold) starts or finishes. Pure, so `bun test` can load it.
 */
import type { DeskEntry } from "../deskActivity";

const keyOf = (e: DeskEntry) => `${e.providerId}\u0000${e.agentSessionId}`;

function folderOf(cwd: string): string {
  const parts = cwd.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

export function desktopActivityNotes(
  prev: readonly DeskEntry[],
  next: readonly DeskEntry[],
  agentName: (providerId: string) => string | undefined,
): string[] {
  const before = new Map(prev.map((e) => [keyOf(e), e]));
  const after = new Map(next.map((e) => [keyOf(e), e]));
  const name = (e: DeskEntry) => agentName(e.providerId) || e.providerId;
  const notes: string[] = [];
  for (const [key, e] of after) {
    const was = before.get(key);
    if (e.state === "working" && was?.state !== "working") {
      const title = e.title?.trim();
      notes.push(
        `[Update] ${name(e)} in ${folderOf(e.cwd)} started working at the computer${title ? `: ${title}` : ""}.`,
      );
    } else if (e.state === "idle" && was?.state === "working") {
      notes.push(finished(name(e), e.cwd));
    }
  }
  for (const [key, was] of before) {
    if (was.state === "working" && !after.has(key)) notes.push(finished(name(was), was.cwd));
  }
  return notes;
}

const finished = (agent: string, cwd: string) =>
  `[Update] ${agent} in ${folderOf(cwd)} at the computer finished its turn. Tell the user briefly; call peek_session if they want detail.`;
