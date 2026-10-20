/**
 * First-run onboarding: which page shows, in what order, and where a relaunch
 * resumes. Expo-free so `bun test` can run it; `ui/Onboarding.tsx` draws it and
 * `preferences.ts` stores the step.
 *
 * One page per step. Progress is stored as the step on screen, or "done".
 * A device paired before onboarding existed has no stored step and is treated
 * as done: it never sees the welcome. Unpairing after that lands on the Pair
 * step alone, and pairing again goes straight to the app.
 */

export const STEPS = ["welcome", "alerts", "install", "pair", "voice", "done"] as const;
export type Step = (typeof STEPS)[number];

/** What is stored: a step, or "done" once the user reached the app. */
export type Progress = Step | "finished";

/** Steps the user can pass without doing them. */
export const OPTIONAL: ReadonlySet<Step> = new Set<Step>(["alerts", "voice"]);

export function parseProgress(raw: string | null | undefined): Progress | undefined {
  if (raw === "finished") return "finished";
  return STEPS.find((step) => step === raw);
}

export interface Gate {
  /** The page to show, or undefined for the app itself. */
  step: Step | undefined;
  /** Only the Pair page, after a forget: pairing leads straight to the app. */
  repair: boolean;
}

/**
 * Where launch lands.
 *
 * - Paired with nothing stored: an existing user, so the app (and the caller
 *   records "finished" so a later forget goes to Pair, not Welcome).
 * - Finished: the app when paired; when not (the computer was forgotten),
 *   onboarding from Welcome, the same first state a new install sees.
 * - A stored step: resumed, except that the steps after Pair need a pairing
 *   and the steps up to it are pointless with one.
 */
export function gate(progress: Progress | undefined, paired: boolean): Gate {
  if (progress === undefined) return paired ? { step: undefined, repair: false } : { step: "welcome", repair: false };
  // Forgotten (or never paired since): from the top, as on a first launch.
  if (progress === "finished") return paired ? { step: undefined, repair: false } : { step: "welcome", repair: false };
  const after = STEPS.indexOf(progress) > STEPS.indexOf("pair");
  if (paired) return after ? { step: progress, repair: false } : { step: "voice", repair: false };
  return after ? { step: "pair", repair: false } : { step: progress, repair: false };
}

/** The page after this one, or undefined for the app. */
export function nextStep(step: Step, repair = false): Step | undefined {
  if (repair && step === "pair") return undefined;
  return STEPS[STEPS.indexOf(step) + 1];
}

/**
 * The page Back returns to, or undefined where there is none: Welcome, the
 * repair Pair page, and anything after Pair (the pairing is made; going back
 * to scan again would only offer to replace it).
 */
export function previousStep(step: Step, repair = false): Step | undefined {
  if (repair) return undefined;
  const at = STEPS.indexOf(step);
  if (at <= 0 || at > STEPS.indexOf("pair")) return undefined;
  return STEPS[at - 1];
}

/** 0-based position for the progress dots. */
export function stepIndex(step: Step): number {
  return STEPS.indexOf(step);
}

/** A dev override (`EXPO_PUBLIC_DEV_ONBOARDING`), if it names a step. */
export function devStep(raw: string | undefined): Step | undefined {
  return STEPS.find((step) => step === raw);
}

export const INSTALL_COMMAND = "curl -fsSL https://raw.githubusercontent.com/KenKaiii/pew2/main/install.sh | sh";
/** How the install command is shown (one line); copying gives the full one. */
export const INSTALL_SHOWN = "curl -fsSL …/pew2/install.sh | sh";
export const SETUP_COMMAND = "pew2 setup";
/** Shows the QR code the phone scans (`pew2 setup` ends by pointing here). */
export const PAIR_COMMAND = "pew2 pair";

