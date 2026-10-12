/**
 * What the voice screen says about the conversation, derived from the machine
 * phase plus a little context. Pure: `now` is injected.
 */
import type { MachineState } from "./voiceMachine";
import type { TranscriptLine } from "./transcript";
import type { VoiceStore } from "./voiceStore";

export type StatusKey =
  | "idle"
  | "connecting"
  | "listening"
  | "thinking"
  | "speaking"
  | "dispatching"
  | "reconnecting"
  | "paused"
  | "ending"
  | "ended"
  | "error";

export type OrbMode = "connecting" | "listening" | "composing" | "working";

export interface Status {
  key: StatusKey;
  label: string;
  detail?: string;
  orb?: OrbMode;
  /** Offer a retry button. */
  retry: boolean;
}

/** A task event this recent means work is being handed to an agent right now. */
export const DISPATCH_WINDOW_MS = 4_000;

const ERROR_TEXT: Record<string, string> = {
  mic_denied: "Microphone access is off. Allow it in Settings, then try again.",
  offline: "Can't reach your computer. Check it is running and connected.",
  old_daemon: "Your computer needs a newer pew2 to use voice. Update it, then try again.",
  unavailable: "Voice isn't set up on your computer yet.",
  failed: "The voice connection failed.",
};

export function friendlyError(machine: Pick<MachineState, "errorCode" | "message">): string {
  return (machine.errorCode && ERROR_TEXT[machine.errorCode]) || machine.message || "Voice is unavailable right now.";
}

export function voiceStatus(
  machine: MachineState,
  store: VoiceStore,
  transcript: readonly TranscriptLine[],
  now: number,
): Status {
  switch (machine.phase) {
    case "idle":
      return { key: "idle", label: "Ready", detail: "Tap Talk to start.", retry: false };
    case "opening":
    case "connecting":
      return { key: "connecting", label: "Connecting…", orb: "connecting", retry: false };
    case "reconnecting":
      return { key: "reconnecting", label: "Reconnecting…", detail: "The connection dropped. Trying again.", orb: "connecting", retry: false };
    case "interrupted":
      return { key: "paused", label: "Paused", detail: "A call or alert interrupted voice.", retry: true };
    case "closing":
      return { key: "ending", label: "Ending…", retry: false };
    case "closed":
      return { key: "ended", label: "Conversation ended", retry: true };
    case "error":
      return { key: "error", label: "Voice unavailable", detail: friendlyError(machine), retry: machine.errorCode !== "old_daemon" };
    case "speaking":
      return { key: "speaking", label: "Speaking", orb: "composing", retry: false };
    case "listening": {
      const last = store.recent[store.recent.length - 1];
      if (last && now - last.at <= DISPATCH_WINDOW_MS && (last.kind === "task.queued" || last.kind === "task.started")) {
        return { key: "dispatching", label: "Sending to your agent…", detail: last.projectName, orb: "working", retry: false };
      }
      if (transcript[transcript.length - 1]?.role === "user") {
        return { key: "thinking", label: "Thinking…", orb: "working", retry: false };
      }
      return { key: "listening", label: "Listening", orb: "listening", retry: false };
    }
  }
}
