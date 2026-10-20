/**
 * Voice task wire messages (app <-> daemon).
 *
 * Architectural rule: the coding agent owns execution. The daemon owns
 * orchestration and persistent state. The phone shows the tasks.
 *
 * The call itself (`voice.session`, `voice.tool`, `voice.end`, `voice.note`)
 * is in `wire.ts`; a call's task tools ride on it. What is here is the task
 * list every screen shares: `voice.state` (catch-up, also sent after `hello`),
 * `voice.event` (one orchestration event), `voice.dismiss`/`voice.dismissed`,
 * and the screenshots held for tasks (`voice.attach`, `voice.detach`,
 * `voice.send`).
 *
 * Everything here is additive and optional: an older daemon answers
 * `unknown_message`, and an older app never sends these. Do NOT bump
 * WIRE_VERSION.
 */
import { z } from "zod";

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

/**
 * How far an EZ Coder goal run has got, read from ezcoder's own durable goal
 * state (`~/.ezcoder/goals/projects/<hash>/goals.json`). A goal is not one
 * agent turn: it keeps going across turns until its verifier and final audit
 * pass, so a finished turn says nothing about whether the goal is done.
 *
 * Every string is already speakable (no paths, ids or code). Evidence, not a
 * verdict: `status: "passed"` is what the agent recorded.
 */
export const VoiceGoalProgress = z.object({
  /** ezcoder's goal run id, once the run exists. */
  runId: z.string().optional(),
  title: z.string().optional(),
  /** The run's own status: draft, blocked, ready, running, verifying, passed, failed, paused. */
  status: z.string().optional(),
  /** Milestones finished (or criteria with evidence, when the run has no milestones). */
  done: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  /**
   * What `done`/`total` count. Absent (an older daemon) means milestones.
   * "criteria" is a run with no milestones: its success criteria are met all
   * together or not yet, so a partial count is never claimed.
   */
  unit: z.enum(["milestones", "criteria"]).optional(),
  /** The milestone being worked now, when one is. */
  active: z.string().optional(),
  /** The verifier's last result, when fresh. */
  verified: z.enum(["pass", "fail", "none"]).optional(),
  /** What the user has to do or supply, when anything. */
  needsYou: z.string().optional(),
  /** The next step, as ezcoder's own goal controller would pick it. */
  next: z.string().optional(),
  /** One spoken paragraph covering all of the above. */
  say: z.string().optional(),
});
export type VoiceGoalProgress = z.output<typeof VoiceGoalProgress>;

/** An open question the agent asked (its `ask_user` tool), waiting on the user. */
export const VoiceQuestion = z.object({
  requestId: z.string(),
  /** Speakable question text. */
  text: z.string(),
  /** Option labels, when it offered choices. */
  options: z.array(z.string()).optional(),
});
export type VoiceQuestion = z.output<typeof VoiceQuestion>;

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
  /** Set on a task that runs an EZ Coder goal. Absent for an ordinary task and from older daemons. */
  goal: VoiceGoalProgress.optional(),
  /** An open question from the agent. Absent when none, and from older daemons. */
  question: VoiceQuestion.optional(),
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
  /** What changed in a goal run, on events a goal task emits. Absent otherwise and from older daemons. */
  goal: z
    .object({
      runId: z.string().optional(),
      change: z.enum([
        "setup",
        "milestone_done",
        "milestone_failed",
        "verifier_pass",
        "verifier_fail",
        "needs_you",
        "passed",
        "failed",
        "stalled",
      ]),
    })
    .optional(),
});
export type VoiceEvent = z.output<typeof VoiceEvent>;
export type VoiceGoalChange = NonNullable<VoiceEvent["goal"]>["change"];

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
  /**
   * What happened since the user last listened, counted, plus the sentence the
   * model opens with. `say` is absent when nothing is worth saying. The whole
   * field is absent from older daemons.
   */
  checkin: z
    .object({
      say: z.string().optional(),
      finished: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
      needsYou: z.number().int().nonnegative(),
      milestones: z.number().int().nonnegative(),
      /** DAVE projects with a new top recommendation, by name only. */
      dave: z.array(z.string()),
    })
    .optional(),
});
export type VoiceSnapshot = z.output<typeof VoiceSnapshot>;

// ---- app -> daemon ---------------------------------------------------------

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

/**
 * App -> daemon. Send a held screenshot to a task from the Tasks screen, with
 * what to do with it: the same work as the `attach_screenshot` task tool,
 * without a call. Answered to the sender with `voice.sent`; the task's events
 * and the screenshot list are broadcast as usual.
 */
export const VoiceSend = z.object({
  t: z.literal("voice.send"),
  requestId: z.string().min(1).max(100),
  attachmentId: z.string().min(1).max(40),
  taskId: z.string().min(1).max(40),
  instruction: z.string().min(1).max(2000).optional(),
});

/** Catch-up after a reconnect: "I have events up to N; send the rest + a snapshot". */
export const VoiceSync = z.object({
  t: z.literal("voice.sync"),
  since: z.number().int().nonnegative().default(0),
});

// ---- daemon -> app ---------------------------------------------------------

/** Reply to `voice.attach`. */
export const VoiceAttached = z.object({
  t: z.literal("voice.attached"),
  requestId: z.string(),
  ok: z.boolean(),
  attachment: VoiceAttachment.optional(),
  /** Plain words, for the phone to show, when `ok` is false. */
  error: z.string().optional(),
});

/** Reply to `voice.send`. `error` is plain words for the phone when `ok` is false. */
export const VoiceSent = z.object({
  t: z.literal("voice.sent"),
  requestId: z.string(),
  ok: z.boolean(),
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

export const VoiceClientMessages = [VoiceSync, VoiceAttach, VoiceDetach, VoiceDismiss, VoiceSend] as const;
export const VoiceServerMessages = [
  VoiceSent,
  VoiceEventMessage,
  VoiceState,
  VoiceAttached,
  VoiceAttachments,
  VoiceDismissed,
] as const;
