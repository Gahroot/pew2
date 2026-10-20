import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { agentSound, AGENT_SOUND_IDS, LOUDNESS_TIERS, loudnessTier, chargeOffsetSeconds, levelPitch, levelSound, shouldPlay, SOUND_NAMES, REPEAT_GAP_MS, hapticSound, pokeSound, detentSound, softYields, SOFT_YIELD_MS, TOUCH_SOUNDS } from "./soundsPolicy";

test("every sound has its file", () => {
  for (const name of SOUND_NAMES) expect(existsSync(join(import.meta.dir, "..", "assets", "sounds", `${name}.wav`))).toBe(true);
});

describe("thinking level", () => {
  test("pitch climbs across the dial whatever the number of levels", () => {
    expect(levelPitch(0, 5)).toBe(0);
    expect(levelPitch(4, 5)).toBe(4);
    expect(levelPitch(1, 3)).toBe(2);
    expect(levelPitch(5, 6)).toBe(4);
  });

  test("up sings the stop reached, the top gets the flourish, down sighs from the stop left", () => {
    expect(levelSound(0, 1, 5)).toBe("level-up-1");
    expect(levelSound(3, 4, 5)).toBe("level-max");
    expect(levelSound(4, 3, 5)).toBe("level-down-4");
    expect(levelSound(2, 2, 5)).toBeUndefined();
    expect(levelSound(0, 1, 1)).toBeUndefined();
  });
});

test("the same sound fired twice at once plays once", () => {
  expect(shouldPlay(1000, undefined)).toBe(true);
  expect(shouldPlay(1000 + REPEAT_GAP_MS - 1, 1000)).toBe(false);
  expect(shouldPlay(1000 + REPEAT_GAP_MS, 1000)).toBe(true);
  // A clock that jumps back must not mute everything.
  expect(shouldPlay(500, 1000)).toBe(true);
});

test("a resumed hold picks the charge up where it left off", () => {
  expect(chargeOffsetSeconds(0, 1600)).toBe(0);
  expect(chargeOffsetSeconds(0.5, 1600)).toBe(0.8);
  expect(chargeOffsetSeconds(2, 1600)).toBe(1.6);
});

describe("touch sounds", () => {
  test("every haptic has a sound, and every sound has a file", () => {
    const kinds = ["tap", "select", "sent", "finished", "attention", "warned", "poke", "detent", "failed", "toggleOn", "toggleOff", "chosen"] as const;
    for (const kind of kinds) expect(SOUND_NAMES).toContain(hapticSound(kind));
    for (const name of SOUND_NAMES) expect(existsSync(join(import.meta.dir, "..", "assets", "sounds", `${name}.wav`))).toBe(true);
  });

  test("Pew's pokes walk four voices, never the same twice running", () => {
    const voices = Array.from({ length: 8 }, (_, n) => pokeSound(n));
    expect(new Set(voices).size).toBe(4);
    for (let n = 1; n < voices.length; n++) expect(voices[n]).not.toBe(voices[n - 1]);
    expect(pokeSound(-1)).toBe(pokeSound(3));
  });

  test("detents climb with the position and wrap", () => {
    expect(detentSound(0)).toBe("detent-0");
    expect(detentSound(4)).toBe("detent-4");
    expect(detentSound(6)).toBe("detent-1");
    expect(detentSound(undefined)).toBe("detent-2");
  });

  test("a soft sound gives way just after a cue; a cue never does", () => {
    expect(softYields("swish-up", 1000 + SOFT_YIELD_MS - 1, 1000)).toBe(true);
    expect(softYields("swish-up", 1000 + SOFT_YIELD_MS, 1000)).toBe(false);
    expect(softYields("attention", 1001, 1000)).toBe(false);
    expect(softYields("tick", 1000, undefined)).toBe(false);
    expect(softYields("tick", 500, 1000)).toBe(false);
  });

  test("touch sounds are preloaded; the long launch sounds aren't", () => {
    expect(TOUCH_SOUNDS).toContain("tick");
    expect(TOUCH_SOUNDS).toContain("poke-0");
    expect(TOUCH_SOUNDS).not.toContain("burst");
    expect(TOUCH_SOUNDS).not.toContain("charge");
  });
});

test("each agent has its own sound; an unknown one gets Pew's", () => {
  const names = AGENT_SOUND_IDS.map((id) => agentSound(id));
  expect(new Set(names).size).toBe(AGENT_SOUND_IDS.length);
  for (const name of names) expect(SOUND_NAMES).toContain(name);
  expect(agentSound("someday-agent")).toBe("choose");
  expect(agentSound(undefined)).toBe("choose");
});

test("every provider manifest has a signature", () => {
  const dir = join(import.meta.dir, "..", "..", "..", "providers");
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".json"))) {
    const { id } = JSON.parse(readFileSync(join(dir, file), "utf8")) as { id: string };
    expect(agentSound(id)).toBe(`agent-${id}` as never);
  }
});

describe("loudness: nothing louder than its job", () => {
  // Reads the actual files: a regenerated sound that drifts louder fails here.
  const loudestDb = (name: string): number => {
    const buf = readFileSync(join(import.meta.dir, "..", "assets", "sounds", `${name}.wav`));
    const data = buf.indexOf("data") + 8;
    const samples = new Int16Array(buf.buffer, buf.byteOffset + data, Math.floor((buf.length - data) / 2));
    const win = 2205;
    let best = 0;
    for (let i = 0; i + win <= samples.length; i += Math.floor(win / 2)) {
      let sum = 0;
      for (let j = i; j < i + win; j++) sum += (samples[j]! / 32768) ** 2;
      best = Math.max(best, Math.sqrt(sum / win));
    }
    return 20 * Math.log10(best + 1e-12);
  };
  test.each(SOUND_NAMES.filter((name) => !name.startsWith("agent-")))("%s stays within its tier", (name) => {
    expect(loudestDb(name)).toBeLessThanOrEqual(LOUDNESS_TIERS[loudnessTier(name)] + 0.5);
  });
  test("everyday sounds sit far below the old bells", () => {
    for (const name of ["send", "done", "confirm", "warn", "error"] as const) expect(loudestDb(name)).toBeLessThan(-30);
    expect(loudestDb("attention")).toBeLessThan(-25);
  });
});
