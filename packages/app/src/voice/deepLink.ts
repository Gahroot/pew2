/**
 * `pew2://voice?source=...` — the one incoming link this app routes.
 *
 * It can start a voice conversation and do nothing else. Pairing is never
 * reachable from a link (see the `scheme` note in app.json), and the optional
 * focus fields are only hints the daemon validates against its own state.
 *
 * Pure: `ui/useVoice.ts` binds `Linking`.
 */
import { VoiceSourceSchema, type VoiceSource } from "./types";

export interface VoiceActivation {
  source: VoiceSource;
  focusEventId?: number;
  focusTaskId?: string;
}

/** Spellings people type into Shortcuts, mapped to the wire enum. */
const ALIASES: Record<string, VoiceSource> = {
  siri: "siri_shortcut",
  shortcut: "siri_shortcut",
  shortcuts: "siri_shortcut",
  "action-button": "action_button",
  actionbutton: "action_button",
  "lock-screen": "lock_screen",
  lockscreen: "lock_screen",
  app: "in_app",
};

function sourceOf(raw: string | undefined): VoiceSource {
  if (!raw) return "in_app";
  const key = raw.trim().toLowerCase();
  const direct = VoiceSourceSchema.safeParse(key);
  if (direct.success) return direct.data;
  return ALIASES[key] ?? "in_app";
}

/** Parses by hand: `URL` query handling differs between Hermes and Node. */
function queryOf(url: string): Record<string, string> {
  const at = url.indexOf("?");
  if (at < 0) return {};
  const hash = url.indexOf("#", at);
  const query = url.slice(at + 1, hash < 0 ? undefined : hash);
  const out: Record<string, string> = {};
  for (const pair of query.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const rawKey = eq < 0 ? pair : pair.slice(0, eq);
    const rawValue = eq < 0 ? "" : pair.slice(eq + 1);
    try {
      out[decodeURIComponent(rawKey)] = decodeURIComponent(rawValue.replace(/\+/g, " "));
    } catch {
      // A malformed escape drops that one field, never the whole link.
    }
  }
  return out;
}

/** The activation a URL asks for, or undefined when it is not a voice link. */
export function parseVoiceLink(url: string | null | undefined): VoiceActivation | undefined {
  if (!url) return undefined;
  const match = /^pew2:\/\/+voice\/?(?:[?#].*)?$/i.exec(url.trim());
  if (!match) return undefined;
  const query = queryOf(url.trim());
  const activation: VoiceActivation = { source: sourceOf(query.source) };
  const event = query.focusEventId ?? query.event;
  if (event !== undefined && /^\d{1,12}$/.test(event)) activation.focusEventId = Number(event);
  const task = query.focusTaskId ?? query.task;
  if (task && task.length <= 200) activation.focusTaskId = task;
  return activation;
}

/** The link a notification or shortcut should open. */
export function voiceLink(activation: VoiceActivation): string {
  const parts = [`source=${encodeURIComponent(activation.source)}`];
  if (activation.focusEventId !== undefined) parts.push(`focusEventId=${activation.focusEventId}`);
  if (activation.focusTaskId) parts.push(`focusTaskId=${encodeURIComponent(activation.focusTaskId)}`);
  return `pew2://voice?${parts.join("&")}`;
}

/**
 * Drops the second delivery of one link. `getInitialURL` and the `url` event
 * can both report a cold-start link; opening voice twice would restart it.
 */
export function isRepeatLink(
  last: { url: string; at: number } | undefined,
  url: string,
  now: number,
  windowMs = 2000,
): boolean {
  return last !== undefined && last.url === url && now - last.at < windowMs;
}
