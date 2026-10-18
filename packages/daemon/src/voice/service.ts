/**
 * The voice feature as one object the Daemon owns.
 *
 * Wires the pure modules together: store (state), orchestrator (dispatch),
 * registry (names), batcher (what is worth a push), mint (Realtime secret) and
 * the tool executor. `handler.ts` talks only to this, so both transports get
 * identical behaviour.
 */
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { buildCheckin, type Checkin } from "./checkin.js";
import { EventBatcher } from "./classify.js";
import { buildSnapshot } from "./context.js";
import { daveChanges, daveCheckinEnabled, daveDigest, type DaveDigest } from "./dave.js";
import { focusContext, noteEvent } from "./focus.js";
import { GoalTracker, goalHooks, goalRunsBase } from "./goalRuns.js";
import { Orchestrator, type PromptImage, type VoiceHost } from "./dispatcher.js";
import { AccountAuth, type VoiceAccount } from "./accountAuth.js";
import type { VoiceAccountStatus } from "../../../protocol/src/voice.js";
import {
  DEFAULT_MODEL,
  DEFAULT_VOICE,
  mintRealtimeSecret,
  readVoicePrefs,
  MINT_MESSAGES,
  type VoicePrefs,
} from "./mint.js";
import { addAlias, buildRegistry, readAliases, repoForPath, repoOf } from "./registry.js";
import { DEFAULT_APPROVAL_POLICY, speakable, type ApprovalPolicy } from "./safety.js";
import {
  MAX_EVENTS,
  TERMINAL,
  toVoiceTask,
  VoiceStore,
  type CheckinState,
  type StoredScreenshot,
  type StoredTask,
} from "./store.js";
import { projectForPath, realtimeSession, ToolExecutor, VOICE_INSTRUCTIONS } from "./tools.js";
import type {
  RunningSession,
  VoiceAttachment,
  VoiceEvent,
  VoiceProject,
  VoiceSnapshot,
} from "./types.js";
import {
  detectWorktree,
  privacyGuarded,
  registeredWorktrees,
  type RegisteredWorktree,
  type WorktreeInfo,
} from "../worktree.js";
import type { CreatedWorktree, Result } from "../worktree-create.js";
import { placeSpoken } from "./place.js";
import {
  checkScreenshot,
  deleteScreenshot,
  MAX_SCREENSHOTS,
  readScreenshot,
  SCREENSHOT_TTL_MS,
  writeScreenshot,
} from "./screenshots.js";

export interface VoiceServiceDeps {
  dataDir: string;
  env: NodeJS.ProcessEnv;
  host: VoiceHost;
  /** Broadcast to every connected client on every transport. */
  emit: (message: unknown) => void;
  /** Project paths the daemon knows (known-projects + agent history). */
  projectPaths: () => Promise<string[]>;
  providerForPath?: (path: string) => string | undefined;
  /** Which of those paths are linked git worktrees; defaults to reading `.git`. */
  detectWorktree?: (path: string) => Promise<WorktreeInfo | undefined>;
  /** Linked worktrees git has on record for a main checkout; defaults to reading `.git/worktrees`. */
  registeredWorktrees?: (root: string) => Promise<RegisteredWorktree[]>;
  /** Make a new worktree of a main checkout and publish its path; absent means voice cannot. */
  createWorktree?: (root: string, branch?: string) => Promise<Result<CreatedWorktree>>;
  usableProviders: () => string[];
  /** Conversations the daemon holds open, whoever started them. */
  runningSessions?: () => import("./types.js").RunningSession[];
  /** What one open conversation is doing now; backs `peek_session`. */
  peekSession?: (sessionId: string) => import("./types.js").SessionPeek | undefined;
  lastUsedProvider?: () => string | undefined;
  /** Send a push for an event that is worth one. Never awaited by the service. */
  push?: (event: VoiceEvent) => void | Promise<void>;
  fetch?: typeof fetch;
  /** Explicit daemon-owned account; injectable without reading CLI credentials. */
  account?: VoiceAccount;
  /**
   * DAVE: asked from its tools, plus one read of its focus list when a voice
   * session opens, for the check-in (`PEW2_DAVE_CHECKIN=off` stops that read).
   * Absent when turned off.
   */
  dave?: import("./dave.js").DaveClient;
  /** Where EZ Coder keeps goal runs; defaults to `goalRunsBase(env, homedir())`. */
  goalRunsBase?: string;
  now?: () => number;
  /** Background tick interval; 0 disables it (tests). */
  tickMs?: number;
}

export interface OpenRequest {
  voiceSessionId: string;
  source: string;
  focusEventId?: number;
  focusTaskId?: string;
  /** Optional on arrival: absent means an app that predates client-side barge-in. */
  clientVad?: boolean;
}

const PROJECT_TTL_MS = 30_000;
/** Check-ins held for sessions not yet closed. */
const MAX_PENDING_CHECKINS = 8;
/** Events that change what "that" means: results and questions, never chatter. */
const FOCUS_EVENTS: ReadonlySet<VoiceEvent["kind"]> = new Set([
  "task.completed",
  "task.failed",
  "task.verified",
  "task.blocked",
]);

export class VoiceService {
  readonly store: VoiceStore;
  readonly orchestrator: Orchestrator;
  readonly tools: ToolExecutor;
  private readonly batcher = new EventBatcher();
  private readonly open_ = new Set<string>();
  private projectCache: { at: number; list: VoiceProject[] } | undefined;
  private timer?: ReturnType<typeof setInterval>;
  private readonly now: () => number;
  /** Applies while a voice session is open; reset to the default each time one opens. */
  private approvalPolicy: ApprovalPolicy = DEFAULT_APPROVAL_POLICY;
  /** Where goal runs are read from; nothing in voice ever writes there. */
  private readonly goalBase: string;
  private readonly goalTracker = new GoalTracker();
  private readonly stopping = new AbortController();
  private accountEpoch = 0;
  private minting = new AbortController();
  /** What each open session's check-in covered, saved once the user has heard it (`close`). */
  private readonly checkins = new Map<string, CheckinState>();

  private constructor(
    private readonly deps: VoiceServiceDeps,
    store: VoiceStore,
    readonly account: VoiceAccount,
  ) {
    this.now = deps.now ?? Date.now;
    this.store = store;
    this.goalBase = deps.goalRunsBase ?? goalRunsBase(deps.env, homedir());
    this.orchestrator = new Orchestrator(store, deps.host, {
      now: this.now,
      readAttachments: (ids) => this.readScreenshots(ids),
      goals: goalHooks({ base: this.goalBase, now: this.now }),
    });
    this.tools = new ToolExecutor({
      store,
      orchestrator: this.orchestrator,
      projects: () => this.projects(true),
      usableProviders: deps.usableProviders,
      runningSessions: deps.runningSessions,
      peekSession: deps.peekSession,
      lastUsedProvider: deps.lastUsedProvider,
      dave: deps.dave,
      goalRunsBase: this.goalBase,
      now: this.now,
      approvalPolicy: {
        get: () => this.approvalPolicy,
        set: (p) => void (this.approvalPolicy = p),
      },
      registeredWorktrees: deps.registeredWorktrees ?? registeredWorktrees,
      ...(deps.createWorktree
        ? {
            createWorktree: async (root: string, branch?: string) => {
              const made = await deps.createWorktree?.(root, branch);
              // The next list_projects must already know the branch.
              this.projectCache = undefined;
              return made ?? { ok: false as const, error: "Worktrees cannot be made here." };
            },
          }
        : null),
      rememberAlias: async (path, alias) => {
        await addAlias(deps.dataDir, path, alias);
        this.projectCache = undefined;
      },
    });
    // Hands-free auto-approval only runs while someone is on a voice session.
    this.orchestrator.autoApprove = () =>
      this.open_.size > 0 && this.approvalPolicy.autoApproveSafe;
    store.subscribe((event, task) => this.onEvent(event, task));
  }

  static async create(deps: VoiceServiceDeps): Promise<VoiceService> {
    const store = await VoiceStore.open(join(deps.dataDir, "voice-state.json"), deps.now);
    const account =
      deps.account ??
      (await AccountAuth.create({
        dataDir: deps.dataDir,
        fetch: deps.fetch,
        now: deps.now,
        probe: async (accessToken, signal) => {
          const prefs = await readVoicePrefs(deps.dataDir);
          const result = await mintRealtimeSecret({
            accessToken,
            session: {},
            model: prefs.model,
            fetch: deps.fetch,
            signal,
          });
          // Only readiness escapes; the probe's ephemeral secret is discarded.
          return result.ok ? { ok: true } : { ok: false, code: result.code };
        },
      }));
    const service = new VoiceService(deps, store, account);
    service.orchestrator.reconcile();
    await service.backfillRepos().catch(() => undefined);
    await service.pruneScreenshots();
    const tickMs = deps.tickMs ?? 5_000;
    if (tickMs > 0) {
      service.timer = setInterval(() => service.tick(), tickMs);
      service.timer.unref?.();
    }
    return service;
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.stopping.abort();
    this.accountEpoch++;
    this.minting.abort();
    this.account.dispose();
  }

  /** Rotation/unpair invalidates pending authorization, not coding-agent login. */
  invalidateAccount() {
    this.account.invalidate();
    this.endAccountVoice();
  }

  private endAccountVoice() {
    this.accountEpoch++;
    this.minting.abort();
    this.minting = new AbortController();
    for (const voiceSessionId of this.open_) {
      this.deps.emit({
        t: "voice.unavailable",
        voiceSessionId,
        code: "account-required",
        message: MINT_MESSAGES["account-required"],
      });
    }
    this.open_.clear();
    this.checkins.clear();
    this.approvalPolicy = DEFAULT_APPROVAL_POLICY;
  }

  async accountRequest(
    message: {
      t:
        | "voice.account.status"
        | "voice.account.connect"
        | "voice.account.cancel"
        | "voice.account.disconnect";
      requestId: string;
      attemptId?: string;
    },
    owner: string,
  ): Promise<VoiceAccountStatus> {
    let status;
    switch (message.t) {
      case "voice.account.status":
        status = await this.account.status(owner, message.attemptId);
        break;
      case "voice.account.connect":
        status = await this.account.connect(owner);
        break;
      case "voice.account.cancel":
        status = await this.account.cancel(owner, message.attemptId ?? "");
        break;
      case "voice.account.disconnect": {
        // Invalidation inside disconnect happens before its first await.
        const removing = this.account.disconnect();
        this.endAccountVoice();
        status = await removing;
        break;
      }
    }
    return { t: "voice.account.state", requestId: message.requestId, supported: true, ...status };
  }

  tick() {
    this.orchestrator.tick();
    // Goal milestones land in goals.json mid-turn; a stat per live goal task
    // until the file moves. Its events go through the batcher like any other.
    void this.pollGoals();
    for (const event of this.batcher.due(this.now())) this.pushIfIdle(event);
  }

  /** Read live goal tasks' runs once (never overlapping). Resolves with the events emitted; never throws. */
  pollGoals(): Promise<number> {
    if (this.stopping.signal.aborted) return Promise.resolve(0);
    return this.goalTracker.poll(this.store, this.goalBase, this.stopping.signal).catch(() => 0);
  }

  /**
   * File tasks saved before repositories were tracked under their repository.
   *
   * Read from each task's own `cwd` rather than the registry, because the
   * checkout may since have been deleted and dropped from it — and that is
   * exactly the finished work someone asks about ("what got done in
   * black-mountain-fund?"). Runs at startup only; new tasks record theirs.
   */
  async backfillRepos(): Promise<number> {
    const missing = this.store.tasks().filter((t) => !t.repo);
    if (missing.length === 0) return 0;
    const detect = this.deps.detectWorktree ?? ((path: string) => detectWorktree(path));
    const found = new Map<string, WorktreeInfo>();
    await Promise.all(
      [...new Set(missing.map((t) => t.cwd))].map(async (cwd) => {
        const info = await detect(cwd).catch(() => undefined);
        if (info) found.set(cwd, info);
      }),
    );
    if (found.size === 0) return 0;
    const projects = await this.projects();
    return this.store.backfillRepos((task) => repoForPath(task.cwd, found.get(task.cwd), projects));
  }

  /** Registry, refreshed when older than the TTL or when `fresh` is asked for. */
  async projects(fresh = false): Promise<VoiceProject[]> {
    const cached = this.projectCache;
    if (cached && (!fresh || this.now() - cached.at < PROJECT_TTL_MS)) return cached.list;
    const [paths, aliases] = await Promise.all([
      this.deps.projectPaths().catch(() => [] as string[]),
      readAliases(this.deps.dataDir),
    ]);
    const detect = this.deps.detectWorktree ?? ((path: string) => detectWorktree(path));
    const worktrees = new Map<string, WorktreeInfo>();
    await Promise.all(
      paths.map(async (path) => {
        const info = await detect(path).catch(() => undefined);
        if (info) worktrees.set(path, info);
      }),
    );
    const all = [...paths, ...(await this.siblingWorktrees(paths, worktrees))];
    const list = buildRegistry(all, aliases, this.deps.providerForPath, (path) =>
      worktrees.get(path),
    );
    this.projectCache = { at: this.now(), list };
    return list;
  }

  /**
   * Worktrees of the known repositories that no agent history mentions yet.
   *
   * History only holds checkouts an agent ran in through this machine's ACP
   * view; ezcoder makes a copy per task, often from its own CLI or app, and
   * each one the phone has not seen would otherwise be missing from its repo
   * (or, once seen, a stranger). Read from `.git/worktrees`, so no spawn, and
   * `worktrees` is filled in for each, so they are filed under their repo.
   * Deleted ones are skipped: nothing can start in them. A main checkout in a
   * macOS-guarded folder is skipped too, as in `detectWorktree`.
   */
  private async siblingWorktrees(
    paths: readonly string[],
    worktrees: Map<string, WorktreeInfo>,
  ): Promise<string[]> {
    const known = new Set(paths);
    const roots = new Set<string>();
    for (const path of paths) {
      const info = worktrees.get(path);
      const root = info ? info.root : path;
      if (root && !privacyGuarded(root)) roots.add(root);
    }
    const read = this.deps.registeredWorktrees ?? registeredWorktrees;
    const extra: string[] = [];
    for (const root of [...roots].sort()) {
      const listed = await read(root).catch(() => [] as RegisteredWorktree[]);
      for (const entry of listed) {
        if (entry.gone || known.has(entry.path)) continue;
        known.add(entry.path);
        extra.push(entry.path);
        worktrees.set(entry.path, {
          repo: basename(root),
          root,
          ...(entry.branch ? { branch: entry.branch } : null),
        });
      }
    }
    return extra;
  }

  private onEvent(event: VoiceEvent, task: StoredTask) {
    this.deps.emit({ t: "voice.event", event, task: toVoiceTask(task) });
    // A result or a question is what "that" means next; chatter is not.
    if (FOCUS_EVENTS.has(event.kind) || event.goal?.change === "needs_you") {
      this.store.setFocusRefs(noteEvent(this.store.focusRefs(), event, task));
    }
    for (const ready of this.batcher.add(event, this.now())) this.pushIfIdle(ready);
  }

  /** No push while a voice session is open: the user is already hearing it. */
  private pushIfIdle(event: VoiceEvent) {
    // Chatter is never worth a banner; the batcher still drains it so it cannot pile up.
    if (event.class === "informational") return;
    if (this.open_.size > 0 || !this.deps.push) return;
    try {
      void Promise.resolve(this.deps.push(event)).catch(() => {});
    } catch {
      // Push is best effort.
    }
  }

  async snapshot(request?: Partial<OpenRequest>): Promise<VoiceSnapshot> {
    const focusEvent =
      request?.focusEventId !== undefined
        ? this.store
            .eventsSince(request.focusEventId - 1, 1)
            .find((e) => e.eventId === request.focusEventId)
        : undefined;
    // What the user cleared stays on disk but out of every opening picture.
    const shown = (e: VoiceEvent) => this.store.getTask(e.taskId)?.dismissedAt === undefined;
    return buildSnapshot({
      projects: await this.projects(),
      tasks: this.store.tasks().filter((t) => t.dismissedAt === undefined),
      events: this.store.eventsSince(this.store.heardEventId, 200).filter(shown),
      lastEventId: this.store.lastEventId,
      heardEventId: this.store.heardEventId,
      source: request?.source,
      focusTaskId: request?.focusTaskId ?? focusEvent?.taskId,
      focusEvent,
    });
  }

  async open(request: OpenRequest): Promise<Record<string, unknown>> {
    const epoch = this.accountEpoch;
    const prefs = await readVoicePrefs(this.deps.dataDir);
    if (prefs.enabled === false) {
      return {
        t: "voice.unavailable",
        voiceSessionId: request.voiceSessionId,
        code: "disabled",
        message: "Voice is turned off on this computer.",
      };
    }
    // The one unprompted contact with DAVE: a single read of its focus list for
    // the check-in, started first so it overlaps everything below. Loopback,
    // GET-only, 1.5 s, project names only, and silent on any failure.
    const dave =
      this.deps.dave && daveCheckinEnabled(this.deps.env)
        ? daveDigest(this.deps.dave)
        : Promise.resolve(undefined);
    // Fresh registry, and goal runs as they are on disk, before the model speaks.
    const [projects] = await Promise.all([this.projects(true), this.pollGoals()]);
    const live = this.deps.runningSessions?.() ?? [];
    const desk = deskContext(live, projects);
    const snapshot = await this.snapshot(request);
    const voice = prefs.voice ?? DEFAULT_VOICE;
    const context = `${VOICE_INSTRUCTIONS}\n\nContext now:\n${contextText(snapshot)}${desk ? `\n\n${desk}` : ""}`;
    const config = (instructions: string) =>
      realtimeSession({
        voice,
        clientVad: request.clientVad === true,
        backlogTools: !!this.deps.dave,
        instructions,
      });
    // The secret is minted while DAVE answers, so the check-in adds no wait.
    // The app applies the returned `session` verbatim with `session.update`
    // (every app since voice shipped), which is what carries the check-in.
    const [minted, digest] = await Promise.all([this.mint(prefs, config(context)), dave]);
    if (!minted.ok) {
      return {
        t: "voice.unavailable",
        voiceSessionId: request.voiceSessionId,
        code: minted.code,
        message: minted.message,
      };
    }
    if (epoch !== this.accountEpoch || this.stopping.signal.aborted) {
      return {
        t: "voice.unavailable",
        voiceSessionId: request.voiceSessionId,
        code: "account-required",
        message: MINT_MESSAGES["account-required"],
      };
    }
    const { checkin, covered } = this.checkin(snapshot.eventId, live, digest);
    const memory = focusContext(this.store.focusRefs(), this.store.tasks(), this.now());
    const session = config(
      [context, checkin.say ? `Check-in: ${checkin.say}` : "", memory].filter(Boolean).join("\n\n"),
    );
    if (this.open_.size === 0) this.approvalPolicy = DEFAULT_APPROVAL_POLICY;
    this.open_.add(request.voiceSessionId);
    this.checkins.set(request.voiceSessionId, covered);
    // A session that never closed (the app died) must not pin its entry for ever.
    for (const id of this.checkins.keys())
      if (this.checkins.size > MAX_PENDING_CHECKINS) this.checkins.delete(id);
    return {
      t: "voice.ready",
      voiceSessionId: request.voiceSessionId,
      realtime: {
        secret: minted.secret,
        expiresAt: minted.expiresAt,
        model: minted.model,
        voice,
        session,
      },
      snapshot: { ...snapshot, checkin },
    };
  }

  /** Only the account explicitly connected to Pew2 may authorize voice. */
  private async mint(prefs: VoicePrefs, session: Record<string, unknown>) {
    const epoch = this.accountEpoch;
    const signal = AbortSignal.any([this.stopping.signal, this.minting.signal]);
    const account = await this.account.accessToken();
    if (!account.ok) return account;
    if (epoch !== this.accountEpoch || signal.aborted) {
      return {
        ok: false as const,
        code: "account-required",
        message: MINT_MESSAGES["account-required"],
      };
    }
    const minted = await mintRealtimeSecret({
      accessToken: account.token,
      model: prefs.model ?? DEFAULT_MODEL,
      session,
      fetch: this.deps.fetch,
      signal,
    });
    if (epoch === this.accountEpoch && !signal.aborted)
      this.account.noteMint(minted.ok ? undefined : minted.code);
    return minted;
  }

  /**
   * The opening check-in: what happened since the user last listened, counted
   * from the store and live state, plus DAVE's changed top picks. `covered` is
   * saved at `close`, so the next session does not repeat it.
   */
  private checkin(
    eventId: number,
    live: readonly RunningSession[],
    digest: DaveDigest | undefined,
  ): { checkin: Checkin; covered: CheckinState } {
    const prev = this.store.checkinState();
    const heard = Math.max(this.store.heardEventId, prev.eventId ?? 0);
    const tasks = this.store.tasks().filter((t) => t.dismissedAt === undefined);
    const shown = new Set(tasks.map((t) => t.taskId));
    // Voice tasks' own sessions are counted through their approvals and questions.
    const owned = new Set(
      this.store
        .tasks()
        .flatMap((t) => (t.sessionId && !TERMINAL.has(t.state) ? [t.sessionId] : [])),
    );
    const dave = daveChanges(prev.daveSeen, digest);
    const checkin = buildCheckin({
      events: this.store.eventsSince(heard, MAX_EVENTS).filter((e) => shown.has(e.taskId)),
      heardEventId: heard,
      tasks,
      pendingApprovals: this.orchestrator.pendingApprovals().filter((t) => shown.has(t.taskId))
        .length,
      openQuestions: tasks.filter((t) => t.question && !TERMINAL.has(t.state)).length,
      deskNeedsYou: live.filter((s) => s.state === "needs_you" && !owned.has(s.sessionId)).length,
      dave: dave.projects,
      now: this.now(),
    });
    return {
      checkin,
      covered: { ...(dave.seen ? { daveSeen: dave.seen } : null), at: this.now(), eventId },
    };
  }

  async tool(message: {
    voiceSessionId: string;
    callId: string;
    name: string;
    args: Record<string, unknown>;
  }) {
    const result = await this.tools.handle({
      callId: message.callId,
      name: message.name,
      args: message.args,
    });
    return {
      t: "voice.tool.result",
      voiceSessionId: message.voiceSessionId,
      callId: message.callId,
      ok: result.ok,
      output: result.output,
      ...(result.error ? { error: result.error } : null),
      ...(result.endSession ? { endSession: true } : null),
      ...(result.openPicker ? { openPicker: true } : null),
    };
  }

  // ---- screenshots ---------------------------------------------------------

  /**
   * Keep a screenshot the phone sent. Answered to the sender, and the new list
   * is broadcast so every screen showing voice agrees on what is held.
   *
   * Written to disk before it is recorded: a record whose file never landed
   * would be offered to the model and then fail the task it was sent with.
   */
  async attach(message: { requestId: string; name: string; mimeType: string; data: string }) {
    const answer = (fields: { ok: boolean; attachment?: VoiceAttachment; error?: string }) => ({
      t: "voice.attached" as const,
      requestId: message.requestId,
      ...fields,
    });
    const checked = checkScreenshot(message.mimeType, message.data);
    if (!checked.ok) return answer({ ok: false, error: checked.error });
    const name = message.name.trim().slice(0, 120) || "screenshot";
    let path: string;
    try {
      path = await writeScreenshot(
        this.deps.dataDir,
        this.store.peekScreenshotId(),
        name,
        checked.bytes,
      );
    } catch {
      return answer({
        ok: false,
        error: "The computer could not save that picture. Check it has disk space, then try again.",
      });
    }
    const shot = this.store.addScreenshot({
      name,
      mimeType: checked.mimeType,
      size: checked.bytes.byteLength,
      path,
    });
    await this.pruneScreenshots();
    await this.store.flush();
    this.broadcastScreenshots();
    return answer({ ok: true, attachment: attachmentView(shot) });
  }

  /** Drop a screenshot and its file. A missing id is already the outcome wanted. */
  async detach(attachmentId: string): Promise<void> {
    const shot = this.store.removeScreenshot(attachmentId);
    if (!shot) return;
    await deleteScreenshot(shot.path);
    await this.store.flush();
    this.broadcastScreenshots();
  }

  /** Every screenshot held, oldest first, as clients see them. */
  screenshots(): VoiceAttachment[] {
    return this.store.screenshots().map(attachmentView);
  }

  private broadcastScreenshots() {
    this.deps.emit({ t: "voice.attachments", attachments: this.screenshots() });
  }

  private async pruneScreenshots(): Promise<void> {
    const removed = this.store.pruneScreenshots(MAX_SCREENSHOTS, SCREENSHOT_TTL_MS);
    await Promise.all(removed.map((shot) => deleteScreenshot(shot.path)));
  }

  private async readScreenshots(ids: readonly string[]): Promise<PromptImage[]> {
    return Promise.all(
      ids.map(async (id) => {
        const shot = this.store.screenshot(id);
        if (!shot) throw new Error("A screenshot for this task was removed. Attach it again.");
        return {
          name: shot.name,
          mimeType: shot.mimeType,
          data: await readScreenshot(shot.path, shot.name),
        };
      }),
    );
  }

  // ---- dismissal -----------------------------------------------------------

  /**
   * Clear finished tasks off every screen. Persisted before it is announced,
   * so a client that reconnects after the broadcast is told the same thing by
   * `state()`. Live tasks are never touched (see `VoiceStore.dismiss`).
   */
  async dismiss(message: {
    taskIds: readonly string[];
    projectIds?: readonly string[];
    allFinished?: boolean;
  }): Promise<string[]> {
    const ids = new Set(message.taskIds);
    const projects = new Set(message.projectIds ?? []);
    const dismissed = this.store.dismiss(
      (t) =>
        message.allFinished === true ||
        ids.has(t.taskId) ||
        projects.has(t.projectId) ||
        (t.repo?.projectId !== undefined && projects.has(t.repo.projectId)),
    );
    if (dismissed.length === 0) return [];
    await this.store.flush();
    const taskIds = dismissed.map((t) => t.taskId);
    this.deps.emit({ t: "voice.dismissed", taskIds });
    return taskIds;
  }

  close(message: { voiceSessionId: string; heardEventId?: number }) {
    this.open_.delete(message.voiceSessionId);
    const covered = this.checkins.get(message.voiceSessionId);
    if (covered) {
      this.checkins.delete(message.voiceSessionId);
      this.store.setCheckinState({ ...this.store.checkinState(), ...covered });
    }
    if (message.heardEventId !== undefined) this.store.markHeard(message.heardEventId);
    return this.store.flush();
  }

  async state(since = 0) {
    return {
      t: "voice.state",
      snapshot: await this.snapshot(),
      events: this.store
        .eventsSince(since, 200)
        .filter((e) => this.store.getTask(e.taskId)?.dismissedAt === undefined),
      attachments: this.screenshots(),
      dismissed: this.store.dismissedWithEvents(),
    };
  }
}

function attachmentView(shot: StoredScreenshot): VoiceAttachment {
  return {
    attachmentId: shot.attachmentId,
    name: shot.name,
    mimeType: shot.mimeType,
    size: shot.size,
    at: shot.at,
    sentTo: [...shot.sentTo],
  };
}

/** Plain-text rendering of a snapshot for the model's instructions. */
export function contextText(snapshot: VoiceSnapshot): string {
  const lines: string[] = [];
  if (snapshot.opening) lines.push(snapshot.opening);
  if (snapshot.projects.length) {
    lines.push(
      `Projects: ${snapshot.projects.map((p) => `${p.name} [${p.projectId}]`).join(", ")}`,
    );
  }
  for (const t of snapshot.tasks) {
    lines.push(
      `Task ${t.taskId} ${placeSpoken(t)}: ${t.title} - ${t.state}${t.activity ? ` (${t.activity})` : ""}${t.approval ? ` awaiting ${t.approval.risk} approval ${t.approval.requestId}` : ""}`,
    );
    if (t.state === "completed" && t.debrief) lines.push(`  Debrief: ${JSON.stringify(t.debrief)}`);
    if (t.goal) lines.push(`  Goal: ${goalLine(t.goal)}`);
    if (t.question) {
      const options = t.question.options?.length
        ? ` (options: ${t.question.options.map((o) => speakable(o, 40)).join(", ")})`
        : "";
      lines.push(
        `  Question ${t.question.requestId}: ${speakable(t.question.text, 200)}${options}`,
      );
    }
  }
  if (snapshot.unheard.length) {
    lines.push("Not yet heard:");
    for (const e of snapshot.unheard) lines.push(`- #${e.eventId} ${placeSpoken(e)}: ${e.text}`);
  }
  if (lines.length === (snapshot.opening ? 1 : 0)) lines.push("No tasks yet.");
  return lines.join("\n");
}

/** One line on how far a goal got. A goal is not one turn, so its task state alone says little. */
function goalLine(goal: NonNullable<VoiceSnapshot["tasks"][number]["goal"]>): string {
  if (goal.say) return speakable(goal.say, 240);
  const parts = [goal.total ? `${goal.done} of ${goal.total} milestones` : "run not found yet"];
  if (goal.status) parts.push(`run ${goal.status}`);
  if (goal.verified && goal.verified !== "none")
    parts.push(`verifier ${goal.verified === "pass" ? "passed" : "failed"}`);
  if (goal.needsYou) parts.push(`needs you: ${speakable(goal.needsYou, 120)}`);
  return parts.join(", ");
}

/**
 * Conversations running at the computer (started in a terminal, not by pew2),
 * for the model's opening instructions. Pure; "" when there are none.
 */
export function deskContext(
  sessions: readonly RunningSession[],
  projects: readonly VoiceProject[],
): string {
  const desk = sessions
    .filter((s) => s.origin === "desktop")
    .sort((a, b) => Number(b.state === "working") - Number(a.state === "working"))
    .slice(0, 6);
  if (!desk.length) return "";
  const lines = desk.map((s) => {
    const project = projectForPath(s.cwd, projects);
    const place = placeSpoken({
      projectName: project?.name ?? basename(s.cwd),
      repo: project ? repoOf(project) : undefined,
    });
    const state = s.state === "idle" ? "idle" : "working";
    const title = s.title ? speakable(s.title, 80) : "";
    return `- ${speakable(s.agentName ?? s.providerId, 40)} in ${speakable(place, 80)} (${state}, started at the computer)${title ? `: ${title}` : ""}`;
  });
  return `Running on the computer now:\n${lines.join("\n")}`;
}
