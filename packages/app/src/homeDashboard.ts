/**
 * Home: cards for the last conversations, nothing else. One that needs you
 * (an approval or question) comes first, then the newest. Each card carries
 * its own state, so "needs you" and "working" show on the card instead of in
 * sections of their own.
 *
 * Built on `widgetRows`, so home and the home-screen widget agree about every
 * conversation's state. Pure and Expo-free (tested under bun).
 */
import { widgetRows, type WidgetInput, type WidgetRow } from "./widgetSnapshot";

/** Cards on home. A short window of recent work, not the full history (that is the drawer). */
export const HOME_CARDS = 6;

export interface DashboardCard extends WidgetRow {
  /** One line under the title: the approval or question, when there is one. */
  line?: string;
}

export interface HomeDashboard {
  cards: DashboardCard[];
  /** No conversation at all: the fresh-pairing empty state. */
  empty: boolean;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.replace(/\s+/g, " ").trim() : undefined;
}

function field(value: unknown, key: string): unknown {
  return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}

/** The permission's title, else the first question asked. */
function needsLine(permission: unknown, asks: readonly unknown[] | undefined): string | undefined {
  const title = text(field(permission, "title"));
  if (title) return title;
  const first = asks?.[0];
  const questions = field(first, "questions");
  const question = Array.isArray(questions) ? text(field(questions[0], "question")) : undefined;
  return question ?? (asks && asks.length > 0 ? "Question" : undefined);
}

export function homeDashboard(input: WidgetInput): HomeDashboard {
  const byId = new Map(input.sessions.map((session) => [session.id, session]));
  const rows = widgetRows(input);
  const cards: DashboardCard[] = rows.map((row) => {
    if (row.state !== "waiting") return row;
    const line = needsLine(byId.get(row.id)?.permission, input.asks[row.id]);
    return line ? { ...row, line } : row;
  });
  // Needs you first, then newest; ties keep the list order (sort is stable).
  cards.sort((a, b) => Number(b.state === "waiting") - Number(a.state === "waiting") || (b.at ?? 0) - (a.at ?? 0));
  return { cards: cards.slice(0, HOME_CARDS), empty: rows.length === 0 };
}

/**
 * How many cards home showed last time, as stored (a digit). Home lays itself
 * out for that many from the first frame, before the session list arrives,
 * so Pew never starts centred and then moves up. Unreadable reads as unknown.
 */
export function parseHomeCards(raw: string | null | undefined): number | undefined {
  if (raw === null || raw === undefined || !/^[0-9]+$/.test(raw)) return undefined;
  return Math.min(HOME_CARDS, Number(raw));
}
