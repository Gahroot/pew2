import { describe, expect, test } from "bun:test";

import { homeMaxHeight, recentChatsFit } from "./homeFit";

// Illustrative round numbers, not measurements: a block (Pew, status line,
// greeting, hint) of 300, and the card row's 76 plus 24 above it.
const CORE = 300;
const ROW = 100;

describe("homeMaxHeight", () => {
  test("a centred block may reach down to the composer, less the gap", () => {
    // Body 600, composer covers 150 and keeps 8 clear: the block's bottom may sit
    // at 442, so a centred block may be 600 - 2 × 158 = 284 tall.
    expect(homeMaxHeight(600, 150, 8)).toBe(284);
  });

  test("an unmeasured body gives no limit", () => {
    expect(homeMaxHeight(0, 150, 8)).toBeUndefined();
  });
});

describe("recentChatsFit", () => {
  test("a short body drops the row: it would sit under the composer", () => {
    // A body of 640 with 180 of composer allows 640 - 2 × 188 = 264, under 400.
    expect(recentChatsFit(CORE, ROW, homeMaxHeight(640, 180, 8))).toBe(false);
  });

  test("a tall body keeps it", () => {
    // A body of 830 with 200 of composer allows 830 - 2 × 208 = 414, over 400.
    expect(recentChatsFit(CORE, ROW, homeMaxHeight(830, 200, 8))).toBe(true);
  });

  test("exactly at the limit still fits", () => {
    expect(recentChatsFit(CORE, ROW, CORE + ROW)).toBe(true);
    expect(recentChatsFit(CORE, ROW, CORE + ROW - 1)).toBe(false);
  });

  test("nothing measured yet keeps the row, so taller phones never jump", () => {
    expect(recentChatsFit(0, ROW, 200)).toBe(true);
    expect(recentChatsFit(CORE, ROW, undefined)).toBe(true);
  });
});
