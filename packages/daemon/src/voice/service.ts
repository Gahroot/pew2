/**
 * The voice feature as one object the Daemon owns.
 *
 * Wires the pure modules together: store (state), orchestrator (dispatch),
 * registry (names), batcher (what is worth a push), mint (Realtime secret) and
 * the tool executor. `handler.ts` talks only to this, so both transports get
 * identical behaviour.
 */
import { join } from "node:path";
import { EventBatcher } from "./classify.js";
import { buildSnapshot } from "./context.js";
import { Orchestrator, type PromptImage, type VoiceHost } from "./dispatcher.js";
import { subscriptionToken } from "./codexAuth.js";
import {
  DEFAULT_MODEL,
  DEFAULT_VOICE,
  mintRealtimeSecret,
  readVoicePrefs,
  resolveApiKey,
} from "./mint.js";
import { addAlias, buildRegistry, readAliases, repoForPath } from "./registry.js";
import { DEFAULT_APPROVAL_POLICY, type ApprovalPolicy } from "./safety.js";
import { toVoiceTask, VoiceStore, type StoredScreenshot, type StoredTask } from "./store.js";
import { realtimeSession, ToolExecutor, VOICE_INSTRUCTIONS } from "./tools.js";
import type { VoiceAttachment, VoiceEvent, VoiceProject, VoiceSnapshot } from "./types.js";
import { detectWorktree, type WorktreeInfo } from "../worktree.js";
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
  usableProviders: () => string[];
  /** Conversations the daemon holds open, whoever started them. */
  runningSessions?: () => import("./types.js").RunningSession[];
  lastUsedProvider?: () => string | undefined;
  /** Send a push for an event that is worth one. Never awaited by the service. */
  push?: (event: VoiceEvent) => void | Promise<void>;
  fetch?: typeof fetch;
  now?: () => number;
  /** Background tick interval; 0 disables it (tests). */
  tickMs?: number;
}

export interface OpenRequest {
  voiceSessionId: string;
  source: string;
  focusEventId?: number;
  focusTaskId?: string;
}

const PROJECT_TTL_MS = 30_000;

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

  private constructor(
    private readonly deps: VoiceServiceDeps,
    store: VoiceStore,
  ) {
    this.now = deps.now ?? Date.now;
    this.store = store;
    this.orchestrator = new Orchestrator(store, deps.host, {
      now: this.now,
      readAttachments: (ids) => this.readScreenshots(ids),
    });
    this.tools = new ToolExecutor({
      store,
      orchestrator: this.orchestrator,
      projects: () => this.projects(true),
      usableProviders: deps.usableProviders,
      runningSessions: deps.runningSessions,
      lastUsedProvider: deps.lastUsedProvider,
      approvalPolicy: { get: () => this.approvalPolicy, set: (p) => void (this.approvalPolicy = p) },
      rememberAlias: async (path, alias) => {
        await addAlias(deps.dataDir, path, alias);
        this.projectCache = undefined;
      },
    });
    // Hands-free auto-approval only runs while someone is on a voice session.
    this.orchestrator.autoApprove = () => this.open_.size > 0 && this.approvalPolicy.autoApproveSafe;
    store.subscribe((event, task) => this.onEvent(event, task));
  }

  static async create(deps: VoiceServiceDeps): Promise<VoiceService> {
    const store = await VoiceStore.open(join(deps.dataDir, "voice-state.json"), deps.now);
    const service = new VoiceService(deps, store);
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
  }

  tick() {
    this.orchestrator.tick();
    for (const event of this.batcher.due(this.now())) this.pushIfIdle(event);
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
    const list = buildRegistry(paths, aliases, this.deps.providerForPath, (path) => worktrees.get(path));
    this.projectCache = { at: this.now(), list };
    return list;
  }

  private onEvent(event: VoiceEvent, task: StoredTask) {
    this.deps.emit({ t: "voice.event", event, task: toVoiceTask(task) });
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
        ? this.store.eventsSince(request.focusEventId - 1, 1).find((e) => e.eventId === request.focusEventId)
        : undefined;
    return buildSnapshot({
      projects: await this.projects(),
      tasks: this.store.tasks(),
      events: this.store.eventsSince(this.store.heardEventId, 200),
      lastEventId: this.store.lastEventId,
      heardEventId: this.store.heardEventId,
      source: request?.source,
      focusTaskId: request?.focusTaskId ?? focusEvent?.taskId,
      focusEvent,
    });
  }

  async open(request: OpenRequest): Promise<Record<string, unknown>> {
    const prefs = await readVoicePrefs(this.deps.dataDir);
    if (prefs.enabled === false) {
      return { t: "voice.unavailable", voiceSessionId: request.voiceSessionId, code: "disabled", message: "Voice is turned off on this computer." };
    }
    // Fresh registry and state before the model speaks.
    await this.projects(true);
    const snapshot = await this.snapshot(request);
    const voice = prefs.voice ?? DEFAULT_VOICE;
    const session = realtimeSession({
      voice,
      instructions: `${VOICE_INSTRUCTIONS}\n\nContext now:\n${contextText(snapshot)}`,
    });
    // Subscription login first, API key as the fallback.
    const subscription = await subscriptionToken(this.deps.env, this.deps.fetch);
    const mintWith = (apiKey: string | undefined) =>
      mintRealtimeSecret({ apiKey, model: prefs.model ?? DEFAULT_MODEL, session, fetch: this.deps.fetch });
    let minted = await mintWith(subscription);
    const apiKey = resolveApiKey(this.deps.env, prefs);
    if (!minted.ok && apiKey && apiKey !== subscription) minted = await mintWith(apiKey);
    if (!minted.ok) {
      return { t: "voice.unavailable", voiceSessionId: request.voiceSessionId, code: minted.code, message: minted.message };
    }
    if (this.open_.size === 0) this.approvalPolicy = DEFAULT_APPROVAL_POLICY;
    this.open_.add(request.voiceSessionId);
    return {
      t: "voice.ready",
      voiceSessionId: request.voiceSessionId,
      realtime: { secret: minted.secret, expiresAt: minted.expiresAt, model: minted.model, voice, session },
      snapshot,
    };
  }

  async tool(message: { voiceSessionId: string; callId: string; name: string; args: Record<string, unknown> }) {
    const result = await this.tools.handle({ callId: message.callId, name: message.name, args: message.args });
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
      path = await writeScreenshot(this.deps.dataDir, this.store.peekScreenshotId(), name, checked.bytes);
    } catch {
      return answer({ ok: false, error: "The computer could not save that picture. Check it has disk space, then try again." });
    }
    const shot = this.store.addScreenshot({ name, mimeType: checked.mimeType, size: checked.bytes.byteLength, path });
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
        return { name: shot.name, mimeType: shot.mimeType, data: await readScreenshot(shot.path, shot.name) };
      }),
    );
  }

  close(message: { voiceSessionId: string; heardEventId?: number }) {
    this.open_.delete(message.voiceSessionId);
    if (message.heardEventId !== undefined) this.store.markHeard(message.heardEventId);
    return this.store.flush();
  }

  async state(since = 0) {
    return {
      t: "voice.state",
      snapshot: await this.snapshot(),
      events: this.store.eventsSince(since, 200),
      attachments: this.screenshots(),
    };
  }
}

function attachmentView(shot: StoredScreenshot): VoiceAttachment {
  return { attachmentId: shot.attachmentId, name: shot.name, mimeType: shot.mimeType, size: shot.size, at: shot.at, sentTo: [...shot.sentTo] };
}

/** Plain-text rendering of a snapshot for the model's instructions. */
export function contextText(snapshot: VoiceSnapshot): string {
  const lines: string[] = [];
  if (snapshot.opening) lines.push(snapshot.opening);
  if (snapshot.projects.length) {
    lines.push(`Projects: ${snapshot.projects.map((p) => `${p.name} [${p.projectId}]`).join(", ")}`);
  }
  for (const t of snapshot.tasks) {
    lines.push(`Task ${t.taskId} ${placeSpoken(t)}: ${t.title} - ${t.state}${t.activity ? ` (${t.activity})` : ""}${t.approval ? ` awaiting ${t.approval.risk} approval ${t.approval.requestId}` : ""}`);
    if (t.state === "completed" && t.debrief) lines.push(`  Debrief: ${JSON.stringify(t.debrief)}`);
  }
  if (snapshot.unheard.length) {
    lines.push("Not yet heard:");
    for (const e of snapshot.unheard) lines.push(`- #${e.eventId} ${placeSpoken(e)}: ${e.text}`);
  }
  if (lines.length === (snapshot.opening ? 1 : 0)) lines.push("No tasks yet.");
  return lines.join("\n");
}
