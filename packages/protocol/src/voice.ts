/**
 * Voice orchestration wire messages (app <-> daemon).
 *
 * Architectural rule: EZCODER owns execution. The daemon owns orchestration and
 * persistent state. GPT Realtime is a temporary conversational controller. The
 * phone owns native audio + notifications.
 *
 * Shape of a voice session:
 *   1. app  -> `voice.open`        (activation source, optional focus)
 *   2. daemon -> `voice.ready`     (ephemeral OpenAI Realtime secret + instructions +
 *                                   tool definitions + a compact context snapshot)
 *   3. app connects to OpenAI Realtime directly with that secret. Every function call
 *      the model makes is forwarded verbatim as `voice.tool`; the daemon executes it
 *      and answers `voice.tool.result`. The app never interprets tool names.
 *   4. app  -> `voice.close`       (decisions persisted by the daemon, audio restored)
 *
 * The OpenAI API key never leaves the daemon; only a short-lived secret does.
 *
 * Everything here is additive and optional: an older daemon answers
 * `unknown_message` (the app then says voice needs a newer pew2 on the computer),
 * and an older app never sends these. Do NOT bump WIRE_VERSION.
 */
import { z } from "zod";

/** How the user got into voice. Drives the opening context, never permissions. */
export const VoiceSource = z.enum([
  "airpods",
  "action_button",
  "siri_shortcut",
  "notification",
  "in_app",
  "lock_screen",
]);
export type VoiceSource = z.output<typeof VoiceSource>;

/** Lifecycle of a task, as the user and the model both talk about it. */
export const TaskState = z.enum([
  "queued",
  "running",
  "paused",
  "blocked", // waiting on an approval or a decision
  "failed",
  "completed", // agent says it finished
  "verified", // a check (tests/build) or the user confirmed the result
  "cancelled",
]);
export type TaskState = z.output<typeof TaskState>;

/** What a callback is worth interrupting for. */
export const EventClass = z.enum(["informational", "completed", "blocked", "approval"]);
export type EventClass = z.output<typeof EventClass>;

/** Risk tier of an operation; higher tiers need explicit spoken or tapped approval. */
export const RiskLevel = z.enum(["read", "edit", "shell", "merge", "deploy", "destructive"]);
export type RiskLevel = z.output<typeof RiskLevel>;

/** One task, as shown on screen and summarised to the model. */
export const VoiceTask = z.object({
  taskId: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  /** The daemon session running it, once it has one. */
  sessionId: z.string().optional(),
  title: z.string(),
  state: TaskState,
  priority: z.number().int().default(0),
  /** One-line current activity ("editing App.tsx", "running tests"). */
  activity: z.string().optional(),
  /** Open approval, if blocked on one. */
  approval: z
    .object({
      requestId: z.string(),
      risk: RiskLevel,
      summary: z.string(),
    })
    .optional(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type VoiceTask = z.output<typeof VoiceTask>;

/** Registry entry: a project the user can name aloud. */
export const VoiceProject = z.object({
  projectId: z.string(),
  name: z.string(),
  path: z.string(),
  aliases: z.array(z.string()).default([]),
  providerId: z.string().optional(),
});
export type VoiceProject = z.output<typeof VoiceProject>;

/**
 * An orchestration event. `eventId` is a gapless, daemon-assigned, monotonic
 * integer persisted across restarts, so clients replay from a cursor and
 * deduplicate by id.
 */
export const VoiceEvent = z.object({
  eventId: z.number().int().nonnegative(),
  taskId: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  kind: z.enum([
    "task.queued",
    "task.started",
    "task.progress",
    "task.tool",
    "task.approval",
    "task.blocked",
    "task.completed",
    "task.failed",
    "task.cancelled",
    "task.verified",
    "task.paused",
    "task.resumed",
  ]),
  class: EventClass,
  /** Short, speakable, secret-free text. Never raw logs or source. */
  text: z.string(),
  at: z.number().int(),
});
export type VoiceEvent = z.output<typeof VoiceEvent>;

/** Compact state the model starts a fresh session with. Keep it small. */
export const VoiceSnapshot = z.object({
  /** Highest eventId included. */
  eventId: z.number().int().nonnegative(),
  projects: z.array(VoiceProject),
  tasks: z.array(VoiceTask),
  /** Events the user has not heard yet, newest last (already batched). */
  unheard: z.array(VoiceEvent).default([]),
  /** A line about why this session started, e.g. "Opened from a notification: pew2 finished". */
  opening: z.string().optional(),
});
export type VoiceSnapshot = z.output<typeof VoiceSnapshot>;

// ---- app -> daemon ---------------------------------------------------------

export const VoiceOpen = z.object({
  t: z.literal("voice.open"),
  /** App-chosen id for this voice session; the daemon echoes it. */
  voiceSessionId: z.string().min(1),
  source: VoiceSource,
  /** Notification tap: the event / task that caused it. */
  focusEventId: z.number().int().nonnegative().optional(),
  focusTaskId: z.string().optional(),
});

export const VoiceToolCall = z.object({
  t: z.literal("voice.tool"),
  voiceSessionId: z.string().min(1),
  /** The Realtime `call_id`. The daemon dedupes on it, so a retry never re-executes. */
  callId: z.string().min(1),
  name: z.string().min(1),
  /** The model's JSON arguments, already parsed. */
  args: z.record(z.string(), z.unknown()).default({}),
});

export const VoiceClose = z.object({
  t: z.literal("voice.close"),
  voiceSessionId: z.string().min(1),
  reason: z.enum(["user", "model", "idle", "interrupted", "error", "app_background"]),
  /** Highest eventId the user actually heard, so unheard ones are re-offered. */
  heardEventId: z.number().int().nonnegative().optional(),
});

/** Catch-up after a reconnect: "I have events up to N; send the rest + a snapshot". */
export const VoiceSync = z.object({
  t: z.literal("voice.sync"),
  since: z.number().int().nonnegative().default(0),
});

// ---- daemon -> app ---------------------------------------------------------

export const VoiceReady = z.object({
  t: z.literal("voice.ready"),
  voiceSessionId: z.string(),
  realtime: z.object({
    /** Ephemeral client secret for OpenAI Realtime. */
    secret: z.string(),
    /** Epoch seconds. */
    expiresAt: z.number().int(),
    model: z.string(),
    voice: z.string().optional(),
    /** Full session config to apply: instructions, tools, turn detection. Passed through opaquely. */
    session: z.record(z.string(), z.unknown()),
  }),
  snapshot: VoiceSnapshot,
});

/** Refusal, e.g. no OpenAI key on the daemon. `code` is stable for the app to branch on. */
export const VoiceUnavailable = z.object({
  t: z.literal("voice.unavailable"),
  voiceSessionId: z.string().optional(),
  code: z.enum(["no_api_key", "mint_failed", "busy", "disabled"]),
  message: z.string(),
});

export const VoiceToolResult = z.object({
  t: z.literal("voice.tool.result"),
  voiceSessionId: z.string(),
  callId: z.string(),
  ok: z.boolean(),
  /** JSON-serialisable result handed back to the model as the function output. */
  output: z.unknown(),
  error: z.string().optional(),
  /** True when the app should end the voice session after the model finishes speaking. */
  endSession: z.boolean().optional(),
});

/** Broadcast: one orchestration event. Same stream drives UI, voice and push. */
export const VoiceEventMessage = z.object({
  t: z.literal("voice.event"),
  event: VoiceEvent,
  /** The task as it stands after this event, so the UI needs no second lookup. */
  task: VoiceTask.optional(),
});

/** Reply to `voice.sync` (and sent after `hello`): missed events plus a snapshot. */
export const VoiceState = z.object({
  t: z.literal("voice.state"),
  snapshot: VoiceSnapshot,
  events: z.array(VoiceEvent).default([]),
});

export const VoiceClientMessages = [VoiceOpen, VoiceToolCall, VoiceClose, VoiceSync] as const;
export const VoiceServerMessages = [
  VoiceReady,
  VoiceUnavailable,
  VoiceToolResult,
  VoiceEventMessage,
  VoiceState,
] as const;

/**
 * Data payload of the push that reopens voice. `type` is the discriminator the app's
 * notification response handler keys on.
 */
export const VoiceCallbackPush = z.object({
  type: z.literal("voice.callback"),
  eventId: z.number().int().nonnegative(),
  taskId: z.string(),
  projectId: z.string(),
  class: EventClass,
});
export type VoiceCallbackPush = z.output<typeof VoiceCallbackPush>;
