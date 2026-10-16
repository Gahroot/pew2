/**
 * Small per-install preferences that must survive the app being closed.
 *
 * SecureStore is the only persistent store this app already depends on, so it
 * carries these too; nothing here is a secret. Expo-bound on purpose — the
 * decision rules live in `lastProvider.ts` and `providerCache.ts`, which stay
 * testable.
 */
import * as SecureStore from "expo-secure-store";
import { decodeCursor, encodeCursor, type PersistedCursor } from "./voice/voiceStore";
import { decodeQuietHours, encodeQuietHours, type QuietHours } from "./voice/quietHours";
import { fromCachedProviders, toCachedProviders } from "./providerCache";
import type { Provider } from "./useDaemon";

const LAST_PROVIDER_KEY = "pew2.lastProviderId";
const VOICE_CURSOR_KEY = "pew2.voiceCursor";
const QUIET_HOURS_KEY = "pew2.voice.quietHours";
const VOICE_CALL_KEY = "pew2.voiceCall";
const NATIVE_CALL_KEY = "pew2.nativeCall";
const PROVIDERS_KEY = "pew2.providers";

/** The agent last targeted on this device, or null if never chosen. */
export async function loadLastProvider(): Promise<string | null> {
  // Development only: `EXPO_PUBLIC_DEV_PROVIDER=<id>` picks the agent on launch.
  // `__DEV__` is React Native's global; read through globalThis because this
  // file is also typechecked outside the app.
  const dev = (globalThis as { __DEV__?: boolean }).__DEV__ ? process.env.EXPO_PUBLIC_DEV_PROVIDER : undefined;
  if (dev) return dev;
  try {
    return await SecureStore.getItemAsync(LAST_PROVIDER_KEY);
  } catch {
    // A locked or unavailable keychain just means "no preference"; the caller
    // falls back to the first available agent rather than failing to launch.
    return null;
  }
}

export async function saveLastProvider(providerId: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(LAST_PROVIDER_KEY, providerId);
  } catch {
    // Losing a preference is not worth surfacing, let alone crashing over.
  }
}

/**
 * The agents this machine reported last time, for a launch with no signal.
 *
 * Empty whenever anything is wrong — no store, no record, junk from an older
 * build — which is exactly the state the app had before this cache existed.
 * See `providerCache.ts` for why it is worth having at all.
 */
export async function loadCachedProviders(): Promise<Provider[]> {
  try {
    return fromCachedProviders(await SecureStore.getItemAsync(PROVIDERS_KEY));
  } catch {
    return [];
  }
}

export async function saveCachedProviders(providers: readonly Provider[]): Promise<void> {
  try {
    const payload = toCachedProviders(providers);
    // An empty list is the daemon still probing, not an answer. Writing it would
    // erase a good list and leave the next offline launch as stuck as before.
    if (!payload) return;
    await SecureStore.setItemAsync(PROVIDERS_KEY, payload);
  } catch {
    // Same trade as above: a cache that fails to write costs one offline launch,
    // and is never worth taking the app down for.
  }
}

/**
 * Forget the remembered agents.
 *
 * Called when a pairing is dropped: the list describes one specific machine, and
 * carrying it to the next one would offer agents that computer may not have.
 */
export async function clearCachedProviders(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(PROVIDERS_KEY);
  } catch {
    // Nothing to do — the next machine to answer overwrites it anyway.
  }
}

/** The last voice event this phone folded in, so a relaunch asks only for what it missed. */
export async function loadVoiceCursor(): Promise<PersistedCursor> {
  try {
    return decodeCursor(await SecureStore.getItemAsync(VOICE_CURSOR_KEY));
  } catch {
    return decodeCursor(null);
  }
}

export async function saveVoiceCursor(cursor: PersistedCursor): Promise<void> {
  try {
    await SecureStore.setItemAsync(VOICE_CURSOR_KEY, encodeCursor(cursor));
  } catch {
    // A lost cursor costs one fuller catch-up, never correctness.
  }
}

/** Forget it with the pairing: event ids belong to one machine's history. */
export async function clearVoiceCursor(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(VOICE_CURSOR_KEY);
  } catch {
    // The next machine's snapshot moves the cursor anyway.
  }
}

/** Do-not-disturb for voice notifications. Absent (older install) means off. */
export async function loadQuietHours(): Promise<QuietHours> {
  try {
    return decodeQuietHours(await SecureStore.getItemAsync(QUIET_HOURS_KEY));
  } catch {
    return decodeQuietHours(null);
  }
}

export async function saveQuietHours(q: QuietHours): Promise<void> {
  try {
    await SecureStore.setItemAsync(QUIET_HOURS_KEY, encodeQuietHours(q));
  } catch {
    // The setting reverts to off; nothing is lost beyond a preference.
  }
}

/**
 * "Voice call": whether Pew's finished / needs-you pushes are worded as a call.
 * Off unless the user turned it on; anything unreadable also means off.
 */
export async function loadVoiceCall(): Promise<boolean> {
  try {
    return (await SecureStore.getItemAsync(VOICE_CALL_KEY)) === "1";
  } catch {
    return false;
  }
}

export async function saveVoiceCall(on: boolean): Promise<void> {
  try {
    if (on) await SecureStore.setItemAsync(VOICE_CALL_KEY, "1");
    else await SecureStore.deleteItemAsync(VOICE_CALL_KEY);
  } catch {
    // The setting reverts to off; nothing is lost beyond a preference.
  }
}

/**
 * "Native call screen": ring with CallKit / Telecom, and run voice
 * conversations as system calls. Off unless the user turned it on; anything
 * unreadable also means off, because a phone that rings by surprise is worse
 * than one that shows a banner.
 */
export async function loadNativeCall(): Promise<boolean> {
  try {
    return (await SecureStore.getItemAsync(NATIVE_CALL_KEY)) === "1";
  } catch {
    return false;
  }
}

export async function saveNativeCall(on: boolean): Promise<void> {
  try {
    if (on) await SecureStore.setItemAsync(NATIVE_CALL_KEY, "1");
    else await SecureStore.deleteItemAsync(NATIVE_CALL_KEY);
  } catch {
    // The setting reverts to off; nothing is lost beyond a preference.
  }
}
