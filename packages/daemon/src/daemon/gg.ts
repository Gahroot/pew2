/**
 * GG Coder's ACP extensions: plan review, Autopilot, the project checklist,
 * goal state, and the goals themselves (`_gg/goals/*`, `_gg/goal/*`).
 */
import { isAvailable, unavailableReason } from "../providers/registry.js";
import { connectProvider, type AcpSessionHandle } from "../acp/connect.js";
import { resolve as __resolve } from "node:path";
import { resolveWorkspace } from "../workspace.js";
import { humanError } from "../errors.js";
import { wire } from "@pew2/protocol";
import { DaemonProjects } from "./projects.js";
import {
  AUTOPILOT_PHASES,
  GG_GOALS_BACKEND,
  GOALS_BACKENDS,
  goalsBackend,
  isGoalsId,
  type ActiveSession,
  type GoalsBackend,
} from "./types.js";

export abstract class DaemonGg extends DaemonProjects {
  /** `_gg/plan_state`: the plan sheet's state, broadcast and kept for catch-up. */
  protected applyPlanState(session: ActiveSession, params: unknown) {
    const raw = params as { planMode?: unknown; pending?: unknown } | null;
    const parsed = wire.PlanState.safeParse({
      t: "plan.state",
      sessionId: session.log.sessionId,
      planMode: raw?.planMode === true,
      pending: raw?.pending ?? null,
    });
    if (!parsed.success) return;
    session.plan = parsed.data;
    if (session.live) this.send(parsed.data);
  }

  /** `_gg/session_reset`: an accepted plan moved the agent to a fresh on-disk session. */
  protected applySessionReset(session: ActiveSession, params: unknown) {
    const raw = params as { agentSessionId?: unknown; planTotal?: unknown } | null;
    // Resume must reopen the NEW conversation, which holds the implementation.
    if (typeof raw?.agentSessionId === "string" && raw.agentSessionId) {
      session.agentSessionId = raw.agentSessionId;
    }
    this.record(session, {
      kind: "plan_accepted",
      ...(typeof raw?.planTotal === "number" ? { planTotal: raw.planTotal } : {}),
    });
  }

  /** `_gg/autopilot_state`: whether Ken is on / reviewing; live state, never logged. */
  protected applyAutopilotState(session: ActiveSession, params: unknown) {
    const raw = params as { enabled?: unknown; reviewing?: unknown } | null;
    const state: wire.AutopilotState = {
      t: "autopilot.state",
      sessionId: session.log.sessionId,
      enabled: raw?.enabled === true,
      reviewing: raw?.reviewing === true,
    };
    session.autopilot = state;
    if (session.live) this.send(state);
  }

  /** `_gg/autopilot_event`: one of Ken's verdicts, logged; `human`/`capped` also push. */
  protected applyAutopilotEvent(session: ActiveSession, params: unknown) {
    const raw = params as { phase?: unknown; reason?: unknown; body?: unknown; round?: unknown } | null;
    if (typeof raw?.phase !== "string" || !AUTOPILOT_PHASES.has(raw.phase)) return;
    session.lastUsedAt = Date.now();
    this.record(session, {
      kind: "autopilot",
      phase: raw.phase,
      ...(typeof raw.reason === "string" ? { reason: raw.reason } : {}),
      ...(typeof raw.body === "string" ? { body: raw.body } : {}),
      ...(typeof raw.round === "number" ? { round: raw.round } : {}),
    });
    if ((raw.phase === "human" || raw.phase === "capped") && (params as { history?: unknown }).history !== true) {
      const sessionId = session.log.sessionId;
      const reason = typeof raw.reason === "string" && raw.reason ? `: ${raw.reason}` : "";
      this.notifyPhones(sessionId, "finished", `Ken needs you${reason}`);
    }
  }

  /** `autopilot.set`: turn Ken on or off for this session's project. */
  async setAutopilot(sessionId: string, enabled: boolean): Promise<void> {
    const session = this.require(sessionId);
    if (isGoalsId(session.providerId)) throw new Error("Autopilot is for GG Coder conversations.");
    await session.ready;
    if (!session.handle?.ggCapabilities?.autopilot) throw new Error("This agent has no Autopilot.");
    await session.handle.extRequest("_gg/autopilot/set", {
      sessionId: session.handle.sessionId,
      enabled,
    });
  }

  /** `checklist`: the project checklist via `_gg/checklist`, mapped to wire rows. */
  async checklist(sessionId: string): Promise<{ staleAfterDays?: number; items: wire.ChecklistItemRow[] }> {
    const session = this.require(sessionId);
    if (isGoalsId(session.providerId)) throw new Error("The checklist is for GG Coder conversations.");
    await session.ready;
    if (!session.handle?.ggCapabilities?.checklist) throw new Error("This agent has no project checklist.");
    const raw = await session.handle.extRequest<{ staleAfterDays?: unknown; items?: unknown }>(
      "_gg/checklist",
      { sessionId: session.handle.sessionId },
    );
    const items = (Array.isArray(raw?.items) ? raw.items : []).flatMap((item) => {
      const parsed = wire.ChecklistItemRow.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    });
    return {
      ...(typeof raw?.staleAfterDays === "number" ? { staleAfterDays: raw.staleAfterDays } : {}),
      items,
    };
  }

  /** `_gg/goal_state`: the goal's live phase and workers, broadcast and kept for catch-up. */
  protected applyGoalState(session: ActiveSession, params: unknown) {
    const raw = params as {
      goalId?: unknown;
      phase?: unknown;
      paused?: unknown;
      critterModel?: unknown;
      workers?: unknown;
    } | null;
    if (typeof raw?.goalId !== "string") return;
    const workers = (Array.isArray(raw.workers) ? raw.workers : []).flatMap((worker) => {
      const parsed = wire.GoalWorker.safeParse(worker);
      return parsed.success ? [parsed.data] : [];
    });
    const state: wire.GoalState = {
      t: "goal.state",
      sessionId: session.log.sessionId,
      goalId: raw.goalId,
      phase: raw.phase === "active" ? "active" : "briefing",
      paused: raw.paused === true,
      workers,
      ...(typeof raw.critterModel === "string" || raw.critterModel === null
        ? { critterModel: raw.critterModel }
        : {}),
    };
    session.goal = state;
    if (session.live) this.send(state);
  }

  /**
   * Whether this session just opened on a goal that still needs its kickoff
   * turn, claiming it so it can only ever be started once.
   */
  claimKickoff(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session?.handle?.goal?.needsKickoff || session.kickedOff) return false;
    session.kickedOff = true;
    return true;
  }

  // ── Goals (GG Coder) ───────────────────────────────────────

  /**
   * A GG Coder connection that speaks the goals extension.
   *
   * Any process will do — goals live on disk, not in a session — so a live
   * ggcoder session or a warm spare is used first, and only otherwise one is
   * booted (and parked as the spare, so it is reused and idles out).
   */
  protected async goalsConnection(backend: GoalsBackend = GG_GOALS_BACKEND): Promise<AcpSessionHandle> {
    const { agentId, goalsId, agentName } = backend;
    const provider = this.providers.find((p) => p.manifest.id === agentId);
    if (!provider || provider.commandMissing) {
      throw new Error(`${agentName} isn't installed on this machine.`);
    }
    if (!this.isEnabled(agentId)) throw new Error(`${agentName} is turned off on this machine.`);
    if (!isAvailable(provider)) throw new Error(unavailableReason(provider) ?? `${agentName} is unavailable.`);
    const supports = (handle: AcpSessionHandle) => {
      if (!handle.ggCapabilities?.goals) {
        throw new Error(`This ${agentName} is too old for goals. Update it on your computer.`);
      }
      return handle;
    };
    // An exited process still has a handle. A crash, a kill, or a `ggcoder`
    // linked to a checkout whose build had just wiped `dist/` all leave one
    // behind, and handing it out failed every goals request with "ACP
    // connection closed" until the reaper or the spare TTL happened to clear it.
    const alive = (handle: AcpSessionHandle) =>
      handle.child.exitCode === null && handle.child.signalCode === null;
    for (const [key, spare] of this.spares) {
      if (alive(spare.handle)) continue;
      clearTimeout(spare.timer);
      spare.handle.close();
      this.spares.delete(key);
    }
    const ours = (id: string) => id === agentId || id === goalsId;
    const live = [...this.sessions.values()]
      .filter((s) => ours(s.providerId) && s.handle && s.agentSessionId && alive(s.handle))
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt)[0]?.handle;
    if (live) return supports(live);
    const spare = [...this.spares.values()].find((s) => ours(s.providerId));
    if (spare) return supports(spare.handle);
    // A capability probe already booting the agent will park its process as a
    // spare. Wait for that rather than racing it with a second boot: two boots
    // land on the same spare key, and whichever is stashed second closes the
    // first — mid-`session/list` for the probe, which then failed with "ACP
    // connection closed" and left the agent's chats and goals list empty.
    const warming = this.warming.get(agentId);
    if (warming) {
      await warming.catch(() => {});
      const parked = [...this.spares.values()].find((s) => s.providerId === agentId);
      if (parked) return supports(parked.handle);
    }
    let connecting = this.ggConnecting.get(goalsId);
    if (!connecting) {
      connecting = (async () => {
        const workspace = resolveWorkspace();
        const handle = await connectProvider({
          provider,
          cwd: workspace,
          onUpdate: () => {},
          onPermissionRequest: () => {},
        });
        // Never evict a parked process for this one: a probe may still be using
        // it. If one appeared while this booted, keep it and drop the newcomer.
        const parked = [...this.spares.values()].find((s) => s.providerId === agentId);
        if (parked) {
          handle.close();
          return parked.handle;
        }
        this.stashSpare(agentId, handle, workspace);
        return handle;
      })().finally(() => {
        this.ggConnecting.delete(goalsId);
      });
      this.ggConnecting.set(goalsId, connecting);
    }
    return supports(await connecting);
  }

  /** Read one goal summary off GG Coder, dropping anything malformed. */
  protected static readGoal(value: unknown): wire.GoalSummary | undefined {
    // GG Coder sends `null` for a field it has no value for yet: a goal created
    // a moment ago has no coordinator conversation, so `agentSessionId` is null.
    // The wire treats absent as "none", so nulls are dropped before parsing.
    // Rejecting them threw away every new goal ("GG Coder did not return the
    // new goal"), while goals that had run once listed fine.
    if (value && typeof value === "object") {
      value = Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null));
    }
    const parsed = wire.GoalSummary.safeParse(value);
    if (!parsed.success) {
      console.error("[ggcoder] ignoring a malformed goal:", parsed.error.issues[0]?.message);
      return undefined;
    }
    return parsed.data;
  }

  /** The live daemon session open on a goal folder, newest use first. */
  protected goalSessionEntry(path: string, goalsId?: string): [string, ActiveSession] | undefined {
    const backend = goalsId === undefined ? undefined : goalsBackend(goalsId);
    const ours = (id: string) =>
      backend ? id === backend.agentId || id === backend.goalsId : GOALS_BACKENDS.some((b) => id === b.agentId || id === b.goalsId);
    return [...this.sessions.entries()]
      .filter(([, s]) => ours(s.providerId) && s.cwd === path)
      .sort((a, b) => b[1].lastUsedAt - a[1].lastUsedAt)[0];
  }

  /** GG Coder never reports `running` or a daemon session: only this process knows. */
  protected overlayGoal(goal: wire.GoalSummary): wire.GoalSummary {
    const { sessionId: _ignored, ...rest } = goal;
    const live = this.goalSessionEntry(goal.path, goal.providerId);
    if (!live) return rest;
    return {
      ...rest,
      sessionId: live[0],
      ...(live[1].working ? { status: "running" as const } : {}),
    };
  }

  /**
   * Every goal on this machine, overlaid with live state.
   *
   * Listing a goal publishes its folder, so each becomes a known project: the
   * app opens a goal by starting a ggcoder session with that folder as `cwd`.
   */
  async listGoals(goalsIds: readonly string[] = [GG_GOALS_BACKEND.goalsId]): Promise<wire.GoalSummary[]> {
    // One backend missing (no ggcoder here) must not hide another's goals;
    // only when every backend failed is that the answer.
    const all: wire.GoalSummary[] = [];
    let firstError: Error | undefined;
    let anyOk = false;
    for (const goalsId of goalsIds) {
      try {
        all.push(...(await this.listBackendGoals(this.backendFor(goalsId))));
        anyOk = true;
      } catch (error) {
        firstError ??= asError(error);
      }
    }
    if (!anyOk && firstError !== undefined) throw firstError;
    return all;
  }

  protected backendFor(goalsId: string): GoalsBackend {
    const backend = goalsBackend(goalsId);
    if (!backend || backend.goalsId !== goalsId) throw new Error(`Unknown goals provider '${goalsId}'.`);
    return backend;
  }

  /** One backend's goals, stamped with its `providerId` (gg stays unstamped: absent means gg-goals). */
  protected async listBackendGoals(backend: GoalsBackend): Promise<wire.GoalSummary[]> {
    const handle = await this.goalsConnection(backend);
    const answer = await handle.extRequest<{ goals?: unknown }>("_gg/goals/list", {});
    const goals = (Array.isArray(answer?.goals) ? answer.goals : []).flatMap((value) => {
      const goal = this.stampGoal(DaemonGg.readGoal(value), backend);
      return goal ? [goal] : [];
    });
    this.goalNames.set(backend.goalsId, new Map(goals.map((g) => [__resolve(g.path), g.name])));
    for (const goal of goals) await this.rememberProject(goal.path);
    return goals.map((goal) => this.overlayGoal(goal));
  }

  /** gg goals keep today's exact shape; any other backend's goals name their provider. */
  protected stampGoal(goal: wire.GoalSummary | undefined, backend: GoalsBackend): wire.GoalSummary | undefined {
    if (!goal) return undefined;
    return backend.goalsId === GG_GOALS_BACKEND.goalsId ? goal : { ...goal, providerId: backend.goalsId };
  }

  async createGoal(
    input: {
      name: string;
      goal: string;
      context: string[];
      instructions?: string;
    },
    goalsId: string = GG_GOALS_BACKEND.goalsId,
  ): Promise<wire.GoalSummary> {
    const backend = this.backendFor(goalsId);
    const handle = await this.goalsConnection(backend);
    const answer = await handle.extRequest<{ goal?: unknown }>("_gg/goals/create", {
      name: input.name,
      goal: input.goal,
      context: input.context,
      ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
    });
    const goal = this.stampGoal(DaemonGg.readGoal(answer?.goal), backend);
    if (!goal) throw new Error(`${backend.agentName} did not return the new goal.`);
    const names = this.goalNames.get(goalsId) ?? new Map<string, string>();
    names.set(__resolve(goal.path), goal.name);
    this.goalNames.set(goalsId, names);
    await this.rememberProject(goal.path);
    return this.overlayGoal(goal);
  }

  /**
   * One goal by id, with the daemon session open on it, if any. Without a
   * `goalsId` (an older app), gg-goals is searched first, then the others.
   */
  async findGoal(goalId: string, goalsId?: string): Promise<wire.GoalSummary> {
    const ids = goalsId !== undefined ? [goalsId] : GOALS_BACKENDS.map((b) => b.goalsId);
    let firstError: Error | undefined;
    for (const id of ids) {
      try {
        const goal = (await this.listGoals([id])).find((g) => g.id === goalId);
        if (goal) return goal;
      } catch (error) {
        if (goalsId !== undefined) throw error;
        firstError ??= asError(error);
      }
    }
    // A backend that failed says more than "gone" (today's gg-only answer).
    if (firstError !== undefined) throw firstError;
    throw new Error("That goal no longer exists.");
  }

  /** The open session on a goal, for the session-scoped `_gg/goal/*` calls. */
  protected openGoalSession(goal: wire.GoalSummary): { sessionId: string; session: ActiveSession } {
    const session = goal.sessionId ? this.sessions.get(goal.sessionId) : undefined;
    if (!goal.sessionId || !session?.handle) throw new Error("Open the goal first.");
    return { sessionId: goal.sessionId, session };
  }

  /**
   * `delete`, `pause`, `update` and `critterModel`. `resume` needs a session
   * opened through the transport's start/resume flow, so the handler owns it.
   */
  async goalAction(
    goalId: string,
    action: "delete" | "pause" | "update" | "critterModel",
    input: { context?: string[]; instructions?: string; model?: string | null } = {},
    goalsId?: string,
  ): Promise<wire.GoalSummary | undefined> {
    const goal = await this.findGoal(goalId, goalsId);
    const backend = this.backendFor(goal.providerId ?? GG_GOALS_BACKEND.goalsId);
    if (action === "delete") {
      const live = this.goalSessionEntry(goal.path, backend.goalsId);
      if (live?.[1].working) throw new Error(`${backend.name} is working on this goal. Pause it first.`);
      const handle = await this.goalsConnection(backend);
      await handle.extRequest("_gg/goals/delete", { id: goalId });
      return undefined;
    }
    const { sessionId, session } = this.openGoalSession(goal);
    const handle = session.handle!;
    await session.ready;
    if (action === "pause") {
      await handle.extRequest("_gg/goal/pause", { sessionId: handle.sessionId });
      if (session.working) await this.cancel(sessionId);
    } else if (action === "update") {
      await handle.extRequest("_gg/goal/update", {
        sessionId: handle.sessionId,
        ...(input.context !== undefined ? { context: input.context } : {}),
        ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
      });
    } else {
      await handle.extRequest("_gg/goal/critter_model", {
        sessionId: handle.sessionId,
        model: input.model ?? null,
      });
    }
    return (await this.listGoals([backend.goalsId])).find((g) => g.id === goalId);
  }
}

/** A caught value as an Error; a JSON-RPC rejection keeps its `data.details` via humanError. */
function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(humanError(error));
}
