/**
 * Which projects a client may name: the agent's own history, directories just
 * offered to a browsing client, and the durable `known-projects.json` record.
 */
import type { AgentSession } from "../acp/connect.js";
import { readProbeCache } from "../probe-cache.js";
import { readKnownProjects, rememberKnownProject } from "../known-projects.js";
import { hydrateMessageCounts } from "../acp/messageCounts.js";
import { sessionsInProject, type AgentProject } from "../projects.js";
import { DaemonProbes } from "./probing.js";
import { PROJECT_SESSION_LIMIT, goalsBackend } from "./types.js";

export abstract class DaemonProjects extends DaemonProbes {
  /**
   * The project a new session should open in, when the client named none.
   *
   * The agent's own most recent workspace, which is very likely the one the
   * user was last at their desk in. Without this a phone-started session lands
   * in the home directory: no project files, no project commands, and an agent
   * writing its state somewhere the user never chose.
   */
  async lastWorkspace(providerId: string): Promise<string | undefined> {
    // The probe is already resolved by the time a session starts, so this is a
    // map lookup in practice rather than a wait on the agent.
    const probed = await this.probes.get(providerId);
    const sessions = probed?.sessions ?? (await readProbeCache(providerId, this.env))?.sessions ?? [];
    // The raw probe of GG Coder includes its goal conversations (GG Goals runs
    // on the same `ggcoder acp`), and a goal is often what it ran last: that
    // put a goal folder in GG Coder's composer as "the project". Goal folders
    // belong to GG Goals alone.
    const backend = goalsBackend(providerId);
    const own = backend?.agentId === providerId ? sessions.filter((s) => !this.isGoalFolder(s.cwd, backend.goalsId)) : sessions;
    return own[0]?.cwd;
  }

  /**
   * Is this one of the projects this daemon announced for that agent?
   *
   * The gate on accepting a path from a client at all: it returns only strings
   * this process already published, so a caller cannot use it to ask whether
   * some other directory on the machine exists.
   *
   * Accepting one also records it (`known-projects.json`), because a client
   * holds on to a chosen project far longer than this process lives — see that
   * module for what the in-memory-only version broke. That record is not keyed
   * by agent, matching `offeredWorkspaces`: a browsed directory was never
   * per-agent either, and the containment this enforces is about which strings
   * this machine published to this pairing, not about which agent asks.
   */
  async knownProject(providerId: string, cwd: string): Promise<string | undefined> {
    const known = await this.projectsWithHistory(providerId);
    if (known.some((session) => session.cwd === cwd)) return this.rememberProject(cwd);
    // The main checkout of a worktree this daemon announced. The app files a
    // repository's branches under it and starts new chats there, and the path
    // was published as that worktree's `root` — even when no agent ever ran in
    // the checkout itself, which is exactly the ezcoder case.
    if ((await this.projectList(providerId)).some((project) => project.worktree?.root === cwd)) {
      return this.rememberProject(cwd);
    }
    // A directory this daemon just offered in a `workspaces` answer counts for
    // the same reason: it published the string, so echoing it back reveals
    // nothing new. Without this a project reached by browsing is unknown until
    // its first session exists, and the composer would name the agent's
    // *previous* project while pointing at this one — which is worse than no
    // label, because it is confidently wrong.
    if (this.offeredWorkspaces.has(cwd)) return this.rememberProject(cwd);
    // Chosen in an earlier run of this daemon. The path was published then, by
    // one of the two checks above; a restart is not consent being withdrawn.
    return (await this.chosenProjects()).has(cwd) ? cwd : undefined;
  }

  /**
   * The agent's own sessions, filled from the probe cache when no probe has
   * landed yet.
   *
   * The app asks about a project the moment it reconnects — before the probe it
   * asked for in the same breath has resolved — so reading the map alone made
   * recognising a perfectly genuine project a race against a spawn. This reads
   * the same file the probe would serve from and never starts an agent.
   */
  /** The announced projects, from memory or else the probe cache, never a spawn. */
  protected async projectList(providerId: string): Promise<AgentProject[]> {
    const known = this.announcedProjects.get(providerId);
    if (known) return known;
    const cached = (await readProbeCache(providerId, this.env))?.projects;
    if (!cached?.length) return [];
    this.announcedProjects.set(providerId, cached);
    return cached;
  }

  protected async projectsWithHistory(providerId: string): Promise<AgentSession[]> {
    const known = this.projectHistory.get(providerId);
    if (known) return known;
    const cached = (await readProbeCache(providerId, this.env))?.allSessions;
    if (!cached?.length) return [];
    this.projectHistory.set(providerId, cached);
    return cached;
  }

  /**
   * Where the agent itself recorded one of its conversations.
   *
   * A conversation's project is a property of the conversation, and the agent is
   * the one that knows it — so reopening does not have to take a client's word
   * for it, or guess. Guessing is what it used to do: an unrecognised `cwd` on
   * resume fell through to the provider's *last* workspace, which reopens a
   * conversation about one repo with the agent rooted in another. Every file
   * tool in that turn then reads and writes the wrong project, and the
   * `session.started` that follows tells every client to file the conversation
   * there too.
   *
   * Answering from the same history the projects list is built from, so this
   * costs a map lookup and never starts an agent.
   */
  async agentSessionCwd(providerId: string, agentSessionId: string): Promise<string | undefined> {
    const known = await this.projectsWithHistory(providerId);
    const recorded = known.find((session) => session.sessionId === agentSessionId)?.cwd;
    // Recorded like an accepted project, because announcing it is publishing it:
    // the client files the conversation under this path and sends it back later.
    return recorded ? this.rememberProject(recorded) : undefined;
  }

  /**
   * Projects a client has opened before, loaded once per daemon.
   *
   * Held as a promise so the concurrent asks a reconnect produces share one
   * read, and so an unreadable file is a miss rather than a retry per message.
   */
  protected chosenProjects(): Promise<Set<string>> {
    this.chosen ??= readKnownProjects(this.env).then((paths) => new Set(paths));
    return this.chosen;
  }

  /**
   * File an accepted project, in memory and on disk, before answering with it.
   *
   * Awaited rather than left running: the answer *is* the publication, so a
   * daemon that died between saying yes and writing it down would refuse the
   * same path a second later. It costs one small write, once per project — and
   * the caller is on its way to spawning an agent or running `git status`.
   *
   * Writes are chained rather than concurrent so two paths accepted in the same
   * moment cannot read-modify-write over each other.
   */
  protected async rememberProject(cwd: string): Promise<string> {
    const chosen = await this.chosenProjects();
    if (chosen.has(cwd)) return cwd;
    chosen.add(cwd);
    this.chosenWrites = this.chosenWrites
      .then(() => rememberKnownProject(cwd, this.env))
      // A daemon that cannot write its own state directory still has to run;
      // the cost is that this project is forgotten at the next restart.
      .then(
        () => {},
        () => {},
      );
    await this.chosenWrites;
    return cwd;
  }

  /**
   * Remember the directories just offered to a browsing client.
   *
   * Bounded, and not persisted: this is a short-lived echo check, not a record
   * of anything. Only the most recent listings need to be recognised, since a
   * path is chosen within seconds of being shown.
   */
  rememberOfferedWorkspaces(paths: string[]): void {
    for (const path of paths) {
      // Re-inserting moves it to the end of the Map's order, so a directory the
      // user keeps seeing is not the one evicted.
      this.offeredWorkspaces.delete(path);
      this.offeredWorkspaces.add(path);
    }
    while (this.offeredWorkspaces.size > 2_000) {
      const oldest = this.offeredWorkspaces.values().next().value;
      if (oldest === undefined) break;
      this.offeredWorkspaces.delete(oldest);
    }
  }

  /**
   * The agent's own conversations in one project, newest first.
   *
   * Counts are hydrated here rather than up front: doing every project at probe
   * time is hundreds of file reads for the one the user will actually pick.
   * Agents without a local index answer without counts, which the drawer omits.
   */
  async sessionsForProject(providerId: string, cwd: string): Promise<AgentSession[]> {
    const known = this.projectHistory.get(providerId);
    // No probe has landed yet. The app asked for capabilities first, so the
    // answer is on its way; an empty list here is corrected by that reply
    // rather than by a second spawn started from a menu tap.
    if (!known) return [];
    // Copied before hydrating: `hydrateMessageCounts` writes counts into the
    // objects it is given, and these are the cached list itself. Mutating them
    // would leave counts on rows the next probe overwrites wholesale.
    // A repository's conversations include its worktrees': the app lists those
    // as branches of this project, so asking for the project asks for them too.
    const branches = (await this.projectList(providerId)).filter((p) => p.worktree?.root === cwd).map((p) => p.path);
    const picked = sessionsInProject(known, new Set([cwd, ...branches]), PROJECT_SESSION_LIMIT).map((s) => ({ ...s }));
    await hydrateMessageCounts(providerId, picked);
    return picked;
  }
}
