/**
 * Sound effects, named by moment like `haptics.ts`. The rules (which sound,
 * when not to) live in `soundsPolicy.ts`; the sounds are made by
 * `scripts/make-sounds.py`.
 *
 * Polite by construction: the audio session is "ambient", so the ring/silent
 * switch mutes every sound, and it mixes with whatever is already playing
 * (a podcast keeps going under a reply chime). Nothing plays while dictating:
 * the recogniser is listening, and a chime would end up in the transcript.
 *
 * Like haptics, sound is decoration: failures are swallowed and nothing waits
 * on a sound.
 */
import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from "expo-audio";
import { Asset } from "expo-asset";
import { canPlayCues, playCue, prepareCues, stopCue } from "../../modules/pew-audio-route";
import { SOFT_SOUNDS, chargeOffsetSeconds, shouldPlay, softYields, type SoundName } from "../soundsPolicy";

// Metro resolves asset `require`s at bundle time; an `import` of a .wav has no
// type here, so these stay requires.
/* eslint-disable @typescript-eslint/no-require-imports */
const SOURCES: Record<SoundName, number> = {
  charge: require("../../assets/sounds/charge.wav"),
  drain: require("../../assets/sounds/drain.wav"),
  burst: require("../../assets/sounds/burst.wav"),
  reveal: require("../../assets/sounds/reveal.wav"),
  "whirr-0": require("../../assets/sounds/whirr-0.wav"),
  "whirr-1": require("../../assets/sounds/whirr-1.wav"),
  "whirr-2": require("../../assets/sounds/whirr-2.wav"),
  "whirr-3": require("../../assets/sounds/whirr-3.wav"),
  "spin-pop": require("../../assets/sounds/spin-pop.wav"),
  "spin-sigh": require("../../assets/sounds/spin-sigh.wav"),
  "level-up-0": require("../../assets/sounds/level-up-0.wav"),
  "level-up-1": require("../../assets/sounds/level-up-1.wav"),
  "level-up-2": require("../../assets/sounds/level-up-2.wav"),
  "level-up-3": require("../../assets/sounds/level-up-3.wav"),
  "level-up-4": require("../../assets/sounds/level-up-4.wav"),
  "level-down-0": require("../../assets/sounds/level-down-0.wav"),
  "level-down-1": require("../../assets/sounds/level-down-1.wav"),
  "level-down-2": require("../../assets/sounds/level-down-2.wav"),
  "level-down-3": require("../../assets/sounds/level-down-3.wav"),
  "level-down-4": require("../../assets/sounds/level-down-4.wav"),
  "level-max": require("../../assets/sounds/level-max.wav"),
  send: require("../../assets/sounds/send.wav"),
  done: require("../../assets/sounds/done.wav"),
  attention: require("../../assets/sounds/attention.wav"),
  "call-dial": require("../../assets/sounds/call-dial.wav"),
  "call-connect": require("../../assets/sounds/call-connect.wav"),
  "call-end": require("../../assets/sounds/call-end.wav"),
  "tick": require("../../assets/sounds/tick.wav"),
  "select": require("../../assets/sounds/select.wav"),
  "detent-0": require("../../assets/sounds/detent-0.wav"),
  "detent-1": require("../../assets/sounds/detent-1.wav"),
  "detent-2": require("../../assets/sounds/detent-2.wav"),
  "detent-3": require("../../assets/sounds/detent-3.wav"),
  "detent-4": require("../../assets/sounds/detent-4.wav"),
  "toggle-on": require("../../assets/sounds/toggle-on.wav"),
  "toggle-off": require("../../assets/sounds/toggle-off.wav"),
  "swish-up": require("../../assets/sounds/swish-up.wav"),
  "swish-down": require("../../assets/sounds/swish-down.wav"),
  "poke-0": require("../../assets/sounds/poke-0.wav"),
  "poke-1": require("../../assets/sounds/poke-1.wav"),
  "poke-2": require("../../assets/sounds/poke-2.wav"),
  "poke-3": require("../../assets/sounds/poke-3.wav"),
  "confirm": require("../../assets/sounds/confirm.wav"),
  "warn": require("../../assets/sounds/warn.wav"),
  "error": require("../../assets/sounds/error.wav"),
  "choose": require("../../assets/sounds/choose.wav"),
  "agent-claude-code": require("../../assets/sounds/agent-claude-code.wav"),
  "agent-codex": require("../../assets/sounds/agent-codex.wav"),
  "agent-gemini-cli": require("../../assets/sounds/agent-gemini-cli.wav"),
  "agent-ggcoder": require("../../assets/sounds/agent-ggcoder.wav"),
  "agent-opencode": require("../../assets/sounds/agent-opencode.wav"),
  "agent-cursor-agent": require("../../assets/sounds/agent-cursor-agent.wav"),
  "agent-cline": require("../../assets/sounds/agent-cline.wav"),
  "agent-goose": require("../../assets/sounds/agent-goose.wav"),
  "agent-hermes": require("../../assets/sounds/agent-hermes.wav"),
  "agent-openclaw": require("../../assets/sounds/agent-openclaw.wav"),
  "agent-qwen-code": require("../../assets/sounds/agent-qwen-code.wav"),
  "agent-echo": require("../../assets/sounds/agent-echo.wav"),
  "agent-gg-goals": require("../../assets/sounds/agent-gg-goals.wav"),
  "agent-ezcoder": require("../../assets/sounds/agent-ezcoder.wav"),
  "banner": require("../../assets/sounds/banner.wav"),
  "key-0": require("../../assets/sounds/key-0.wav"),
  "key-1": require("../../assets/sounds/key-1.wav"),
  "key-2": require("../../assets/sounds/key-2.wav"),
  "key-3": require("../../assets/sounds/key-3.wav"),
  "pairing": require("../../assets/sounds/pairing.wav"),
};
/* eslint-enable @typescript-eslint/no-require-imports */

const players = new Map<SoundName, AudioPlayer>();
const lastPlayed = new Map<SoundName, number>();
const fades = new Map<SoundName, ReturnType<typeof setInterval>>();
let mode: Promise<void> | undefined;
/** Sounds as local files, for the native player (`canPlayCues`). */
const cueUris = new Map<SoundName, string>();
const resolving = new Set<SoundName>();

/**
 * Resolve sounds to files for the native player. In a release build they are
 * in the app bundle (instant); in development they come from Metro once.
 */
function resolveNative(names: readonly SoundName[]): void {
  const fresh: SoundName[] = names.filter((name) => !cueUris.has(name) && !resolving.has(name));
  for (const name of fresh) {
    resolving.add(name);
    const asset = Asset.fromModule(SOURCES[name]);
    void asset
      .downloadAsync()
      .then(() => {
        const uri = asset.localUri ?? asset.uri;
        if (uri) {
          cueUris.set(name, uri);
          prepareCues([uri]);
        }
      })
      .catch(() => {})
      .finally(() => resolving.delete(name));
  }
}
let listening = false;
/** When a cue (anything not soft) last played: soft sounds give way just after one. */
let lastCueAt: number | undefined;

/** Ambient, mixing, muted by the silent switch. Re-applied after dictation took the session. */
function ensureMode(): void {
  mode ??= setAudioModeAsync({
    playsInSilentMode: false,
    interruptionMode: "mixWithOthers",
    allowsRecording: false,
    shouldPlayInBackground: false,
  }).catch(() => {});
}

function player(name: SoundName): AudioPlayer | undefined {
  let p = players.get(name);
  if (!p) {
    try {
      // Never let a finished (or stopped) sound switch the audio session off:
      // expo-audio deactivates the shared session when a player ends unless
      // told not to, and during a call that session is the call's. A chime
      // ending mid-call cut the microphone dead (the server heard nothing).
      // The session is ambient and mixes, so leaving it active costs nothing.
      p = createAudioPlayer(SOURCES[name], { keepAudioSessionActive: true });
      players.set(name, p);
    } catch {
      return undefined;
    }
  }
  return p;
}

function clearFade(name: SoundName): void {
  const f = fades.get(name);
  if (f) clearInterval(f);
  fades.delete(name);
}

export const sounds = {
  /** Load these now, so the first play is not late (a screen that is about to need them). */
  preload(names: readonly SoundName[]): void {
    ensureMode();
    if (canPlayCues) resolveNative(names);
    else for (const name of names) player(name);
  },

  /** Play from the start, or from `at` seconds in. */
  play(name: SoundName, at = 0): void {
    const log = process.env.EXPO_PUBLIC_DEV_SOUND_LOG === "1" ? (why: string) => console.log(`[sound] ${name} ${why}`) : undefined;
    if (listening) return void log?.("skipped (listening)");
    const now = Date.now();
    if (!shouldPlay(now, lastPlayed.get(name))) return void log?.("skipped (repeat)");
    if (softYields(name, now, lastCueAt)) return void log?.("skipped (yields)");
    lastPlayed.set(name, now);
    if (!SOFT_SOUNDS.has(name)) lastCueAt = now;
    ensureMode();
    // Natively, off the JS thread, whenever this build can: never wait on the
    // audio session (see `playCue`). A sound not resolved yet is skipped once.
    if (canPlayCues) {
      const uri = cueUris.get(name);
      log?.(uri ? "played" : "skipped (not loaded)");
      if (uri) playCue(uri, { at });
      else resolveNative([name]);
      return;
    }
    const p = player(name);
    log?.(p ? "played (expo-audio)" : "skipped (no player)");
    if (!p) return;
    try {
      clearFade(name);
      p.volume = 1;
      void p.seekTo(at).catch(() => {});
      p.play();
    } catch {
      // Decoration only.
    }
  },

  /** The hold's charge, picked up where a released hold left it. */
  charge(charge: number, holdMs: number): void {
    sounds.play("charge", chargeOffsetSeconds(charge, holdMs));
  },

  /** Fade a playing sound out over `ms` (a released hold). */
  stop(name: SoundName, ms = 80): void {
    if (canPlayCues) {
      const uri = cueUris.get(name);
      if (uri) stopCue(uri, ms);
      return;
    }
    const p = players.get(name);
    if (!p) return;
    clearFade(name);
    const steps = Math.max(1, Math.round(ms / 16));
    let k = 0;
    const from = p.volume;
    fades.set(
      name,
      setInterval(() => {
        k++;
        try {
          p.volume = Math.max(0, from * (1 - k / steps));
          if (k >= steps) {
            clearFade(name);
            p.pause();
            p.volume = 1;
          }
        } catch {
          clearFade(name);
        }
      }, 16),
    );
  },

  /**
   * A call's own cue: dialing, connected, ended. Played inside the call's
   * audio session as it stands, never switching it (no `ensureMode`): the
   * session belongs to the call, and changing it while WebRTC's voice unit
   * starts deadlocked Core Audio. Heard even though the app is otherwise
   * quiet during a call (`listening`).
   */
  /**
   * A call cue (dial, connect, end), played inside the call's audio session.
   * Natively off the JS thread where the build allows (`playCue`): these play
   * exactly when the session is switching, and expo-audio's synchronous
   * `play()` waits for the session to activate, which froze the app for
   * seconds when a call opened and closed.
   */
  callCue(name: SoundName): void {
    const uri = cueUris.get(name);
    if (canPlayCues && uri) {
      // Inside the call's session: make sure it is active first.
      playCue(uri, { activate: true });
      return;
    }
    const p = player(name);
    if (!p) return;
    try {
      clearFade(name);
      p.volume = 1;
      void p.seekTo(0).catch(() => {});
      p.play();
    } catch {
      // Decoration only.
    }
  },

  /** Stop a call cue still sounding (the dial tone once the call connects). */
  stopCue(name: SoundName): void {
    const uri = cueUris.get(name);
    if (canPlayCues && uri) stopCue(uri, 140);
    else this.stop(name, 140);
  },

  /** Resolve the call cues to files ahead of a call, so the native player can start at once. */
  prepareCues(names: readonly SoundName[]): void {
    if (canPlayCues) resolveNative(names);
    else this.preload(names);
  },

  /**
   * Dictation owns the audio session while it listens: stay quiet, and take
   * the session back afterwards (the recogniser leaves it set for recording,
   * which plays through the earpiece).
   */
  setListening(on: boolean): void {
    listening = on;
    if (!on) mode = undefined;
  },
};
