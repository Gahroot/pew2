/**
 * Where a task runs, worded for whoever is told.
 *
 * ezcoder does its work in worktrees: a second checkout of a repository on its
 * own branch, filed in the voice registry as `black-mountain-fund (fix/login)`.
 * That name is right for picking one checkout out of a list, and wrong for
 * telling someone how their work is going: progress on a branch *is* progress
 * on black-mountain-fund. So every report — the model's context, its tool
 * results, a push title — names the repository first and the branch as a
 * detail of it, never the checkout as a project in its own right.
 *
 * Pure. One place, so the three readers cannot drift into three wordings.
 */
import type { VoiceRepo } from "./types.js";

interface Placed {
  projectName: string;
  repo?: VoiceRepo;
}

/** The project a person would name: the repository for a branch, else the project itself. */
export function projectOf(placed: Placed): string {
  return placed.repo?.name ?? placed.projectName;
}

/** "black-mountain-fund · fix/login" — for a title, where space is short. */
export function placeTitle(placed: Placed): string {
  const branch = placed.repo?.branch;
  return branch ? `${projectOf(placed)} · ${branch}` : projectOf(placed);
}

/** "black-mountain-fund, on the fix/login branch" — for the model, which says it aloud. */
export function placeSpoken(placed: Placed): string {
  const branch = placed.repo?.branch;
  return branch ? `${projectOf(placed)}, on the ${branch} branch` : projectOf(placed);
}

/** A tool result's `project`, with the branch beside it rather than inside it. */
export function placeFields(placed: Placed): { project: string; branch?: string } {
  const branch = placed.repo?.branch;
  return { project: projectOf(placed), ...(branch ? { branch } : null) };
}
