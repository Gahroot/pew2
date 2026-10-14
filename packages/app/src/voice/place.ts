/**
 * Where a voice task runs, worded for whoever is told.
 *
 * ezcoder works in worktrees: a second checkout of a repository on its own
 * branch, which the daemon files as `black-mountain-fund (fix/login)`. Progress
 * on that branch is progress on black-mountain-fund, so every report on the
 * phone — a card, a banner, the note the voice model is handed — names the
 * repository first and the branch as a detail of it.
 *
 * Mirrors the daemon's `voice/place.ts` (the push titles it sends must read
 * like the ones this app raises). Pure, so `bun test` can load it.
 */
import type { VoiceEvent, VoiceTask } from "./types";

type Placed = Pick<VoiceTask, "projectName" | "repo"> | Pick<VoiceEvent, "projectName" | "repo">;

/** The project a person would name: the repository for a branch. */
export function projectOf(placed: Placed): string {
  return placed.repo?.name ?? placed.projectName;
}

/** "black-mountain-fund · fix/login" for a title; the project name otherwise. */
export function placeTitle(placed: Placed): string {
  const branch = placed.repo?.branch;
  return branch ? `${projectOf(placed)} · ${branch}` : projectOf(placed);
}

/** "black-mountain-fund, on the fix/login branch": what the model says aloud. */
export function placeSpoken(placed: Placed): string {
  const branch = placed.repo?.branch;
  return branch ? `${projectOf(placed)}, on the ${branch} branch` : projectOf(placed);
}
