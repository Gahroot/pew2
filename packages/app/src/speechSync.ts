/**
 * Captions in time with Pew's voice. Pure (no Expo), so `bun test` runs it.
 *
 * OpenAI sends Pew's transcript well ahead of its audio and with no word
 * timings, so the caption is driven by the audio itself:
 *
 * - A *speaking clock* advances only while Pew's voice is actually sounding,
 *   measured from the received audio's energy (WebRTC `inbound-rtp`
 *   `totalAudioEnergy` / `totalSamplesDuration`). Pauses between sentences
 *   and at commas stop it, so the text waits with the voice.
 * - Words are placed on that clock by their syllables, not their letters
 *   ("I" and "through" take very different time to say but "strengths" and
 *   "banana" don't differ the way their lengths do).
 * - The pace (ms of voice per syllable) is learned from each finished line.
 *
 * A word appears whole when Pew starts saying it: no letter-by-letter typing
 * to drift against the voice.
 */

/** Below this RMS between two samples, Pew is silent (a pause, not a word). */
export const VOICE_RMS = 0.012;
/** A typical pace of voiced speech before anything is learned. */
export const MS_PER_SYLLABLE = 175;
/** How far past the last sample the clock glides: about one sample period, so an overshoot is small. */
export const GLIDE_MS = 70;

export interface SpeechClock {
  /** Milliseconds Pew's voice has been sounding, over the whole call. */
  voicedMs: number;
  energy?: number;
  duration?: number;
  /** Wall-clock ms of the last sample, and whether the voice was sounding then. */
  at?: number;
  voicing?: boolean;
}

/**
 * The clock right now, between samples: while the voice was sounding at the
 * last sample it keeps running on wall time (capped, in case the voice has
 * stopped since), so a highlight driven by it glides instead of stepping
 * every sample.
 */
export function voicedNow(clock: SpeechClock, now: number): number {
  if (!clock.voicing || clock.at === undefined) return clock.voicedMs;
  return clock.voicedMs + Math.max(0, Math.min(now - clock.at, GLIDE_MS));
}

export const NEW_CLOCK: SpeechClock = { voicedMs: 0 };

/** Fold one stats sample (cumulative energy and seconds of received audio) into the clock. */
export function tickClock(
  clock: SpeechClock,
  energy: number | undefined,
  duration: number | undefined,
  now: number = Date.now(),
): SpeechClock {
  if (energy === undefined || duration === undefined) return clock;
  if (clock.energy === undefined || clock.duration === undefined || duration < clock.duration) {
    return { ...clock, energy, duration, at: now, voicing: false };
  }
  const dD = duration - clock.duration;
  const dE = Math.max(0, energy - clock.energy);
  const rms = dD > 0 ? Math.sqrt(dE / dD) : 0;
  const voicing = rms >= VOICE_RMS;
  // The truth only: a highlight that glided past it holds still (the screen
  // never moves the sweep backwards) until the voice catches up.
  const voiced = voicing ? dD * 1000 : 0;
  return { voicedMs: clock.voicedMs + voiced, energy, duration, at: now, voicing };
}

/** Syllables in a word, roughly: vowel groups, a silent final e, digits said one by one. */
export function syllables(word: string): number {
  const digits = word.replace(/[^0-9]/g, "").length;
  const letters = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!letters) return Math.max(digits, word.trim() ? 1 : 0);
  let groups = letters.match(/[aeiouy]+/g)?.length ?? 0;
  if (letters.length > 2 && letters.endsWith("e") && !/[aeiouy]le$/.test(letters) && !letters.endsWith("le")) groups -= 1;
  return Math.max(1, groups) + digits;
}

export interface PlannedWord {
  /** Index of the word's first character. */
  start: number;
  /** Index just past it, punctuation included. */
  end: number;
  /** Syllables said before it. */
  at: number;
  syllables: number;
}

/** Each word of a line with where it falls on the speaking clock, in syllables. */
export function planWords(text: string): PlannedWord[] {
  const out: PlannedWord[] = [];
  let at = 0;
  for (const match of text.matchAll(/\S+/g)) {
    const n = syllables(match[0]);
    out.push({ start: match.index, end: match.index + match[0].length, at, syllables: n });
    at += n;
  }
  return out;
}

export function totalSyllables(text: string): number {
  return planWords(text).reduce((sum, word) => sum + word.syllables, 0);
}

/** How much of `text` to show `voicedMs` into its audio: through the last word begun. */
export function revealed(text: string, voicedMs: number, msPerSyllable: number): number {
  if (voicedMs <= 0) return 0;
  const spoken = voicedMs / msPerSyllable;
  let end = 0;
  for (const word of planWords(text)) {
    if (word.at > spoken) break;
    end = word.end;
  }
  return end;
}

/** Learn the pace from a finished line: half new, half old, within a human range. */
export function learnPace(previous: number, syllableCount: number, voicedMs: number): number {
  if (syllableCount < 4 || voicedMs < 500) return previous;
  const observed = Math.min(300, Math.max(110, voicedMs / syllableCount));
  return previous * 0.5 + observed * 0.5;
}

/**
 * Where the voice is in `text`, `voicedMs` into it, as a fractional character
 * index: inside a word it moves through the word's letters in step with its
 * syllables, so a highlight sweeping to it moves continuously.
 */
export function sayPosition(text: string, voicedMs: number, msPerSyllable: number): number {
  if (voicedMs <= 0) return 0;
  const spoken = voicedMs / msPerSyllable;
  const words = planWords(text);
  for (const word of words) {
    if (spoken < word.at) return word.start;
    if (spoken < word.at + word.syllables) {
      const into = (spoken - word.at) / word.syllables;
      return word.start + into * (word.end - word.start);
    }
  }
  return text.length;
}

/**
 * The karaoke highlight: each character's brightness (0 dim, 1 lit) for a
 * sweep at `position`, with a soft edge `edge` characters wide. Runs of equal
 * (quantised) brightness are merged so the text is a handful of spans.
 */
export function highlightRuns(text: string, position: number, edge = 5, steps = 8): { text: string; level: number }[] {
  const runs: { text: string; level: number }[] = [];
  for (let i = 0; i < text.length; i++) {
    const raw = Math.max(0, Math.min(1, (position - i) / edge + 0.5));
    const level = Math.round(raw * steps) / steps;
    const last = runs[runs.length - 1];
    if (last && last.level === level) last.text += text[i];
    else runs.push({ text: text[i]!, level });
  }
  return runs;
}
