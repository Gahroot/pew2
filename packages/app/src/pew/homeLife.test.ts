import { describe, expect, test } from "bun:test";
import { HOME_PEW_MAX, HOME_PEW_MIN, holdPulseGap, holdPulseKind, homePewMood, homePewSize, LIFE_IDLE_MAX_MS, LIFE_IDLE_MIN_MS, LIFE_MOODS, nextLifeBeat, SPIN_STAGES, spinStage, WELCOME_SHOW, welcomeBeat } from "./homeLife";
import { SPIN_BURST, makePewBody, advancePew, dragPew, releasePew } from "./engine";

const space = { height: 956, top: 120, bottom: 42, cardHeight: 104, rowGap: 8, label: 28, chrome: 60 };

describe("homePewSize", () => {
  test("max with no cards", () => expect(homePewSize({ ...space, cards: 0 })).toBe(HOME_PEW_MAX));
  test("fills the room left by six cards on a tall phone", () => {
    const size = homePewSize({ ...space, cards: 6 });
    expect(size).toBeGreaterThanOrEqual(HOME_PEW_MIN);
    expect(size).toBeLessThanOrEqual(HOME_PEW_MAX);
    expect(size).toBe(Math.min(HOME_PEW_MAX, 956 - 120 - 42 - 28 - (3 * 104 + 16) - 60));
  });
  test("never below min on a small phone", () => expect(homePewSize({ ...space, height: 600, cards: 6 })).toBe(HOME_PEW_MIN));
  test("fewer card rows, bigger Pew", () => expect(homePewSize({ ...space, height: 700, cards: 2 })).toBeGreaterThan(homePewSize({ ...space, height: 700, cards: 6 })));
});

describe("nextLifeBeat", () => {
  test("an excursion returns to idle for 6-10 s", () => {
    for (const r of [0, 0.5, 0.99]) {
      const beat = nextLifeBeat("happy", "happy", r);
      expect(beat.mood).toBe("idle");
      expect(beat.ms).toBeGreaterThanOrEqual(LIFE_IDLE_MIN_MS);
      expect(beat.ms).toBeLessThanOrEqual(LIFE_IDLE_MAX_MS);
    }
  });
  test("idle goes somewhere, never the last excursion again", () => {
    for (let i = 0; i < 20; i++) {
      const beat = nextLifeBeat("idle", "thinking", i / 20);
      expect(beat.mood).not.toBe("thinking");
      expect(LIFE_MOODS.map((m) => m.mood)).toContain(beat.mood);
    }
  });
  test("out-of-range randoms are clamped", () => expect(nextLifeBeat("idle", undefined, 1).mood).toBe(LIFE_MOODS[LIFE_MOODS.length - 1]?.mood ?? "idle"));
});

describe("homePewMood", () => {
  test("real state wins", () => {
    expect(homePewMood("sleepy", "happy", true)).toBe("sleepy");
    expect(homePewMood("working", "reading", false)).toBe("working");
    expect(homePewMood("oops", "happy", false)).toBe("oops");
  });
  test("hold over life over idle", () => {
    expect(homePewMood("idle", "happy", true)).toBe("listening");
    expect(homePewMood("idle", "reading", false)).toBe("reading");
  });
});

describe("hold rhythm", () => {
  test("pulses quicken and firm up", () => {
    expect(holdPulseGap(0)).toBe(260);
    expect(holdPulseGap(5000)).toBe(90);
    expect(holdPulseGap(800)).toBeLessThan(260);
    expect(holdPulseKind(0)).toBe("poke");
    expect(holdPulseKind(1500)).toBe("detent");
  });
});

test("the welcome show is lively: never idle for long, never the same mood twice running, and loops", () => {
  for (let i = 0; i < WELCOME_SHOW.length; i++) {
    const a = welcomeBeat(i);
    const b = welcomeBeat(i + 1);
    expect(a.mood).not.toBe(b.mood);
    if (a.mood === "idle") expect(a.ms).toBeLessThanOrEqual(2000);
  }
  expect(welcomeBeat(WELCOME_SHOW.length)).toEqual(welcomeBeat(0));
  expect(welcomeBeat(-1)).toEqual(welcomeBeat(WELCOME_SHOW.length - 1));
});

describe("the spin toy", () => {
  test("stages climb with speed, and a dip doesn't flicker the line", () => {
    expect(spinStage(0)).toBe(0);
    expect(spinStage(5)).toBe(1);
    expect(spinStage(-15)).toBe(2);
    expect(spinStage(22)).toBe(3);
    // Just under "Nearly there" stays there; well under drops.
    expect(spinStage(19, 3)).toBe(3);
    expect(spinStage(16, 3)).toBe(2);
  });
  test("the lines Ken asked for, in order", () => {
    expect(SPIN_STAGES.map((stage) => stage.line)).toEqual(["Spin me. Try it now", "Yes, keep going!", "Faster!", "Nearly there!"]);
    expect(SPIN_STAGES.at(-1)!.at).toBeLessThan(SPIN_BURST);
  });
});

describe("spinning Pew like a basketball", () => {
  const toy = () => {
    const B = makePewBody(160);
    B.toy = true;
    return B;
  };
  const flick = (B: ReturnType<typeof makePewBody>, points: number, ms: number) => {
    const steps = Math.max(1, Math.round(ms / 16));
    for (let i = 0; i < steps; i++) dragPew(B, points / steps, 0, ms / 1000 / steps);
    releasePew(B);
  };
  test("one flick isn't enough; flicks add up to the burst", () => {
    const B = toy();
    flick(B, 280, 160);
    expect(Math.abs(B.spinV)).toBeGreaterThan(4);
    expect(Math.abs(B.spinV)).toBeLessThan(SPIN_BURST);
    for (let k = 0; k < 4; k++) flick(B, 280, 120);
    expect(Math.abs(B.spinV)).toBeGreaterThanOrEqual(SPIN_BURST);
  });
  test("it keeps spinning on its own, slowly losing speed", () => {
    const B = toy();
    flick(B, 280, 160);
    const before = Math.abs(B.spinV);
    for (let i = 0; i < 60; i++) advancePew(B, i / 60, 1 / 60, "idle");
    expect(Math.abs(B.spinV)).toBeLessThan(before);
    expect(Math.abs(B.spinV)).toBeGreaterThan(before * 0.6);
  });
  test("a slow hand on a fast spin brakes it; a flick the other way slows it", () => {
    const B = toy();
    for (let k = 0; k < 3; k++) flick(B, 280, 120);
    const fast = B.spinV;
    flick(B, 20, 400);
    expect(Math.abs(B.spinV)).toBeLessThan(Math.abs(fast));
    flick(B, -280, 120);
    expect(Math.abs(B.spinV)).toBeLessThan(Math.abs(fast) * 0.7);
  });
  test("an ordinary Pew still just follows the finger", () => {
    const B = makePewBody(160);
    flick(B, 280, 160);
    flick(B, 280, 160);
    expect(Math.abs(B.spinV)).toBeLessThan(SPIN_BURST);
  });
});
