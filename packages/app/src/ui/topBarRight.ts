/**
 * Which controls sit right of the title in the main screen's top bar, in
 * order. Pure (no React Native), so `bun test` covers it; `ScreenTopBar.tsx`
 * only draws what this returns.
 *
 * Talk is on every screen that offers it, home included: calling Pew is one
 * tap from anywhere. Tasks shares home's side with it.
 */
export type TopBarControl = "talk" | "compose" | "home" | "tasks";

export interface TopBarPlace {
  /** A goal's thread: its own two controls take the side instead. */
  inGoal: boolean;
  inThread: boolean;
  /** Voice can be reached on this daemon. */
  talk: boolean;
  /** A not-yet-started conversation, with a way back to home. */
  backHome: boolean;
  /** The Tasks screen is offered here (home). */
  tasks: boolean;
}

export function topBarRight(place: TopBarPlace): TopBarControl[] {
  if (place.inGoal) return [];
  const controls: TopBarControl[] = [];
  if (place.talk) controls.push("talk");
  if (place.inThread) controls.push("compose");
  else if (place.backHome) controls.push("home");
  else if (place.tasks) controls.push("tasks");
  return controls;
}
