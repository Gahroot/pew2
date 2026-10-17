/**
 * pew2 daemon.
 *
 * Runs on the user's machine. Owns provider discovery, agent processes, and the
 * per-session event log, then bridges all of it to the relay over one WebSocket.
 *
 * It is deliberately the fan-out point: ACP is a 1-client-to-1-agent protocol,
 * so the daemon — not the agent — is what lets a phone and a desktop observe the
 * same session at the same time.
 */
import {
  loadProviders,
  isAvailable,
  unavailableReason,
  userProvidersDir,
} from "./providers/registry.js";
import type { AskAnswer } from "./acp/connect.js";
import { SessionLog } from "./session/log.js";
import { readDisabled } from "./providers/enabled.js";
import { discardAttachments } from "./attachments.js";
import { folderName } from "./workspace.js";
import { writeConfigPref } from "./config-prefs.js";
import { writeSessionPrefs } from "./session-prefs.js";
import { pushVoiceEvent } from "./push.js";
import { VoipSender } from "./voip.js";
import { readKnownProjects } from "./known-projects.js";
import { foldProjects } from "./projects.js";
import { VoiceService } from "./voice/service.js";
import { daveClient } from "./voice/dave.js";
import type { VoiceHost } from "./voice/dispatcher.js";
import type { RunningSession, SessionPeek } from "./voice/types.js";
import { DesktopActivityWatcher, defaultDeskRoots, toWire } from "./desktop-activity/watcher.js";
import { dirname } from "node:path";
import type { wire } from "@pew2/protocol";
import { DaemonConnectSession } from "./daemon/connect-session.js";
import {
  GG_GOALS_ID,
  GG_PROVIDER_ID,
  REPLAY_BATCH_SIZE,
  goalsProviderFrom,
  queuedForWire,
  rememberTurnText,
  type ActiveSession,
} from "./daemon/types.js";

export {
  GG_GOALS_ID,
  GG_PROVIDER_ID,
  goalsRoot,
  withStoredPrefs,
  type PromptOutcome,
  type ProviderCapabilities,
} from "./daemon/types.js";

export class Daemon extends DaemonConnectSession {
  /** Point the daemon at a transport. Called with the relay socket's `send`. */
  attach(send: (message: unknown) => void) {
    this.send = send;
    // Started here rather than in the constructor so building a Daemon in a test
    // does not leave a timer running. `unref` for the same reason: this must
    // never be the thing keeping the process alive.
    if (!this.reaper) {
      this.reaper = setInterval(() => this.reapIdleSessions(), Daemon.REAP_INTERVAL_MS);
      this.reaper.unref?.();
    }
    this.startVoice();
  }

  /** Record a pending update and tell every client at once. */
  setUpdateStatus(status: { latest: string; automatic: boolean } | undefined) {
    this.updateStatus = status;
    this.announceProviders();
  }

  /**
   * Why this daemon is not safe to end right now, or undefined if it is.
   *
   * "Quiet" is the precondition for exiting to pick up a new binary. It is not
   * about elapsed time: a session can be silent for minutes while an agent
   * thinks or runs a long tool, and ending the process then loses that turn's
   * work with no way to resume it mid-flight.
   *
   * Three things make a daemon busy, and each is a different kind of loss:
   * a turn in flight (`working`) would be abandoned mid-write; an open
   * permission is a question already on someone's screen, and killing it makes
   * the tap do nothing; a session still opening has an agent process spawned
   * and not yet usable, which would be leaked rather than closed cleanly.
   *
   * Returns a reason rather than a boolean so a caller can log *why* it is
   * waiting — a daemon that never seems to update is otherwise unexplainable.
   */
  busyReason(): string | undefined {
    for (const [sessionId, session] of this.sessions) {
      if (session.working) return `session ${sessionId} is mid-turn`;
      if (
        (session.permissions?.size ?? 0) > 0 ||
        (session.working && (session.asks?.size ?? 0) > 0)
      ) {
        return `session ${sessionId} is waiting on an approval`;
      }
      if (!session.agentSessionId) return `session ${sessionId} is still opening`;
    }
    return undefined;
  }

  /**
   * End one conversation and release everything it holds.
   *
   * The single close path, because there are four callers — the idle reaper, the
   * live-session cap, an agent being disabled, and shutdown — and each used to
   * do its own subset. Only shutdown discarded the attachment files, so every
   * photo sent to a conversation that was later reaped stayed in the tempdir for
   * the daemon's lifetime.
   *
   * Deliberately silent: the callers batch one `announceProviders` per pass,
   * because the message is a full snapshot of `activeSessions`.
   */
  private closeSession(sessionId: string, session: ActiveSession) {
    // Every device closes the card on this, before the session goes.
    for (const requestId of [...(session.asks?.keys() ?? [])]) this.closeAsk(session, requestId);
    if (session.replayTimer) clearTimeout(session.replayTimer);
    session.replayTimer = undefined;
    session.handle?.close();
    // The files were only ever a delivery mechanism for the agent that is now
    // gone. Best effort, and in the tempdir either way.
    void discardAttachments(session.log.sessionId);
    this.sessions.delete(sessionId);
  }

  /**
   * Close agents for conversations nobody has touched in a long time.
   *
   * The process is the expensive part, not the conversation: the transcript is
   * on disk and the agent keeps its own history, so a closed session reopens by
   * resuming. What is being reclaimed is a language server sitting at 90-370MB
   * for a chat that was finished hours ago.
   *
   * Clients are told through the ordinary `providers` announce, whose
   * `activeSessions` is exactly the list of sessions this process still holds.
   * The app already reacts to an id disappearing from it — that is how it
   * survives a daemon restart — and resumes the conversation on screen instead
   * of prompting an id that no longer exists. Reaping deliberately reuses that
   * path rather than inventing a second one, so an older app on TestFlight
   * handles this correctly too.
   *
   * @param now Injectable for tests; the reaper is on an hour-long clock.
   * @returns The session ids closed.
   */
  reapIdleSessions(now: number = Date.now()): string[] {
    const reaped: string[] = [];
    for (const [sessionId, session] of this.sessions) {
      // A turn in flight is never idle, however quiet it has gone: an agent can
      // spend minutes inside one tool call without emitting anything. Unless it
      // is not working at all but waiting on an approval nobody answered, which
      // is the one kind of stopped that lasts for ever.
      // An open ask_user question is the same kind of wait.
      // Only while working: an idle session with an open ask is just idle.
      const blocked =
        (session.permissions?.size ?? 0) > 0 ||
        (session.working === true && (session.asks?.size ?? 0) > 0);
      if (session.working && !blocked) continue;
      const ttl = blocked ? Daemon.BLOCKED_TTL_MS : Daemon.SESSION_TTL_MS;
      if (now - session.lastUsedAt < ttl) continue;
      // Nothing to resume from means nothing to come back to. A conversation
      // the agent never named would be lost rather than closed, so it is kept
      // — these are rare and short-lived, since the id arrives during the
      // handshake.
      if (!session.agentSessionId) continue;
      this.closeSession(sessionId, session);
      reaped.push(sessionId);
    }
    // Announce once for the whole pass, not once per session: the message is a
    // full snapshot, so repeating it per id would be the same list several times.
    if (reaped.length > 0) this.announceProviders();
    return reaped;
  }

  /**
   * Close the least recently used conversations until only `MAX_LIVE_SESSIONS`
   * hold an agent. Called as a new one opens, so the ceiling is enforced at the
   * moment memory would actually grow rather than up to five minutes later.
   *
   * Least recently *used*, not oldest: a conversation started this morning and
   * still being worked in outranks one opened ten minutes ago and abandoned.
   *
   * @param exempt The session being opened, which must never be the one closed.
   * @returns The session ids closed.
   */
  private enforceSessionCap(exempt: string): string[] {
    const closable = [...this.sessions.entries()]
      // Same three exclusions the reaper uses, for the same reasons: a turn in
      // flight would lose work, and a conversation the agent never named has
      // nothing to resume from, so closing it loses it rather than parks it.
      .filter(([id, s]) => id !== exempt && !s.working && s.agentSessionId !== undefined)
      .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);

    const excess = this.sessions.size - Daemon.MAX_LIVE_SESSIONS;
    const closed: string[] = [];
    for (const [sessionId, session] of closable.slice(0, Math.max(0, excess))) {
      this.closeSession(sessionId, session);
      closed.push(sessionId);
    }
    // Same announce the reaper sends, and for the same reason: `activeSessions`
    // is how a client learns an id it still lists no longer exists here. Without
    // it the phone would keep offering a conversation whose agent is gone and
    // prompt it, which fails with "Unknown session" instead of resuming.
    if (closed.length > 0) this.announceProviders();
    return closed;
  }

  /** Rescan `providers/`. Safe to call at any time — this is what makes a newly
   *  added manifest show up on the phone without a restart. */
  async refreshProviders(): Promise<{ errors: { source: string; message: string }[] }> {
    const { providers, errors } = await loadProviders();
    const gg = providers.findIndex((p) => p.manifest.id === GG_PROVIDER_ID);
    const ggProvider = providers[gg];
    if (ggProvider && !providers.some((p) => p.manifest.id === GG_GOALS_ID)) {
      providers.splice(gg + 1, 0, goalsProviderFrom(ggProvider));
    }
    this.providers = providers;
    // Re-read every refresh, so `pew2 providers disable` takes effect without
    // restarting the daemon.
    this.disabled = await readDisabled();
    this.closeDisabled();
    this.announceProviders();
    return { errors };
  }

  /**
   * Stop agents the user has just turned off.
   *
   * Turning one off only ever stopped it being announced, probed or spawned
   * *next* time. Anything already running kept running, so a machine that had
   * warmed Cline and Qwen before they were deselected still had both resident
   * hours later — which reads as the switch not working, and is the whole
   * reason someone turns an agent off.
   */
  private closeDisabled() {
    for (const [key, spare] of this.spares) {
      if (this.isEnabled(spare.providerId)) continue;
      clearTimeout(spare.timer);
      spare.handle.close();
      this.spares.delete(key);
    }
    for (const [sessionId, session] of this.sessions) {
      if (this.isEnabled(session.providerId)) continue;
      // A turn in flight is left alone. Killing an agent mid-answer would lose
      // work the user is waiting on, and the session is reaped on its own clock
      // once it finishes.
      if (session.working) continue;
      this.closeSession(sessionId, session);
    }
  }

  /** Whether an agent may be announced, probed, or spawned. */
  protected isEnabled(providerId: string): boolean {
    return !this.disabled.has(providerId);
  }

  private announceProviders() {
    const announce: wire.ProviderAnnounce = {
      t: "providers",
      machine: this.machine,
      providers: this.providers
        // Test fixtures are hidden unless explicitly asked for, so a demo or a
        // local run can still exercise the pipeline without any API keys.
        .filter((p) => !p.manifest.pew.experimental || this.includeExperimental)
        // Turned off by the user. Filtered here rather than in the app, so the
        // phone is never even told about an agent it should not offer.
        .filter((p) => this.isEnabled(p.manifest.id))
        // GG Goals rides ggcoder: never announced without it.
        .filter((p) => p.manifest.id !== GG_GOALS_ID || this.isEnabled(GG_PROVIDER_ID))
        // Not on this machine at all. Nothing about it can be acted on from a
        // phone \u2014 you cannot install a CLI from there \u2014 so a dimmed row for it
        // is a permanent piece of furniture that never becomes useful.
        //
        // This is also what makes the phone agree with `pew2 setup`: the picker
        // will not let these be chosen, so announcing them showed agents the
        // user was never offered. An agent that is installed but still needs a
        // key is a different case and stays, because it is really here and the
        // reason says what to do about it.
        .filter((p) => !p.commandMissing)
        .map((p) => ({
          id: p.manifest.id,
          name: p.manifest.name,
          description: p.manifest.description,
          transport: p.manifest.pew.transport,
          color: p.manifest.pew.color,
          requiresWorkspace: p.manifest.pew.requiresWorkspace,
          available: isAvailable(p),
          unavailableReason: unavailableReason(p),
        })),
      // Which sessions this process actually holds. A client's list outlives
      // the daemon, so this is how it learns that an id it still shows died
      // with the previous process and must be resumed, not prompted.
      activeSessions: [...this.sessions.keys()],
      // Omitted entirely when there is nothing to say, so an app that has been
      // told once does not keep a stale banner when the update lands.
      update: this.updateStatus,
    };
    this.send(announce);
  }

  /**
   * Append to the session's log, sending only once the session is live.
   *
   * The log gets every event either way — seqs stay gapless, so the flush in
   * `markLive` and the reconnect replay both see the complete history.
   */
  protected record(session: ActiveSession, payload: unknown) {
    // Voice tasks follow their session through this one tap, so the voice layer
    // sees exactly what the app sees rather than a second subscription.
    this.voiceReady?.orchestrator.onSessionPayload(session.log.sessionId, payload);
    rememberTurnText(session, payload);
    const event = session.log.append(payload);
    if (!session.live) return;
    if (!session.streamingReplay) {
      this.send(event);
      return;
    }
    (session.pendingReplay ??= []).push(event);
    // ACP can deliver a thousand notifications in one event-loop turn; a timer
    // cannot fire during that burst, so flush by size as well as by frame.
    if (session.pendingReplay.length >= REPLAY_BATCH_SIZE) {
      this.flushStreamingReplay(session, false);
      return;
    }
    if (!session.replayTimer) {
      session.replayTimer = setTimeout(() => this.flushStreamingReplay(session, false), 16);
      session.replayTimer.unref?.();
    }
  }

  private flushStreamingReplay(session: ActiveSession, complete: boolean) {
    if (session.replayTimer) clearTimeout(session.replayTimer);
    session.replayTimer = undefined;
    const events = session.pendingReplay?.splice(0) ?? [];
    if (events.length > 0 || complete) {
      this.send({ t: "session.replay", sessionId: session.log.sessionId, events, complete });
    }
  }

  /**
   * Tell clients about everything a session has already produced.
   *
   * Callers broadcast `session.started` first; this is what guarantees a client
   * never sees an event for a session it has not been introduced to.
   */
  markLive(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session || session.live) return;
    session.live = true;
    // The backlog goes out as one batched frame rather than hundreds: the app
    // folds it into a single render. An empty frame still matters because it
    // marks a resumed transcript as fully loaded and dismisses its skeleton.
    const backlog = session.log.since(-1);
    this.send({ t: "session.replay", sessionId, events: backlog });
  }

  /** Announce first, then reveal resume history in frame-sized batches. */
  markStreaming(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session || session.live) return;
    session.live = true;
    session.streamingReplay = true;
    session.pendingReplay = session.log.since(-1);
    this.flushStreamingReplay(session, false);
  }

  finishStreaming(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.flushStreamingReplay(session, true);
    session.streamingReplay = false;
  }

  async startSession(providerId: string, cwd: string): Promise<string> {
    const provider = this.providers.find((p) => p.manifest.id === providerId);
    if (!provider) throw new Error(`Unknown provider '${providerId}'`);
    // Checked here too, not just where the list is announced. A phone that
    // connected before the agent was turned off still holds the old list, and
    // tapping one of those rows would otherwise spawn the very process that
    // turning it off was meant to prevent.
    if (!this.isEnabled(providerId)) {
      throw new Error(`'${provider.manifest.name}' is turned off on this machine.`);
    }
    if (!isAvailable(provider)) throw new Error(unavailableReason(provider)!);

    // Assign our own session id up front so events are attributable even if the
    // agent's own `session/new` is slow or fails.
    const log = new SessionLog(`${providerId}-${Date.now().toString(36)}`);
    // Registered before connecting so `record` has somewhere to hold events the
    // agent emits during the handshake itself.
    const session: ActiveSession = {
      handle: undefined,
      log,
      providerId,
      cwd,
      live: false,
      lastUsedAt: Date.now(),
      ready: Promise.resolve(),
    };
    this.sessions.set(log.sessionId, session);
    // Enforced as it opens, not on the reaper's five-minute tick: this is the
    // moment memory grows, and someone opening several conversations in a burst
    // would otherwise hold all of them until the next pass.
    this.enforceSessionCap(log.sessionId);

    try {
      await this.connectSession(session, provider, cwd, undefined);
    } catch (error) {
      // A session that never connected has no history worth keeping, and
      // leaving it registered would answer prompts with a broken handle.
      this.sessions.delete(log.sessionId);
      throw error;
    }

    return log.sessionId;
  }

  /**
   * The agent's own id for a session, once it has opened one.
   *
   * Clients list the agent's stored conversations alongside their own, so a
   * session started here has to name itself in the agent's terms — otherwise
   * the next history probe lists the very conversation on screen a second time
   * as a stub, and reopening *that* copy loses the session's settings.
   */
  agentSessionId(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.agentSessionId;
  }

  /** Selectors (model, thinking level, mode) advertised by a session's agent. */
  configOptions(sessionId: string) {
    return this.sessions.get(sessionId)?.handle?.configOptions ?? [];
  }

  /** Begin restoring immediately; callers can announce before the agent is ready. */
  beginResumeSession(providerId: string, agentSessionId: string, cwd: string) {
    const provider = this.providers.find((p) => p.manifest.id === providerId);
    if (!provider) throw new Error(`Unknown provider '${providerId}'`);
    // Checked here too, not just where the list is announced. A phone that
    // connected before the agent was turned off still holds the old list, and
    // tapping one of those rows would otherwise spawn the very process that
    // turning it off was meant to prevent.
    if (!this.isEnabled(providerId)) {
      throw new Error(`'${provider.manifest.name}' is turned off on this machine.`);
    }
    if (!isAvailable(provider)) throw new Error(unavailableReason(provider)!);

    const log = new SessionLog(`${providerId}-${Date.now().toString(36)}`);
    const session: ActiveSession = {
      handle: undefined,
      log,
      providerId,
      cwd,
      live: false,
      lastUsedAt: Date.now(),
      ready: Promise.resolve(),
    };
    this.sessions.set(log.sessionId, session);
    // Enforced as it opens, not on the reaper's five-minute tick: this is the
    // moment memory grows, and someone opening several conversations in a burst
    // would otherwise hold all of them until the next pass.
    this.enforceSessionCap(log.sessionId);
    session.ready = this.connectSession(session, provider, cwd, agentSessionId);
    return { sessionId: log.sessionId, ready: session.ready };
  }

  async resumeSession(providerId: string, agentSessionId: string, cwd: string) {
    const pending = this.beginResumeSession(providerId, agentSessionId, cwd);
    try {
      await pending.ready;
      return pending.sessionId;
    } catch (error) {
      this.sessions.delete(pending.sessionId);
      throw error;
    }
  }

  /**
   * Record a choice made before any session exists.
   *
   * The empty state offers the same selectors a live conversation does, but a
   * session is only created by the first prompt — so there is nothing to set
   * the option on yet. Storing it here is what makes the pill stick: the
   * session that prompt creates applies it on connect.
   */
  async rememberConfigOption(providerId: string, configId: string, value: string | boolean) {
    await writeConfigPref(providerId, configId, value);
    // Every other client is looking at the same empty state, and one of them
    // just changed what its next prompt will run on.
    void this.publishProviderConfig(providerId).catch(() => {});
  }

  async setConfigOption(sessionId: string, configId: string, value: string | boolean) {
    const session = this.require(sessionId);
    await session.ready;
    const updated = await session.handle!.setConfigOption(configId, value);
    // Only after the agent accepted it: remembering a rejected choice would
    // reapply a broken setting to every session that follows.
    void writeConfigPref(session.providerId, configId, value).catch(() => {});
    // ...and against this conversation, so reopening it restores the choice
    // rather than the agent's default. Both: the provider record seeds the next
    // new session, this one survives leaving and coming back.
    // Only when the agent named the conversation: without an id there is
    // nothing to key the record by, and a placeholder would hand its selectors
    // to the next session that also lacks one.
    const agentSessionId = session.agentSessionId;
    if (agentSessionId) {
      void writeSessionPrefs(session.providerId, agentSessionId, { [configId]: value }).catch(
        () => {},
      );
    }
    // The provider record above is what the *next* conversation opens with, so
    // the empty state has to move with it. Otherwise leaving this conversation
    // showed the selectors it was holding while the next prompt used these.
    void this.publishProviderConfig(session.providerId, updated).catch(() => {});
    return updated;
  }

  async cancel(sessionId: string) {
    const session = this.require(sessionId);
    // A stop takes the queue with it: those messages go back to the composer
    // rather than running after the user said stop.
    if (session.working) session.cancelling = true;
    this.returnQueue(session);
    await session.ready;
    await session.handle!.cancel();
  }

  /** An open ask stopped being open: forget it and log `ask_user_closed` once. */
  protected closeAsk(session: ActiveSession, requestId: string) {
    if (!session.asks?.delete(requestId)) return;
    this.record(session, { kind: "ask_user_closed", requestId });
  }

  /** Answer an open `_gg/ask_user` question. */
  answerAsk(sessionId: string, requestId: string, result: AskAnswer) {
    const session = this.require(sessionId);
    const answered = session.handle?.answerAsk(requestId, result) ?? false;
    if (answered) this.closeAsk(session, requestId);
    return answered;
  }

  answerPermission(sessionId: string, requestId: string, optionId: string) {
    const answered = this.answerPermissionQuietly(sessionId, requestId, optionId);
    // Answered from the app's own sheet: a voice task must leave `blocked` now.
    if (answered) this.voiceReady?.orchestrator.onPermissionAnswered(sessionId, requestId);
    return answered;
  }

  /** The answer itself, without telling the voice layer (it is the one asking). */
  private answerPermissionQuietly(sessionId: string, requestId: string, optionId: string) {
    const session = this.require(sessionId);
    const answered = session.handle?.answerPermission(requestId, optionId) ?? false;
    // Only on a real answer. A `false` means the connection had no such request
    // — a stale sheet from a previous turn, or a second client answering one
    // that was already resolved — and forgetting it here on that basis would
    // hide a *different*, still-open request from the next catch-up.
    if (answered) session.permissions?.delete(requestId);
    return answered;
  }

  /**
   * Every live conversation in the sidebar's own three states, for the voice
   * model. Same rule as the app's `rowMark`: blocked on the user beats working
   * beats at rest. Sessions still opening are skipped; nothing can be said of them.
   */
  runningSessions(): RunningSession[] {
    const now = Date.now();
    const out: RunningSession[] = [];
    for (const [sessionId, session] of this.sessions) {
      if (!session.agentSessionId) continue;
      const blocked = (session.permissions?.size ?? 0) > 0 || (session.working === true && (session.asks?.size ?? 0) > 0);
      out.push({
        sessionId,
        providerId: session.providerId,
        agentName: this.providers.find((p) => p.manifest.id === session.providerId)?.manifest.name,
        cwd: session.cwd,
        state: blocked ? "needs_you" : session.working ? "working" : "idle",
        idleMs: Math.max(0, now - session.lastUsedAt),
        origin: "pew2",
      });
    }
    // Conversations started at the computer, read from the agents' own files.
    for (const desk of this.desktopSessions()) {
      out.push({
        sessionId: `desk:${desk.providerId}:${desk.agentSessionId}`,
        providerId: desk.providerId,
        agentName: this.providers.find((p) => p.manifest.id === desk.providerId)?.manifest.name,
        cwd: desk.cwd,
        state: desk.state,
        idleMs: Math.max(0, now - desk.updatedAt),
        origin: "desktop",
        ...(desk.title ? { title: desk.title } : null),
        ...(desk.tool ? { tool: desk.tool } : null),
      });
    }
    return out;
  }

  /**
   * What one open conversation is doing, for voice's `peek_session`. A `desk:`
   * id reads the transcript watcher; a held session has only its turn text.
   */
  peekSession(sessionId: string): SessionPeek | undefined {
    if (sessionId.startsWith("desk:")) {
      const rest = sessionId.slice("desk:".length);
      const desk = this.desktopSessions().find((d) => `${d.providerId}:${d.agentSessionId}` === rest);
      if (!desk) return undefined;
      return {
        ...(desk.lastPrompt ? { lastPrompt: desk.lastPrompt } : null),
        ...(desk.lastText ? { latest: desk.lastText } : null),
        ...(desk.tool ? { tool: desk.tool } : null),
      };
    }
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    return session.turnText ? { latest: session.turnText } : {};
  }

  private desk?: DesktopActivityWatcher;

  /**
   * Watch the agents' transcript files for conversations started at the desk.
   * Called from `server.ts` only, never from `attach()`, so a Daemon built in a
   * test never reads the real home directory. `PEW2_DESKTOP_ACTIVITY=off` disables it.
   */
  startDesktopActivity(roots = defaultDeskRoots(this.env)) {
    if (this.desk || this.env.PEW2_DESKTOP_ACTIVITY === "off") return;
    const loaded = new Set(this.providers.filter((p) => !p.commandMissing).map((p) => p.manifest.id));
    this.desk = new DesktopActivityWatcher({
      roots: roots.filter((r) => loaded.has(r.providerId) && this.isEnabled(r.providerId)),
      ownedAgentSessionIds: () =>
        new Set([...this.sessions.values()].flatMap((s) => (s.agentSessionId ? [s.agentSessionId] : []))),
      onChange: () => this.send(this.desktopActivity()),
    });
    this.desk.start();
  }

  /** Desk sessions for providers still enabled; a provider switched off since boot goes quiet. */
  private desktopSessions() {
    return (this.desk?.snapshot() ?? []).filter((d) => this.isEnabled(d.providerId));
  }

  /** The `desktop.activity` frame: answered to every client hello and broadcast on change. */
  desktopActivity(): wire.DesktopActivity {
    return { t: "desktop.activity", sessions: this.desktopSessions().slice(0, 64).map(toWire) };
  }

  /**
   * Where this session's agent is running, for resolving the relative paths it
   * uses to name files. Undefined once the session is gone, in which case the
   * caller falls back to the daemon's own workspace.
   */
  /** Which provider a live session runs under, if any. */
  sessionProvider(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.providerId;
  }

  sessionCwd(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.cwd;
  }

  /**
   * Who ran this session and in which project, for the "agent finished"
   * notification.
   *
   * Only this machine has the path, and the phone must be able to name the
   * work even for a session it is not currently showing — which is exactly the
   * case a notification exists for.
   */
  sessionOrigin(sessionId: string): { providerId?: string; folder?: string } {
    const session = this.sessions.get(sessionId);
    if (!session) return {};
    return { providerId: session.providerId, folder: folderName(session.cwd) };
  }

  /**
   * Everything a push notification for a finished turn needs to say.
   *
   * Separate from `sessionOrigin` because the two have different audiences. That
   * one feeds `session.idle` on the wire, where the app resolves `providerId`
   * against the provider list it already holds. A push has no app to resolve
   * anything: the text is rendered by iOS with no JavaScript running, so the
   * agent's display name has to be looked up here.
   */
  sessionNotice(sessionId: string): { folder?: string; agentName?: string; lastText?: string } {
    const session = this.sessions.get(sessionId);
    if (!session) return {};
    return {
      folder: folderName(session.cwd),
      agentName: this.providers.find((p) => p.manifest.id === session.providerId)?.manifest.name,
      lastText: session.turnText,
    };
  }

  /** Replay everything a reconnecting client has not seen yet. */
  replay(sessionId: string, cursor: number): wire.SessionEvent[] {
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    // Reading a conversation is using it. Without this, a session someone is
    // sitting in — scrolling, reading a long answer — aged out on the same
    // clock as one nobody had opened since breakfast.
    session.lastUsedAt = Date.now();
    return session.log.since(cursor);
  }

  /**
   * Frames that bring a reconnecting client level with what it missed.
   *
   * A phone loses its socket constantly — the screen locks, iOS suspends the
   * app, the radio switches from wifi to cellular, the relay drops a room. The
   * agent does not stop for any of that, and a frame sent while the socket is
   * down is gone: the relay stores nothing and `RelayClient.send` drops it.
   *
   * So the client names the highest `seq` it holds per session in its `hello`,
   * and this answers with the rest. Without it a phone that blinked mid-turn
   * silently resumed at the live edge, and the first thing the user saw was a
   * shell command from twenty seconds into work it had watched none of.
   *
   * Only sessions the client already knows about: a client is introduced to a
   * session by `session.started`, and an event for one it has never heard of
   * has nowhere to go. Cursors name exactly the sessions it has seen.
   */
  catchUp(cursors: Record<string, number>): wire.Replay[] {
    const frames: wire.Replay[] = [];
    for (const [sessionId, cursor] of Object.entries(cursors)) {
      const session = this.sessions.get(sessionId);
      // Not live means clients were never told it exists; replaying into that
      // would break the same invariant `markLive` exists to hold.
      if (!session || !session.live) continue;
      const events = this.replay(sessionId, cursor);
      const permissions = [...(session.permissions ?? [])].map(([requestId, params]) => ({
        requestId,
        params,
      }));
      // A client that missed nothing still needs the running flag: it may have
      // been away for the `session.idle` that ended the turn it last saw.
      //
      // Every known session gets a frame, including one with nothing to report.
      // "No events, not working, nothing pending" is not silence — it is the
      // answer that dismisses an approval sheet the user resolved at the desk
      // while this phone was away, and skipping it left that sheet up for ever,
      // wired to a requestId the daemon has already forgotten.
      frames.push({
        t: "session.replay",
        sessionId,
        events,
        complete: true,
        catchUp: true,
        working: session.working === true,
        // Always sent, empty array included. The app reads an *absent* field as
        // "an older daemon says nothing, leave any open sheet alone" and an
        // empty one as "nothing is pending, dismiss it" — so omitting it made
        // the second case unreachable.
        permissions,
        // Same absent/empty rule as permissions.
        queued: (session.queue ?? []).map(queuedForWire),
        asks: [...(session.asks ?? [])].map(([requestId, questions]) => ({
          requestId,
          questions: questions as wire.AskQuestion[],
        })),
        // Only a goal's coordinator has one; absent otherwise.
        ...(session.goal ? { goal: session.goal } : {}),
        ...(session.plan ? { plan: session.plan } : {}),
        ...(session.autopilot ? { autopilot: session.autopilot } : {}),
      });
    }
    return frames;
  }

  // ---- voice orchestration -------------------------------------------------

  private voipSender?: VoipSender;

  /** Sends iPhone rings when `pew2 voice apns` is configured; reads that config per ring, so setup needs no restart. */
  private get voip(): VoipSender {
    this.voipSender ??= new VoipSender({ dataDir: dirname(userProvidersDir(this.env)) });
    return this.voipSender;
  }

  private voiceReady?: VoiceService;
  private voiceStarting?: Promise<VoiceService>;

  /**
   * The voice service, created on first use and also at boot (`attach`) so a
   * task the previous process was running is reconciled as soon as the daemon
   * is up rather than when someone first speaks.
   */
  voice(): Promise<VoiceService> {
    this.voiceStarting ??= VoiceService.create({
      dataDir: dirname(userProvidersDir(this.env)),
      env: this.env,
      emit: (message) => this.send(message),
      host: this.voiceHost(),
      projectPaths: () => this.voiceProjectPaths(),
      usableProviders: () =>
        this.providers
          .filter((p) => this.isEnabled(p.manifest.id) && isAvailable(p))
          .map((p) => p.manifest.id),
      runningSessions: () => this.runningSessions(),
      peekSession: (sessionId) => this.peekSession(sessionId),
      dave: daveClient(this.env),
      push: (event) => pushVoiceEvent(this.pushTargets, event, fetch, { voip: this.voip }),
    }).then((service) => (this.voiceReady = service));
    return this.voiceStarting;
  }

  private startVoice() {
    void this.voice().catch((error: unknown) => {
      console.error("[voice] could not start:", error);
    });
  }

  /** Project directories voice may name: chosen ones plus everything agents have history in. */
  private async voiceProjectPaths(): Promise<string[]> {
    const paths = new Set(await readKnownProjects(this.env));
    for (const sessions of this.projectHistory.values()) {
      for (const project of foldProjects(sessions)) paths.add(project.path);
    }
    return [...paths];
  }

  /** The daemon's existing session machinery, as the orchestrator sees it. */
  private voiceHost(): VoiceHost {
    return {
      startSession: async (providerId, cwd, tag) => {
        // Remembered so the app, which only honours directories this daemon published, can open the session.
        await this.knownProject(providerId, cwd).catch(() => undefined);
        const sessionId = await this.startSession(providerId, cwd);
        this.send({
          t: "session.started",
          sessionId,
          providerId,
          cwd,
          requestId: `voice:${tag}`,
          configOptions: this.configOptions(sessionId),
          agentSessionId: this.agentSessionId(sessionId),
        });
        this.markLive(sessionId);
        return sessionId;
      },
      prompt: async (sessionId, text, attachments = []) => {
        try {
          // The chat path's own: stored in the session's attachment directory,
          // echoed on every screen, and delivered in whichever block form the
          // agent says it accepts (`promptBlocks.ts`).
          await this.prompt(sessionId, text, [...attachments]);
        } finally {
          this.send({ t: "session.idle", sessionId, ...this.sessionOrigin(sessionId) });
        }
      },
      cancel: (sessionId) => this.cancel(sessionId),
      answerPermission: (sessionId, requestId, optionId) =>
        this.answerPermissionQuietly(sessionId, requestId, optionId),
      hasSession: (sessionId) => this.sessions.has(sessionId),
      lastText: (sessionId) => this.sessions.get(sessionId)?.turnText,
    };
  }

  closeAll() {
    this.desk?.stop();
    this.desk = undefined;
    if (this.reaper) {
      clearInterval(this.reaper);
      this.reaper = undefined;
    }
    for (const [sessionId, session] of [...this.sessions]) {
      this.closeSession(sessionId, session);
    }
    this.sessions.clear();
    for (const spare of this.spares.values()) {
      clearTimeout(spare.timer);
      spare.handle.close();
    }
    this.spares.clear();
    this.voiceReady?.dispose();
  }

  protected require(sessionId: string): ActiveSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown session '${sessionId}'`);
    return session;
  }
}

if (import.meta.main) {
  const daemon = new Daemon({ id: "local", name: "this machine" });
  daemon.attach((message) => console.log(JSON.stringify(message)));

  const { errors } = await daemon.refreshProviders();
  for (const error of errors) console.error(error.message);

  process.on("SIGINT", () => {
    daemon.closeAll();
    process.exit(0);
  });
}
