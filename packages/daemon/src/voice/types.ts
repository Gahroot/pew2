/** Voice wire types, re-exported flat: `@pew2/protocol` only exposes them under `wire`. */
import type { wire } from "@pew2/protocol";

export type EventClass = wire.EventClass;
export type RiskLevel = wire.RiskLevel;
export type TaskState = wire.TaskState;
export type VoiceEvent = wire.VoiceEvent;
export type VoiceProject = wire.VoiceProject;
export type VoiceSnapshot = wire.VoiceSnapshot;
export type VoiceTask = wire.VoiceTask;
export type VoiceDebrief = wire.VoiceDebrief;
export type VoiceRepo = wire.VoiceRepo;
export type VoiceAttachment = wire.VoiceAttachment;

/** A conversation this daemon holds open, as the voice model may hear of it. */
export interface RunningSession {
  sessionId: string;
  providerId: string;
  agentName?: string;
  cwd: string;
  /** Same three states the sidebar draws: a turn in flight, blocked on the user, or at rest. */
  state: "working" | "needs_you" | "idle";
  /** Milliseconds since it was last used; lets the model say "just now". */
  idleMs: number;
  /** Who holds it: the daemon ("pew2") or an agent started in a terminal on the computer ("desktop"). Absent means "pew2". */
  origin?: "pew2" | "desktop";
  /** The conversation's own title, when the agent recorded one. Untrusted text. */
  title?: string;
  /** The tool the agent is running now, in plain words, when known. */
  tool?: string;
}

/** What one open conversation is doing right now, for `peek_session`. All untrusted text. */
export interface SessionPeek {
  lastPrompt?: string;
  latest?: string;
  tool?: string;
}
