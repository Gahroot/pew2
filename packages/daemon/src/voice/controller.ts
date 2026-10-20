/**
 * The daemon's voice layer: credentials, sign-in, the machine-wide inbox, the
 * call policy and its timer, and minting calls. Owned by the `Daemon`, shared
 * by both transports through `handler.ts`.
 */
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { wire } from "@pew2/protocol";
import { writeFileAtomic } from "../atomic-file.js";
import { resolveCredential, type FetchLike, type VoicePaths } from "./credentials.js";
import { BoardThrottle, buildBoard, mark, newMemory, type BoardLine, type BoardMemory, type BoardSource } from "./board.js";
import { buildInbox, inboxSignature, ringWho, summariseInbox, type InboxSource } from "./inbox.js";
import { DeviceLogin } from "./login.js";
import { turnNote } from "./notes.js";
import { CALLBACK_ANSWER_MS, MEMORY_ACTIONS, callbackLines } from "./memory.js";
import { HOME_THREAD, threadLines, type ThreadLine, type ThreadStore } from "./threads.js";
import * as policy from "./policy.js";
import { buildInstructions, buildSessionConfig, mintClientSecret, type SessionStatus } from "./session.js";
import type { VoiceRingPush } from "../push.js";

export interface VoiceHost {
  inboxSources(): InboxSource[];
  /** To every connected client. */
  broadcast(message: unknown): void;
  ring(push: VoiceRingPush): void;
  /** Live sessions for the call screen's board. Absent: no board. */
  boardSources?(): BoardSource[];
  /**
   * The voice thread of a live session: its agent conversation's key and
   * folder name. Undefined while the agent has no conversation yet (a new
   * chat with nothing sent). Absent: no threads.
   */
  threadFor?(sessionId: string): { key: string; label?: string } | undefined;
}

export interface VoiceOptions {
  paths: VoicePaths;
  fetchImpl?: FetchLike;
  now?: () => number;
  /** Timer injection for tests. */
  setTimer?: (fn: () => void, ms: number) => { cancel(): void };
  /** Where ring decisions are logged (the daemon's console). Silent when absent. */
  log?: (line: string) => void;
  /** Where voice threads are kept (`voice/threads.ts`). Absent: no threads (tests). */
  threads?: ThreadStore;
}

const MAX_CALLS = 8;
/** Arming ends by itself after this, so it can't outlive the work. */
export const ARM_MS = 12 * 60 * 60_000;
/** "Call me back when it's done" gives up after this. */
export const WAIT_MAX_MS = 6 * 60 * 60_000;
/** A session idle this long after the ask, never having started, counts as done. */
export const WAIT_START_MS = 20_000;

export async function readVoicePrefs(path: string): Promise<wire.VoicePrefsValues | undefined> {
  try {
    const parsed = wire.VoicePrefsValues.safeParse(JSON.parse(await readFile(path, "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export class VoiceController {
  private readonly firstSeen = new Map<string, number>();
  private items: wire.VoiceInboxItem[] = [];
  private signature = "";
  private state = policy.initialState();
  private prefs: policy.Prefs = policy.withDefaults(undefined);
  private timer?: { cancel(): void };
  /**
   * Which voice thread each live call belongs to: a chat's (by live session
   * id, resolved to its conversation key at the end, so a chat that only got
   * its conversation during the call still counts), or home.
   */
  private readonly callThreads = new Map<string, { sessionId?: string; key?: string; label?: string }>();
  /** The thread a pending callback continues. */
  private callbackThread?: { sessionId?: string; key?: string; label?: string };
  /**
   * Each tool call's answer, by call and tool call id: the phone sends a
   * request again after its link drops, and the same call must never run twice
   * (one "approve" or one message to an agent, however many times it arrives).
   */
  private readonly answered = new Map<string, Promise<{ output: string; hangUp?: boolean }>>();
  /** What Pew did on each live call, for the memory it leaves. */
  private readonly actions = new Map<string, { text: string; sessionId?: string }[]>();
  /** "Call me back when it's done": the session being waited on. */
  private waitingOn?: { sessionId: string; folder?: string; since: number; started: boolean };
  /** When "call me back" was asked, and when that callback last rang. */
  private callbackAskedAt?: number;
  private callbackRungAt?: number;
  private readonly calls = new Set<string>();
  private callCounter = 0;
  /** The open call's board: Pew's marks and the throttle. Live state, cleared at hang-up. */
  private board?: {
    callId: string;
    memory: BoardMemory;
    throttle: BoardThrottle;
    /** Each session's `working` as last seen, to notice a turn starting or ending. */
    working: Map<string, boolean>;
    /** The conversation the call was started from. */
    context?: string;
  };
  /** Sessions allowed to ring, and when that ends. In memory: session ids die with the daemon. */
  private readonly armed = new Map<string, number>();
  readonly login: DeviceLogin;
  readonly loaded: Promise<void>;
  private readonly now: () => number;
  private readonly fetchImpl: FetchLike;
  private readonly setTimer: (fn: () => void, ms: number) => { cancel(): void };

  constructor(
    private readonly host: VoiceHost,
    private readonly options: VoiceOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.setTimer =
      options.setTimer ??
      ((fn, ms) => {
        const handle = setTimeout(fn, ms);
        handle.unref?.();
        return { cancel: () => clearTimeout(handle) };
      });
    this.login = new DeviceLogin({
      voiceAuthPath: options.paths.voiceAuth,
      fetchImpl: this.fetchImpl,
      now: this.now,
      onChange: () => void this.broadcastStatus(),
    });
    this.loaded = readVoicePrefs(options.paths.voicePrefs).then((prefs) => {
      this.prefs = policy.withDefaults(prefs);
      this.schedule();
    });
  }

  get inbox(): wire.VoiceInboxItem[] {
    return this.items;
  }

  get currentPrefs(): policy.Prefs {
    return this.prefs;
  }

  /** Armed sessions, soonest to expire first. */
  get armedSessions(): wire.VoiceArmed[] {
    return [...this.armed]
      .map(([sessionId, until]) => ({ sessionId, until }))
      .sort((a, b) => a.until - b.until || (a.sessionId < b.sessionId ? -1 : 1));
  }

  isArmed(sessionId: string): boolean {
    const until = this.armed.get(sessionId);
    return until !== undefined && this.now() < until;
  }

  /**
   * Let a session ring, or stop it. Whatever it is already waiting on counts
   * as seen (the user is holding the phone right now), so arming never rings
   * about the past: only what blocks after this.
   */
  arm(sessionId: string, on: boolean): void {
    if (on) {
      this.armed.set(sessionId, this.now() + ARM_MS);
      const waiting = this.items.filter((item) => item.sessionId === sessionId).map((item) => item.id);
      this.state = policy.markSeen(this.state, waiting);
    } else if (!this.armed.delete(sessionId)) {
      return;
    }
    this.schedule();
    void this.broadcastStatus();
  }

  /** A session the phone started: armed when the user asked for every new one to be. */
  sessionStarted(sessionId: string): void {
    if (this.prefs.armNewSessions) this.arm(sessionId, true);
  }

  /** The chat a live call started from, if it named one that was open. */
  callContext(callId: string): string | undefined {
    return this.board?.callId === callId ? this.board.context : undefined;
  }

  /** A session closed: its arming goes with it. */
  sessionClosed(sessionId: string): void {
    if (this.armed.has(sessionId)) this.arm(sessionId, false);
  }

  /** Recompute the inbox; broadcast and re-run the policy only when it changed. */
  inboxChanged(): void {
    const items = buildInbox(this.host.inboxSources(), this.firstSeen, this.now());
    const signature = inboxSignature(items);
    this.items = items;
    if (signature === this.signature) return;
    this.signature = signature;
    this.host.broadcast({ t: "voice.inbox", items } satisfies wire.VoiceInbox);
    this.schedule();
  }

  async status(requestId?: string): Promise<wire.VoiceStatus> {
    const found = await resolveCredential(this.options.paths, { now: this.now(), fetchImpl: this.fetchImpl });
    const pending = this.login.current;
    const base = {
      t: "voice.status" as const,
      ...(requestId ? { requestId } : {}),
      prefs: this.prefs,
      armed: this.armedSessions,
      ...(pending ? { login: pending } : {}),
    };
    if (found.ok) {
      return {
        ...base,
        available: true,
        source: found.credential.source,
        ...(found.credential.account ? { account: found.credential.account } : {}),
      };
    }
    return { ...base, available: false, reason: this.login.failure ?? found.reason, canLogin: true };
  }

  async broadcastStatus(): Promise<void> {
    this.host.broadcast(await this.status());
  }

  async loginAction(action: wire.VoiceLogin["action"], requestId: string): Promise<wire.VoiceStatus> {
    if (action === "start") await this.login.start();
    else if (action === "cancel") this.login.cancel();
    else await this.login.logout();
    return this.status(requestId);
  }

  async setPrefs(partial: Partial<wire.VoicePrefsValues>): Promise<void> {
    await this.loaded;
    const next = policy.withDefaults({ ...this.prefs, ...partial });
    // Switching ringing on, or widening it to every chat, never rings about
    // what is already waiting: they are holding the phone and can see it.
    const ringingNow = (prefs: policy.Prefs) => prefs.mode === "onthego" && !policy.ringExpired(prefs, this.now());
    const widened = next.ringScope === "all" && this.prefs.ringScope !== "all";
    if ((ringingNow(next) && !ringingNow(this.prefs)) || widened) {
      this.state = policy.markSeen(this.state, this.items.map((item) => item.id));
    }
    this.prefs = next;
    await mkdir(dirname(this.options.paths.voicePrefs), { recursive: true, mode: 0o700 });
    await writeFileAtomic(this.options.paths.voicePrefs, `${JSON.stringify(next, null, 2)}\n`);
    this.schedule();
    await this.broadcastStatus();
  }

  /** Mint a call. Counts as a call start for the policy only when it succeeds. */
  async openSession(
    requestId: string,
    focus: string | undefined,
    statuses: SessionStatus[],
    context?: string,
    projects?: readonly string[],
    place?: { folder: string; agentName?: string },
    /**
     * The voice tasks' part of this call, built once its id is known: their
     * guidance and state for the instructions, and their tools. Absent, or
     * failing: the call has only its own.
     */
    tasks?: (callId: string) => Promise<{ instructions: string; tools: readonly Record<string, unknown>[] } | undefined>,
  ): Promise<wire.VoiceSession> {
    this.inboxChanged();
    const found = await resolveCredential(this.options.paths, { now: this.now(), fetchImpl: this.fetchImpl });
    if (!found.ok) return { t: "voice.session", requestId, ok: false, error: found.reason };
    const items = this.items;
    const known = context && statuses.some((status) => status.sessionId === context) ? context : undefined;
    const callback = this.callbackRungAt !== undefined && this.now() - this.callbackRungAt <= CALLBACK_ANSWER_MS && this.callbackAskedAt !== undefined
      ? { askedAt: this.callbackAskedAt }
      : undefined;
    this.callbackRungAt = undefined;
    // The thread this call continues: the callback's, else the chat they
    // called from, else home. A chat with no conversation yet (new, nothing
    // sent) has none: a fresh call, bound to it if it gets one (`bindCall`).
    const thread = callback
      ? (this.callbackThread ?? {})
      : known
        ? { sessionId: known, ...this.host.threadFor?.(known) }
        : place
          ? {}
          : { key: HOME_THREAD };
    if (callback) this.callbackThread = undefined;
    const earlier = thread.key ? await this.options.threads?.get(thread.key) : undefined;
    const about = thread.key && thread.key !== HOME_THREAD ? `the ${earlier?.label ?? thread.label ?? "same"} chat` : undefined;
    const remembered = [...callbackLines(this.now(), callback), ...threadLines(earlier, this.now(), about)];
    const callId = `call_${this.now().toString(36)}_${++this.callCounter}`;
    const extra = tasks ? await tasks(callId).catch(() => undefined) : undefined;
    const config = buildSessionConfig(
      buildInstructions(items, statuses, focus, this.now(), known, projects, place, remembered, extra?.instructions),
      extra?.tools,
    );
    const minted = await mintClientSecret(found.credential.token, config, this.fetchImpl);
    if (!minted.ok) return { t: "voice.session", requestId, ok: false, error: minted.error };
    this.calls.add(callId);
    this.callThreads.set(callId, thread);
    while (this.calls.size > MAX_CALLS) {
      const oldest = this.calls.values().next().value;
      if (oldest === undefined) break;
      this.calls.delete(oldest);
    }
    this.state = policy.callStarted(this.state, this.now(), items);
    this.schedule();
    this.openBoard(callId, items.find((item) => item.id === focus)?.sessionId ?? known, known);
    return {
      t: "voice.session",
      requestId,
      ok: true,
      provider: "openai",
      secret: minted.secret,
      expiresAt: minted.expiresAt,
      model: minted.model,
      callId,
      items,
    };
  }

  knowsCall(callId: string): boolean {
    return this.calls.has(callId);
  }

  /**
   * Run a tool call once per id: a repeat gets the first run's answer (even
   * one still running). Answers are dropped with their call.
   */
  runOnce(callId: string, toolCallId: string, run: () => Promise<{ output: string; hangUp?: boolean }>): Promise<{ output: string; hangUp?: boolean }> {
    const key = `${callId}\u0000${toolCallId}`;
    const existing = this.answered.get(key);
    if (existing) return existing;
    const result = run();
    this.answered.set(key, result);
    while (this.answered.size > 200) this.answered.delete(this.answered.keys().next().value!);
    return result;
  }

  /** A call's lines into its thread (the chat's conversation key, resolved now). */
  private async saveCall(
    thread: { sessionId?: string; key?: string; label?: string },
    transcript: wire.VoiceEnd["transcript"],
    actions: readonly { text: string; sessionId?: string }[],
  ): Promise<void> {
    const store = this.options.threads;
    if (!store) return;
    const resolved = thread.sessionId ? { ...thread, ...this.host.threadFor?.(thread.sessionId) } : thread;
    if (resolved.key) {
      const lines: ThreadLine[] = [
        ...(transcript ?? []).map((line) => ({ role: line.role, text: line.text })),
        ...actions.map((action) => ({ role: "assistant" as const, text: action.text, action: true as const })),
      ];
      await store.append(resolved.key, lines, resolved.label);
    }
    // What Pew did to another chat on this call goes to that chat's thread
    // too (the action only, not the call's words), so a later call about it
    // knows: "you sent docs: fix the links".
    const others = new Map<string, { label?: string; lines: ThreadLine[] }>();
    for (const action of actions) {
      const target = action.sessionId ? this.host.threadFor?.(action.sessionId) : undefined;
      if (!target || target.key === resolved.key) continue;
      const entry = others.get(target.key) ?? { label: target.label, lines: [] };
      entry.lines.push({ role: "assistant", text: action.text, action: true });
      others.set(target.key, entry);
    }
    for (const [key, entry] of others) await store.append(key, entry.lines, entry.label);
  }

  /**
   * A call that started with no chat (from a new, empty one) now has one:
   * Pew started or opened it. The call's lines go to that chat's thread.
   */
  bindCall(callId: string, sessionId: string): void {
    const thread = this.callThreads.get(callId);
    if (!thread || thread.key || thread.sessionId) return;
    this.callThreads.set(callId, { sessionId });
  }

  /** Forget every call thread ("Forget call history"). */
  async forgetThreads(): Promise<void> {
    await this.options.threads?.clear();
  }

  /** Something Pew did on a call (`actionLine`), remembered with that call. */
  noteAction(callId: string, line: string | undefined, sessionId?: string): void {
    if (!line || !this.calls.has(callId)) return;
    const list = this.actions.get(callId) ?? [];
    list.push({ text: line, ...(sessionId ? { sessionId } : {}) });
    this.actions.set(callId, list.slice(-MEMORY_ACTIONS));
  }


  /** A call (or a ring) ended. Unknown ids still count: a missed ring was never minted. */
  endCall(callId: string, reason?: wire.VoiceEnd["reason"], transcript?: wire.VoiceEnd["transcript"]): void {
    // Only a call this daemon minted adds to a thread: a declined ring has no transcript.
    const thread = this.callThreads.get(callId);
    if (this.calls.has(callId) && thread) void this.saveCall(thread, transcript, this.actions.get(callId) ?? []);
    this.callThreads.delete(callId);
    this.actions.delete(callId);
    for (const key of this.answered.keys()) if (key.startsWith(`${callId}\u0000`)) this.answered.delete(key);
    this.calls.delete(callId);
    if (this.board?.callId === callId) this.closeBoard();
    this.state = policy.callEnded(this.state, this.now(), reason);
    this.schedule();
  }

  /**
   * "Call me back when billing is done": ring once that session's turn ends
   * (or it stops to ask them something), however long it takes, up to
   * WAIT_MAX_MS. One at a time; a new one replaces it.
   */
  callWhenDone(sessionId: string, folder: string | undefined): void {
    this.waitingOn = { sessionId, folder, since: this.now(), started: false };
    this.callbackThread = { sessionId, ...this.host.threadFor?.(sessionId) };
    this.callbackAskedAt = this.now();
    this.log(`[voice] call back when ${folder ?? sessionId} is done`);
    this.checkWaitedOn();
  }

  /** The waited-on session finished its turn or needs them: ring now. */
  private checkWaitedOn(): void {
    const wait = this.waitingOn;
    if (!wait) return;
    if (this.now() - wait.since > WAIT_MAX_MS) {
      this.waitingOn = undefined;
      return;
    }
    const source = this.host.boardSources?.().find((s) => s.sessionId === wait.sessionId);
    if (!source) {
      // Closed (or never open): nothing will finish. Ring now and say so.
      this.waitingOn = undefined;
      this.callMeBack(0.5);
      return;
    }
    const needsThem = this.items.some((item) => item.sessionId === wait.sessionId);
    if (source.working && !needsThem) {
      wait.started = true;
      return;
    }
    // Idle before it ever started (the message is still on its way) is not done.
    if (!wait.started && !needsThem && this.now() - wait.since < WAIT_START_MS) return;
    this.waitingOn = undefined;
    this.log(`[voice] ${wait.folder ?? wait.sessionId} ${needsThem ? "needs them" : "is done"}: calling back`);
    // Due now (not in half a minute): it already waited for the work.
    this.state = { ...this.state, callbackAt: this.now() };
    this.schedule();
  }

  callMeBack(minutes: number, callId?: string): void {
    this.callbackAskedAt = this.now();
    // The callback continues the thread of the call it was asked on.
    const thread = callId ? this.callThreads.get(callId) : undefined;
    if (thread) this.callbackThread = thread;
    this.log(`[voice] call back at ${new Date(this.now() + minutes * 60_000).toLocaleTimeString()}`);
    this.state = policy.callMeBack(this.state, this.now(), minutes);
    this.schedule();
  }

  private openBoard(callId: string, focusSession: string | undefined, context?: string): void {
    this.closeBoard();
    if (!this.host.boardSources) return;
    const memory = newMemory(this.now());
    if (focusSession) mark(memory, focusSession, this.now());
    const throttle = new BoardThrottle({
      now: this.now,
      setTimer: this.setTimer,
      build: () => buildBoard(this.host.boardSources?.() ?? [], memory, this.now()),
      send: (sessions) => this.host.broadcast({ t: "voice.board", callId, sessions } satisfies wire.VoiceBoard),
    });
    const working = new Map((this.host.boardSources?.() ?? []).map((source) => [source.sessionId, source.working]));
    this.board = { callId, memory, throttle, working, ...(context ? { context } : {}) };
    throttle.flushNow();
  }

  private closeBoard(): void {
    this.board?.throttle.cancel();
    this.board = undefined;
  }

  /** Something a lane shows may have changed: re-send the board (throttled, change-only). */
  boardChanged(): void {
    this.checkWaitedOn();
    const board = this.board;
    if (!board) return;
    if (this.now() - board.memory.callStartedAt >= policy.STALE_CALL_MS) {
      this.closeBoard();
      return;
    }
    this.noteTurns();
    board.throttle.request();
  }

  /**
   * Tell Pew, mid-call, when a session it is watching (one it prompted or
   * acted on, or the one the call started from) starts or finishes a turn,
   * and what it said. Without this Pew only knew the briefing from the start
   * of the call, so "is it done yet?" got the answer from minutes ago.
   */
  private noteTurns(): void {
    const board = this.board;
    if (!board || !this.host.boardSources) return;
    for (const source of this.host.boardSources()) {
      const was = board.working.get(source.sessionId);
      board.working.set(source.sessionId, source.working);
      if (was === undefined || was === source.working) continue;
      const watched = board.memory.touched.has(source.sessionId) || source.sessionId === board.context;
      if (!watched) continue;
      const note = turnNote(source, source.working, this.items.some((item) => item.sessionId === source.sessionId));
      this.host.broadcast({ t: "voice.note", callId: board.callId, ...note } satisfies wire.VoiceNote);
    }
  }

  /** Whether `callId` is the call in progress: minted here, not ended, not stale. */
  callInProgress(callId: string): boolean {
    const board = this.board;
    return board?.callId === callId && this.now() - board.memory.callStartedAt < policy.STALE_CALL_MS;
  }

  /**
   * Tell call `callId`, while it is the one in progress, something now: a
   * voice task's news. Dropped for any other call (ended, or replaced).
   */
  noteCall(callId: string, note: { text: string; speak?: boolean; about?: string }): void {
    if (!this.callInProgress(callId)) return;
    this.host.broadcast({ t: "voice.note", callId, ...note } satisfies wire.VoiceNote);
  }

  /** Pew acted on a session during `callId`: a touch, and optionally a line on its lane. */
  markBoard(callId: string, sessionId: string, line?: Omit<BoardLine, "at">): void {
    const board = this.board;
    if (!board || board.callId !== callId || !sessionId) return;
    mark(board.memory, sessionId, this.now(), line);
    this.boardChanged();
  }

  /**
   * Run the policy and set the one timer for its next wake-up: the policy's,
   * the soonest arming to expire, or `ringUntil`, whichever comes first.
   */
  private schedule(): void {
    this.timer?.cancel();
    this.timer = undefined;
    const now = this.now();
    let changed = false;
    for (const [sessionId, until] of this.armed) {
      if (now >= until) {
        this.armed.delete(sessionId);
        changed = true;
      }
    }
    if (policy.ringExpired(this.prefs, now)) {
      // Back to banners; said to every phone so the switch shows off.
      void this.setPrefs({ mode: "notify", ringUntil: 0 });
      return;
    }
    if (changed) void this.broadcastStatus();
    const ringable =
      this.prefs.ringScope === "all" ? this.items : this.items.filter((item) => this.armed.has(item.sessionId));
    const decision = policy.tick(this.state, now, ringable, this.prefs);
    this.state = decision.state;
    if (decision.ring) {
      const first = ringable.find((item) => item.id === decision.ring?.itemIds[0]);
      const who = ringWho(ringable);
      const callback = decision.ring.reason === "callback";
      if (callback) this.callbackRungAt = now;
      const body = callback
        ? ringable.length > 0
          ? `Calling you back. ${summariseInbox(ringable)}`
          : "Calling you back, as you asked."
        : summariseInbox(ringable);
      this.log(`[voice] ring (${decision.ring.reason}): ${body}`);
      this.host.ring({ body, ...(who ? { who } : {}), ...(first ? { focus: first.id } : {}) });
    }
    const wakes = [decision.wakeAt, ...this.armed.values()];
    if (this.prefs.mode === "onthego" && this.prefs.ringUntil > 0) wakes.push(this.prefs.ringUntil);
    const wakeAt = wakes.reduce<number | undefined>(
      (soonest, at) => (at === undefined ? soonest : soonest === undefined ? at : Math.min(soonest, at)),
      undefined,
    );
    if (wakeAt !== undefined) {
      this.timer = this.setTimer(() => {
        this.timer = undefined;
        this.inboxChanged();
        this.schedule();
      }, Math.max(1000, wakeAt - now));
    }
  }

  private log(line: string): void {
    this.options.log?.(line);
  }

  stop(): void {
    this.closeBoard();
    this.timer?.cancel();
    this.timer = undefined;
    this.login.cancel();
  }
}
