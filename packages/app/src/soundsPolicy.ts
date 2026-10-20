/**
 * Which sound to play, and when not to. Pure and Expo-free (tested under bun);
 * the playing is `ui/sounds.ts`, the sounds themselves `scripts/make-sounds.py`.
 */

/** Every sound the app has; one `assets/sounds/<name>.wav` each. */
export const SOUND_NAMES = [
  "charge",
  "drain",
  "burst",
  "reveal",
  // Home Pew's spin toy: its own family, nothing like the launch.
  "whirr-0",
  "whirr-1",
  "whirr-2",
  "whirr-3",
  "spin-pop",
  "spin-sigh",
  "level-up-0",
  "level-up-1",
  "level-up-2",
  "level-up-3",
  "level-up-4",
  "level-down-0",
  "level-down-1",
  "level-down-2",
  "level-down-3",
  "level-down-4",
  "level-max",
  "send",
  "done",
  "attention",
  "call-dial",
  "call-connect",
  "call-end",
  "tick",
  "select",
  "detent-0",
  "detent-1",
  "detent-2",
  "detent-3",
  "detent-4",
  "toggle-on",
  "toggle-off",
  "swish-up",
  "swish-down",
  "poke-0",
  "poke-1",
  "poke-2",
  "poke-3",
  "confirm",
  "warn",
  "error",
  "choose",
  "agent-claude-code",
  "agent-codex",
  "agent-gemini-cli",
  "agent-ggcoder",
  "agent-opencode",
  "agent-cursor-agent",
  "agent-cline",
  "agent-goose",
  "agent-hermes",
  "agent-openclaw",
  "agent-qwen-code",
  "agent-echo",
  "agent-gg-goals",
  "agent-ezcoder",
  "banner",
  "key-0",
  "key-1",
  "key-2",
  "key-3",
  "pairing",
] as const;

export type SoundName = (typeof SOUND_NAMES)[number];

/** The level sounds come in this many pitches. */
export const LEVEL_PITCHES = 5;

/** Which of the pitches stop `index` of `count` uses: low to high across the dial. */
export function levelPitch(index: number, count: number): number {
  if (count <= 1) return Math.floor(LEVEL_PITCHES / 2);
  const f = Math.max(0, Math.min(1, index / (count - 1)));
  return Math.round(f * (LEVEL_PITCHES - 1));
}

/**
 * The sound for moving the thinking level from `from` to `to`. Up sings the
 * stop it reached (and the top gets its own flourish); down sighs from the
 * stop it left.
 */
export function levelSound(from: number, to: number, count: number): SoundName | undefined {
  if (to === from || count < 2) return undefined;
  if (to > from) return to >= count - 1 ? "level-max" : (`level-up-${levelPitch(to, count)}` as SoundName);
  return `level-down-${levelPitch(from, count)}` as SoundName;
}

/**
 * The same sound twice inside this window is one sound: a double-fired effect
 * (a reply ending and an error landing together) must not stutter.
 */
export const REPEAT_GAP_MS = 70;

export function shouldPlay(now: number, lastPlayedAt: number | undefined): boolean {
  if (lastPlayedAt === undefined || now < lastPlayedAt) return true;
  return now - lastPlayedAt >= REPEAT_GAP_MS;
}

/** Where in the charge sound to start for a hold resumed at `charge` (0..1) of `holdMs`. */
export function chargeOffsetSeconds(charge: number, holdMs: number): number {
  return (Math.max(0, Math.min(1, charge)) * holdMs) / 1000;
}

// ── Touch: one sound per kind of haptic ───────────────────────────────────

/** The haptic vocabulary (`ui/haptics.ts`), named here so the pairing is testable. */
export type HapticKind =
  | "tap"
  | "select"
  | "sent"
  | "finished"
  | "attention"
  | "warned"
  | "poke"
  | "detent"
  | "failed"
  | "toggleOn"
  | "toggleOff"
  | "chosen";

/**
 * Felt and heard together: the sound each haptic plays unless its call site
 * names another (or `null`, silent). Fired in the same call, so they can't
 * drift apart.
 */
export function hapticSound(kind: HapticKind, pokes = 0, detentAt?: number): SoundName {
  switch (kind) {
    case "tap":
      return "tick";
    case "select":
      return "select";
    case "sent":
      return "send";
    case "finished":
      return "confirm";
    case "attention":
      return "attention";
    case "warned":
      return "warn";
    case "poke":
      return pokeSound(pokes);
    case "detent":
      return detentSound(detentAt);
    case "failed":
      return "error";
    case "toggleOn":
      return "toggle-on";
    case "toggleOff":
      return "toggle-off";
    case "chosen":
      // Felt firmly, heard as a tick: the agent's own voice is the sound,
      // and it plays where the agent is landed on (or is passed in).
      return "tick";
  }
}

export const POKE_VOICES = 4;

/** Pew's voice for the `n`th poke: walks the four, never the same twice running. */
export function pokeSound(n: number): SoundName {
  const order = [0, 2, 1, 3];
  return `poke-${order[((n % POKE_VOICES) + POKE_VOICES) % POKE_VOICES]}` as SoundName;
}

export const DETENT_PITCHES = 5;

/** A detent at position `at` (a page, a dial stop): the pitch climbs with it. No position: the middle. */
export function detentSound(at?: number): SoundName {
  const i = at === undefined ? 2 : ((Math.round(at) % DETENT_PITCHES) + DETENT_PITCHES) % DETENT_PITCHES;
  return `detent-${i}` as SoundName;
}

/**
 * Soft sounds sit under ordinary touches. They give way to a cue: a soft
 * sound within `SOFT_YIELD_MS` after a cue is skipped (an approval sheet
 * rising under its "needs you" chime gets the chime alone, not chime + air).
 */
export const SOFT_SOUNDS: ReadonlySet<SoundName> = new Set<SoundName>([
  "key-0",
  "key-1",
  "key-2",
  "key-3",
  "tick",
  "select",
  "detent-0",
  "detent-1",
  "detent-2",
  "detent-3",
  "detent-4",
  "toggle-on",
  "toggle-off",
  "swish-up",
  "swish-down",
]);

export const SOFT_YIELD_MS = 160;

export function softYields(name: SoundName, now: number, lastCueAt: number | undefined): boolean {
  if (!SOFT_SOUNDS.has(name) || lastCueAt === undefined || now < lastCueAt) return false;
  return now - lastCueAt < SOFT_YIELD_MS;
}

/**
 * How loud each sound may be: its loudest 50 ms, in dB. Four tiers, set by
 * the drawer's slide (Ken's reference): touches live at the slide's level,
 * moments a little above, things that want you above that, and only the
 * launch is a show. `make-sounds.py` levels to these; a test reads the files.
 */
export const LOUDNESS_TIERS = { touch: -38, cue: -30, alert: -26, launch: 0 } as const;

export function loudnessTier(name: SoundName): keyof typeof LOUDNESS_TIERS {
  if (name === "charge" || name === "burst" || name === "drain") return "launch";
  if (name === "attention" || name === "call-connect" || name === "pairing" || name === "reveal" || name === "spin-pop") return "alert";
  if (SOFT_SOUNDS.has(name) || name.startsWith("level-up") || name.startsWith("level-down")) return "touch";
  return "cue";
}

/** Played at launch, so the first touch of each kind isn't late. */
export const TOUCH_SOUNDS: readonly SoundName[] = SOUND_NAMES.filter(
  (name) => SOFT_SOUNDS.has(name) || name.startsWith("poke-") || ["confirm", "warn", "error", "choose", "send", "done", "attention"].includes(name),
);

// ── Agents: one signature each ─────────────────────────────────────────────

/** Agents with a signature of their own (`make-sounds.py` `AGENT_SOUNDS`). */
export const AGENT_SOUND_IDS = [
  "claude-code",
  "codex",
  "gemini-cli",
  "ggcoder",
  "opencode",
  "cursor-agent",
  "cline",
  "goose",
  "hermes",
  "openclaw",
  "qwen-code",
  "echo",
  "gg-goals",
  "ezcoder",
] as const;

/**
 * An agent's own sound, heard when it's landed on in the switcher or picked
 * from the rail. A provider added later (any manifest) falls back to Pew's
 * `choose`, so it is never silent and never borrows another agent's voice.
 */
export function agentSound(providerId: string | undefined): SoundName {
  return providerId && (AGENT_SOUND_IDS as readonly string[]).includes(providerId)
    ? (`agent-${providerId}` as SoundName)
    : "choose";
}

/** Onboarding's sounds: the scenes' own and the touches it uses, loaded before the first page. */
export const ONBOARDING_SOUNDS: readonly SoundName[] = [
  "banner",
  "key-0",
  "key-1",
  "key-2",
  "key-3",
  "pairing",
  "tick",
  "select",
  "poke-0",
  "poke-1",
  "poke-2",
  "poke-3",
  "confirm",
  "toggle-on",
  "swish-up",
  "charge",
  "drain",
  "burst",
  "reveal",
  "whirr-0",
  "whirr-1",
  "whirr-2",
  "whirr-3",
  "spin-pop",
  "spin-sigh",
];
