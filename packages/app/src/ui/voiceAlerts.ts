/**
 * Feeds live voice events through the batching policy and raises the banners
 * and cues it decides on. Rules: `../voice/voiceNotifications.ts`,
 * `../voice/quietHours.ts`, `../voice/audioPolicy.ts` (`cueFor`). This file
 * only owns the timer and the state. UNTESTED ON DEVICE.
 */
import { AppState } from "react-native";
import { cueFor } from "../voice/audioPolicy";
import { allowedDuringQuiet, DEFAULT_QUIET_HOURS, inQuietHours, tierOf, type QuietHours } from "../voice/quietHours";
import type { VoiceEvent } from "../voice/types";
import { emptyBatch, flush, flushDueAt, offerEvent, type BatchState, type Presence } from "../voice/voiceNotifications";
import { loadQuietHours } from "../preferences";
import { haptics } from "./haptics";
import { getVoicePresence } from "./notifier";
import { notifyVoice } from "./voiceNotifier";

let batch: BatchState = emptyBatch;
let timer: ReturnType<typeof setTimeout> | undefined;
let quietHours: QuietHours = DEFAULT_QUIET_HOURS;
let loaded = false;

export function setQuietHours(next: QuietHours): void {
  quietHours = next;
}

function presence(now: number): Presence {
  const base = getVoicePresence();
  const at = new Date(now);
  return {
    ...base,
    foreground: AppState.currentState === "active",
    // The daemon pushes for a backgrounded phone; the local route covers the rest.
    pushExpected: true,
    quiet: inQuietHours(quietHours, at),
    quietAllowsUrgent: !quietHours.strict,
    now,
  };
}

function arm(): void {
  clearTimeout(timer);
  const due = flushDueAt(batch);
  if (due === undefined) return;
  timer = setTimeout(() => {
    const now = Date.now();
    const out = flush(batch, presence(now));
    batch = out.state;
    if (out.show) void notifyVoice(out.show);
  }, Math.max(0, due - Date.now()));
}

export function offerLiveEvent(event: VoiceEvent): void {
  if (!loaded) {
    loaded = true;
    void loadQuietHours().then(setQuietHours);
  }
  const now = Date.now();
  const p = presence(now);
  // Foreground, no live audio: a haptic instead of a banner or speech.
  const tier = tierOf(event.class);
  if (!p.voiceActive && p.foreground && !p.voiceSheetOpen && allowedDuringQuiet(quietHours, event.class, new Date(now))) {
    const cue = cueFor(tier, { audioLive: false, foreground: true, quiet: p.quiet === true });
    if (cue === "haptic") (tier === "interrupt" ? haptics.attention : haptics.finished)();
  }
  const out = offerEvent(batch, event, p);
  batch = out.state;
  if (out.show) void notifyVoice(out.show);
  arm();
}
