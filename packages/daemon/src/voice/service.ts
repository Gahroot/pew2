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
import { Orchestrator, type VoiceHost } from "./dispatcher.js";
import {
  DEFAULT_MODEL,
  DEFAULT_VOICE,
  mintRealtimeSecret,
  readVoicePrefs,
  resolveApiKey,
} from "./mint.js";
import { addAlias, buildRegistry, readAliases } from "./registry.js";
import { toVoiceTask, VoiceStore, type StoredTask } from "./store.js";
import { realtimeSession, ToolExecutor, VOICE_INSTRUCTIONS } from "./tools.js";
import type { VoiceEvent, VoiceProject, VoiceSnapshot } from "./types.js";

export interface VoiceServiceDeps {
  dataDir: string;
  env: NodeJS.ProcessEnv;
  host: VoiceHost;
  /** Broadcast to every connected client on every transport. */
  emit: (message: unknown) => void;
  /** Project paths the daemon knows (known-projects + agent history). */
  projectPaths: () => Promise<string[]>;
  providerForPath?: (path: string) => string | undefined;
  usableProviders: () => string[];
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

  private constructor(
    private readonly deps: VoiceServiceDeps,
    store: VoiceStore,
  ) {
    this.now = deps.now ?? Date.now;
    this.store = store;
    this.orchestrator = new Orchestrator(store, deps.host, { now: this.now });
    this.tools = new ToolExecutor({
      store,
      orchestrator: this.orchestrator,
      projects: () => this.projects(true),
      usableProviders: deps.usableProviders,
      lastUsedProvider: deps.lastUsedProvider,
      rememberAlias: async (path, alias) => {
        await addAlias(deps.dataDir, path, alias);
        this.projectCache = undefined;
      },
    });
    store.subscribe((event, task) => this.onEvent(event, task));
  }

  static async create(deps: VoiceServiceDeps): Promise<VoiceService> {
    const store = await VoiceStore.open(join(deps.dataDir, "voice-state.json"), deps.now);
    const service = new VoiceService(deps, store);
    service.orchestrator.reconcile();
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

  /** Registry, refreshed when older than the TTL or when `fresh` is asked for. */
  async projects(fresh = false): Promise<VoiceProject[]> {
    const cached = this.projectCache;
    if (cached && (!fresh || this.now() - cached.at < PROJECT_TTL_MS)) return cached.list;
    const [paths, aliases] = await Promise.all([
      this.deps.projectPaths().catch(() => [] as string[]),
      readAliases(this.deps.dataDir),
    ]);
    const list = buildRegistry(paths, aliases, this.deps.providerForPath);
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
    const minted = await mintRealtimeSecret({
      apiKey: resolveApiKey(this.deps.env, prefs),
      model: prefs.model ?? DEFAULT_MODEL,
      session,
      fetch: this.deps.fetch,
    });
    if (!minted.ok) {
      return { t: "voice.unavailable", voiceSessionId: request.voiceSessionId, code: minted.code, message: minted.message };
    }
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
    };
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
    };
  }
}

/** Plain-text rendering of a snapshot for the model's instructions. */
export function contextText(snapshot: VoiceSnapshot): string {
  const lines: string[] = [];
  if (snapshot.opening) lines.push(snapshot.opening);
  if (snapshot.projects.length) {
    lines.push(`Projects: ${snapshot.projects.map((p) => `${p.name} [${p.projectId}]`).join(", ")}`);
  }
  for (const t of snapshot.tasks) {
    lines.push(`Task ${t.taskId} ${t.projectName}: ${t.title} - ${t.state}${t.activity ? ` (${t.activity})` : ""}${t.approval ? ` awaiting ${t.approval.risk} approval ${t.approval.requestId}` : ""}`);
  }
  if (snapshot.unheard.length) {
    lines.push("Not yet heard:");
    for (const e of snapshot.unheard) lines.push(`- #${e.eventId} ${e.projectName}: ${e.text}`);
  }
  if (lines.length === (snapshot.opening ? 1 : 0)) lines.push("No tasks yet.");
  return lines.join("\n");
}
