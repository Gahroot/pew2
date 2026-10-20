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
import { parseHomeCards } from "./homeDashboard";
import { parseDismissedAt } from "./notificationAsk";
import { parseProgress, type Progress } from "./onboarding";
import { fromCachedProviders, toCachedProviders } from "./providerCache";
import type { Provider } from "./useDaemon";

const LAST_PROVIDER_KEY = "pew2.lastProviderId";
const VOICE_CURSOR_KEY = "pew2.voiceCursor";
const VOICE_CONSENT_KEY = "pew2.voiceConsent.v1";
const HOME_CARDS_KEY = "pew2.homeCards.v1";
const ALERTS_DISMISSED_KEY = "pew2.alertsDismissedAt";
const ONBOARDING_KEY = "pew2.onboarding";
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

/**
 * Whether the user agreed, once, that calls send their voice to OpenAI (App
 * Review 5.1.2(i): name the third-party AI and ask before the first call).
 * A store that can't be read means "not yet": asking again is the safe side.
 */
export async function loadVoiceConsent(): Promise<boolean> {
  try {
    return (await SecureStore.getItemAsync(VOICE_CONSENT_KEY)) === "yes";
  } catch {
    return false;
  }
}

export async function saveVoiceConsent(): Promise<void> {
  try {
    await SecureStore.setItemAsync(VOICE_CONSENT_KEY, "yes");
  } catch {
    // Asked again next time, which is harmless.
  }
}

/** When the alerts card was last answered "Not now" (see `notificationAsk.ts`). */
export async function loadAlertsDismissedAt(): Promise<number | undefined> {
  try {
    return parseDismissedAt(await SecureStore.getItemAsync(ALERTS_DISMISSED_KEY));
  } catch {
    return undefined;
  }
}

/** Onboarding progress (`onboarding.ts`); unreadable reads as never started. */
export async function loadOnboarding(): Promise<Progress | undefined> {
  try {
    return parseProgress(await SecureStore.getItemAsync(ONBOARDING_KEY));
  } catch {
    return undefined;
  }
}

export async function saveOnboarding(progress: Progress): Promise<void> {
  try {
    await SecureStore.setItemAsync(ONBOARDING_KEY, progress);
  } catch {
    // Resumes one step early next launch at worst.
  }
}

export async function saveAlertsDismissedAt(at: number): Promise<void> {
  try {
    await SecureStore.setItemAsync(ALERTS_DISMISSED_KEY, String(at));
  } catch {
    // Worst case the card returns sooner than a week.
  }
}

/** How many cards home showed last time (`parseHomeCards`), for laying it out before the list arrives. */
export async function loadHomeCards(): Promise<number | undefined> {
  try {
    return parseHomeCards(await SecureStore.getItemAsync(HOME_CARDS_KEY));
  } catch {
    return undefined;
  }
}

export async function saveHomeCards(count: number): Promise<void> {
  try {
    await SecureStore.setItemAsync(HOME_CARDS_KEY, String(count));
  } catch {
    // Laid out for the old count next launch, then corrected.
  }
}
