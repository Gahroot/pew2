/**
 * Screenshots shared with voice, as the phone shows them.
 *
 * The flow this serves: a partner sends a fix as a picture, the user shares it
 * here, and it should end up in front of the coding agent with as little
 * ceremony as possible — while the user can always see where it is and where
 * it went. So a screenshot is one card that moves through three states:
 *
 *   uploading  →  held (on the computer, not sent yet)  →  sent to a task
 *
 * with "failed" as the way out of the first, carrying a reason to show.
 *
 * The daemon's list (`voice.attachments`) is the authority on what is held and
 * where each went; uploads in flight exist only here, until their answer comes
 * back. Pure, so `bun test` can load it; `voiceController.ts` does the wiring.
 */
import type { VoiceTask } from "./types";

/** A screenshot as the daemon reports it. Mirrors `wire.VoiceAttachment`. */
export interface HeldScreenshot {
  attachmentId: string;
  name: string;
  mimeType: string;
  size: number;
  at: number;
  sentTo: string[];
}

/** An upload the daemon has not answered yet, or refused. */
export interface Upload {
  requestId: string;
  name: string;
  /** On this phone, for the thumbnail. */
  localUri?: string;
  status: "uploading" | "failed";
  error?: string;
  at: number;
}

export interface ScreenshotCard {
  /** Stable across the upload → held hand-over, so the card does not remount. */
  key: string;
  attachmentId?: string;
  name: string;
  localUri?: string;
  status: "uploading" | "failed" | "held" | "sent";
  error?: string;
  /** Tasks it went to, newest last, by title. */
  sentTo: { taskId: string; title: string }[];
}

/** Cards shown at once; older ones stay on the computer and in `list_screenshots`. */
export const MAX_CARDS = 4;

/** Only the fields we understand, and only when they are the right shape. */
export function readHeld(raw: unknown): HeldScreenshot[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: HeldScreenshot[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const { attachmentId, name, mimeType, size, at, sentTo } = item as Record<string, unknown>;
    if (typeof attachmentId !== "string" || typeof name !== "string") continue;
    out.push({
      attachmentId,
      name,
      mimeType: typeof mimeType === "string" ? mimeType : "image/png",
      size: typeof size === "number" ? size : 0,
      at: typeof at === "number" ? at : 0,
      sentTo: Array.isArray(sentTo) ? sentTo.filter((id): id is string => typeof id === "string") : [],
    });
  }
  return out;
}

/**
 * Newest first: uploads still in flight or refused, then what the computer
 * holds. `localUris` remembers which phone file became which attachment, so a
 * held card keeps its thumbnail without the bytes ever coming back down.
 */
export function screenshotCards(
  uploads: readonly Upload[],
  held: readonly HeldScreenshot[],
  localUris: Readonly<Record<string, { localUri?: string; key: string }>>,
  tasks: Readonly<Record<string, Pick<VoiceTask, "taskId" | "title">>>,
): ScreenshotCard[] {
  const fromUploads = uploads.map(
    (u): ScreenshotCard & { at: number } => ({
      key: u.requestId,
      name: u.name,
      ...(u.localUri ? { localUri: u.localUri } : null),
      status: u.status,
      ...(u.error ? { error: u.error } : null),
      sentTo: [],
      at: u.at,
    }),
  );
  const fromHeld = held.map((h): ScreenshotCard & { at: number } => {
    const local = localUris[h.attachmentId];
    return {
      key: local?.key ?? h.attachmentId,
      attachmentId: h.attachmentId,
      name: h.name,
      ...(local?.localUri ? { localUri: local.localUri } : null),
      status: h.sentTo.length > 0 ? "sent" : "held",
      sentTo: h.sentTo.map((taskId) => ({ taskId, title: tasks[taskId]?.title ?? "a task" })),
      at: h.at,
    };
  });
  return [...fromUploads, ...fromHeld]
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_CARDS)
    .map(({ at: _at, ...card }) => card);
}

const TERMINAL = new Set<VoiceTask["state"]>(["completed", "verified", "failed", "cancelled"]);

/**
 * The task a "Send to …" button can offer without guessing: the one task
 * still active, or — when nothing is — the most recent one that finished,
 * which a follow-up reopens. Several active tasks is a real choice, so it is
 * left to the user to say which, out loud or by naming it.
 */
export function sendTarget(tasks: Readonly<Record<string, VoiceTask>>): VoiceTask | undefined {
  const all = Object.values(tasks);
  const active = all.filter((t) => !TERMINAL.has(t.state));
  if (active.length === 1) return active[0];
  if (active.length > 1) return undefined;
  return all
    .filter((t) => t.state !== "cancelled")
    .sort((a, b) => b.updatedAt - a.updatedAt || a.taskId.localeCompare(b.taskId))[0];
}

/**
 * What the voice model is told when one arrives mid-conversation. It never
 * sees the picture (everything given to the model is redacted text), so this
 * is what lets it say "got it" and ask where it goes.
 */
export function arrivalNote(shot: Pick<HeldScreenshot, "attachmentId" | "name">): string {
  return [
    `[Screenshot] The user just shared a screenshot "${shot.name}" (attachmentId ${shot.attachmentId}).`,
    "Say you have it in a few words. Unless they already said where it goes, ask which project or task it is for, then send it with start_task or follow_up attachmentIds, or attach_screenshot.",
  ].join("\n");
}

/** And when the user sends it from the sheet themselves, so the model is not surprised. */
export function sentNote(shot: Pick<HeldScreenshot, "attachmentId" | "name">, task: Pick<VoiceTask, "taskId" | "title">): string {
  return `[Screenshot] The user sent "${shot.name}" (attachmentId ${shot.attachmentId}) to task ${task.taskId}, "${task.title}", from the screen. Acknowledge it briefly; do not send it again.`;
}
