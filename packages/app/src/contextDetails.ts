import { usageAccessibilityLabel, usageLabel, usageLevel, usagePercent, type ContextUsage } from "./contextUsage";
import { changesAccessibilityLabel, changesLabel } from "./workspaceLabel";
import type { Workspace } from "./useDaemon";

/** The chip's name for where the agent is working: repo · branch for a worktree. */
export function workspaceTitle(workspace?: Pick<Workspace, "folder" | "worktree">): string | undefined {
  if (!workspace?.folder) return undefined;
  const worktree = workspace.worktree;
  return worktree ? `${worktree.repo} · ${worktree.branch ?? workspace.folder}` : workspace.folder;
}

/** Shared resting-row/detail policy. Unknown readings are never zero or clean. */
export function contextDetails(workspace?: Workspace, usage?: ContextUsage) {
  const knownUsage = usage && Number.isFinite(usage.used) && usage.used >= 0 && Number.isFinite(usage.size) && usage.size > 0 ? usage : undefined;
  const knownChanges = workspace?.repo === true && typeof workspace.uncommitted === "number" && Number.isFinite(workspace.uncommitted) && workspace.uncommitted >= 0 ? workspace.uncommitted : undefined;
  const level = knownUsage ? usageLevel(usagePercent(knownUsage)) : undefined;
  return {
    project: workspaceTitle(workspace) || "Unknown project",
    /** Absent rather than "unknown": a non-repo or an older daemon has nothing to say. */
    branch: workspace?.branch,
    /** "Worktree of billing", so a separate checkout is never mistaken for the repo itself. */
    worktree: workspace?.worktree ? `Worktree of ${workspace.worktree.repo}` : undefined,
    usage: knownUsage ? usageLabel(knownUsage) : "Context usage unavailable",
    usageAccessibility: knownUsage ? usageAccessibilityLabel(knownUsage) : "Context usage unavailable",
    level,
    warning: level === "high" || level === "critical",
    dirty: knownChanges !== undefined && knownChanges > 0,
    changes: knownChanges !== undefined ? changesLabel(knownChanges) : workspace?.repo === false ? "Not a Git repository" : "Change count unavailable",
    changesAccessibility: knownChanges !== undefined ? changesAccessibilityLabel(knownChanges) : workspace?.repo === false ? "Not a Git repository" : "Change count unavailable",
  };
}
