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

/**
 * What a finished turn amounted to, read from the tool calls the agent made,
 * plus the one next step worth offering. Evidence, never a verdict on whether
 * the work is right: `checks: "ran"` means a check ran and the agent reported
 * no failure, not that it passed.
 */
export const VoiceDebrief = z.object({
  outcome: z.enum(["question", "checks_failed", "unchecked_edits", "checked_edits", "no_changes"]),
  /** The agent's closing message, speakable. */
  said: z.string().optional(),
  /** Edit, delete and move steps. */
  edits: z.number().int().nonnegative(),
  /** Shell steps of any kind. */
  commands: z.number().int().nonnegative(),
  checks: z.enum(["none", "ran", "failed"]),
  /** A yes/no offer to speak, e.g. "Have it run the tests?". */
  nextStep: z.string().optional(),
  /** The instruction to send with `follow_up` if the user accepts `nextStep`. */
  followUp: z.string().optional(),
});
export type VoiceDebrief = z.output<typeof VoiceDebrief>;

/** One task, as shown on screen and summarised to the model. */
/**
 * The repository a worktree belongs to, as a task or event carries it.
 *
 * ezcoder runs work in `~/.ezcoder/worktrees/<repo>/ez-<id>`, a second checkout
 * of the repo on its own branch. Reported by directory, every one of those is a
 * project nobody has heard of; this is what lets a client and the voice model
 * say "black-mountain-fund, on fix/login" instead.
 */
export const VoiceRepo = z.object({
  /** The main checkout's projectId; absent when it is not known. */
  projectId: z.string().optional(),
  /** The repository's folder name: what people call the project. */
  name: z.string(),
  /** The worktree's branch, or its folder when HEAD is detached. */
  branch: z.string().optional(),
});
export type VoiceRepo = z.output<typeof VoiceRepo>;

/**
 * A screenshot the user handed to voice, as clients and the model see it.
 *
 * The bytes go up once (`voice.attach`) and live on the computer; after that
 * everything refers to the id. Never a path: the model is not given paths, and
 * a client has no use for one on another machine's disk.
 */
export const VoiceAttachment = z.object({
  attachmentId: z.string(),
  /** Display name, as the phone named it. */
  name: z.string(),
  mimeType: z.string(),
  size: z.number().int().nonnegative(),
  /** Epoch ms it arrived. */
  at: z.number().int(),
  /** Tasks it has been sent to, oldest first. Empty until it is. */
  sentTo: z.array(z.string()).default([]),
});
export type VoiceAttachment = z.output<typeof VoiceAttachment>;

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
  /** Set when the agent's turn ends. Absent from older daemons. */
  debrief: VoiceDebrief.optional(),
  /** Screenshots sent to this task's agent, by id. Absent when none, and from older daemons. */
  attachmentIds: z.array(z.string()).optional(),
  /**
   * Set when the task runs in a linked git worktree: the repository it belongs
   * to, so a client lists it under that repo as a branch rather than as a
   * project of its own. Absent for an ordinary checkout and from older daemons.
   */
  repo: VoiceRepo.optional(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type VoiceTask = z.output<typeof VoiceTask>;

/**
 * Set on a registry entry that is a linked git worktree. `repoId` is the
 * projectId of the repository's main checkout, so work in a worktree can be
 * grouped with the repo the user names. Ids only — never a path.
 */
export const VoiceWorktree = z.object({
  repo: z.string(),
  /** Absent for a worktree of a bare repository, which has no main checkout. */
  repoId: z.string().optional(),
  branch: z.string().optional(),
});
export type VoiceWorktree = z.output<typeof VoiceWorktree>;

/** Registry entry: a project the user can name aloud. */
export const VoiceProject = z.object({
  projectId: z.string(),
  name: z.string(),
  path: z.string(),
  aliases: z.array(z.string()).default([]),
  providerId: z.string().optional(),
  /** Absent for an ordinary checkout, and from older daemons. */
  worktree: VoiceWorktree.optional(),
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
  /** The task's repository when it runs on a worktree branch; see `VoiceRepo`. */
  repo: VoiceRepo.optional(),
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
  /**
   * Capability marker: this app decides barge-in itself (`app/src/voice/realtime.ts`:
   * it answers only once a transcript holds real words). Only then may the daemon turn
   * the server's own interrupt/auto-response off. Absent means an older app, which
   * relies on the server answering and interrupting, so it gets the old behaviour.
   */
  clientVad: z.boolean().optional(),
});

/**
 * App -> daemon. Hand a screenshot to voice: a partner's fix, an error on
 * screen. Stored on the computer and answered with `voice.attached`; from then
 * on the model and the app refer to it by `attachmentId`.
 *
 * Images only, inside the same per-file ceiling as a prompt's attachments
 * (`MAX_ATTACHMENT_BYTES`), so one frame stays under the relay's limit.
 */
export const VoiceAttach = z.object({
  t: z.literal("voice.attach"),
  /** Echoed on the answer, so the phone can match it to the card it is showing. */
  requestId: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
  mimeType: z.string().min(1).max(100),
  /** Base64, no `data:` prefix. */
  data: z.string().min(1),
});

/** App -> daemon. Discard a screenshot that has not been wanted after all. */
export const VoiceDetach = z.object({
  t: z.literal("voice.detach"),
  attachmentId: z.string().min(1).max(40),
});

/**
 * App -> daemon. Clear finished tasks off every screen once they have been read.
 *
 * Only finished tasks (completed, verified, failed, cancelled) are dismissed;
 * anything still live is ignored, so a stale tap can never hide work in
 * progress. A dismissed task is still on the computer (the model can be asked
 * about it), it is just left out of snapshots, and any new event for it brings
 * it back. Answered by a `voice.dismissed` broadcast.
 */
export const VoiceDismiss = z.object({
  t: z.literal("voice.dismiss"),
  taskIds: z.array(z.string().min(1).max(40)).max(200).default([]),
  /** Every finished task in these projects, worktrees of them included. */
  projectIds: z.array(z.string().min(1).max(80)).max(50).optional(),
  /** Every finished task. */
  allFinished: z.boolean().optional(),
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
  /** True when the app should open its photo picker: the model asked for a screenshot. */
  openPicker: z.boolean().optional(),
});

/** Reply to `voice.attach`. */
export const VoiceAttached = z.object({
  t: z.literal("voice.attached"),
  requestId: z.string(),
  ok: z.boolean(),
  attachment: VoiceAttachment.optional(),
  /** Plain words, for the phone to show, when `ok` is false. */
  error: z.string().optional(),
});

/** Broadcast: every screenshot voice is holding, after any change to them. */
export const VoiceAttachments = z.object({
  t: z.literal("voice.attachments"),
  attachments: z.array(VoiceAttachment),
});

/** Broadcast: the tasks a `voice.dismiss` cleared, so every client drops them. */
export const VoiceDismissed = z.object({
  t: z.literal("voice.dismissed"),
  taskIds: z.array(z.string()),
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
  /** Screenshots held for voice. Absent from older daemons, so absent is not "none". */
  attachments: z.array(VoiceAttachment).optional(),
  /**
   * Dismissed tasks that still have events in the daemon's log, so a client
   * that missed the `voice.dismissed` broadcast drops what it kept of them.
   * Present (even empty) only from a daemon that understands `voice.dismiss`:
   * absent means an older one, and the app then offers no dismiss button.
   */
  dismissed: z.array(z.string()).optional(),
});

export const VoiceClientMessages = [VoiceOpen, VoiceToolCall, VoiceClose, VoiceSync, VoiceAttach, VoiceDetach, VoiceDismiss] as const;
export const VoiceServerMessages = [
  VoiceReady,
  VoiceUnavailable,
  VoiceToolResult,
  VoiceEventMessage,
  VoiceState,
  VoiceAttached,
  VoiceAttachments,
  VoiceDismissed,
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

/**
 * Payload of the push that rings the phone's native call screen (CallKit on
 * iOS via a VoIP push, Telecom on Android via a data-only push). Carries the
 * same focus fields as `VoiceCallbackPush`, so answering opens voice exactly
 * where tapping the banner would.
 *
 * `callId` is a UUID because CallKit and Telecom key every call by one.
 * `caller` is what the system call screen shows: like every push string it is
 * readable by Apple/Google, so it is the short place title, never agent text.
 */
export const VoiceCallPush = z.object({
  type: z.literal("voice.call"),
  callId: z.string().uuid(),
  caller: z.string().min(1).max(80),
  eventId: z.number().int().nonnegative(),
  taskId: z.string(),
  projectId: z.string(),
  class: EventClass,
});
export type VoiceCallPush = z.output<typeof VoiceCallPush>;
