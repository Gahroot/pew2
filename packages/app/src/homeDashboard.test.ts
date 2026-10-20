import { describe, expect, it } from "bun:test";
import { HOME_CARDS, homeDashboard, parseHomeCards } from "./homeDashboard";
import type { WidgetInput } from "./widgetSnapshot";

const providers = [{ id: "claude", name: "Claude Code", color: "#D97757" }];

function session(id: string, extra: Partial<WidgetInput["sessions"][number]> = {}) {
  return { id, providerId: "claude", title: `Chat ${id}`, folder: "pew2", startedAt: 1000, ...extra };
}

describe("homeDashboard", () => {
  it("one card per recent conversation, needs-you first, then newest", () => {
    const home = homeDashboard({
      sessions: [
        session("old", { startedAt: 100 }),
        session("new", { startedAt: 900 }),
        session("busy", { busy: true, startedAt: 500 }),
        session("perm", { permission: { title: "Run npm test" }, startedAt: 50 }),
        session("ask", { startedAt: 40 }),
      ],
      asks: { ask: [{ questions: [{ question: "Which  branch?" }] }] },
      providers,
    });
    expect(home.cards.slice(0, 2).map((card) => [card.id, card.line])).toEqual([["perm", "Run npm test"], ["ask", "Which branch?"]]);
    expect(home.cards.slice(2).map((card) => card.id)).toEqual(["new", "busy", "old"]);
    expect(home.cards.length).toBeLessThanOrEqual(6);
    expect(home.cards.find((card) => card.id === "busy")?.state).toBe("working");
    expect(home.cards[0]?.agent).toBe("Claude Code");
    expect(home.empty).toBe(false);
  });

  it("keeps it short", () => {
    const sessions = Array.from({ length: HOME_CARDS + 5 }, (_, i) => session(`s${i}`, { startedAt: 1000 - i }));
    const home = homeDashboard({ sessions, asks: {}, providers });
    expect(home.cards).toHaveLength(HOME_CARDS);
    expect(home.cards[0]?.id).toBe("s0");
  });

  it("nothing yet is the empty state", () => {
    expect(homeDashboard({ sessions: [], asks: {}, providers })).toEqual({ cards: [], empty: true });
  });
});

it("remembers how many cards home showed, within the limit", () => {
  expect(parseHomeCards("4")).toBe(4);
  expect(parseHomeCards("99")).toBe(HOME_CARDS);
  expect(parseHomeCards("0")).toBe(0);
  expect(parseHomeCards(null)).toBeUndefined();
  expect(parseHomeCards("x")).toBeUndefined();
});
