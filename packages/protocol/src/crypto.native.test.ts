import { afterEach, expect, test } from "bun:test";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { fromBase64Url, open, seal, toBase64Url, useNativeAead, type NativeAead } from "./crypto";

const enc = (s: string) => new TextEncoder().encode(s);
/** A faithful stand-in for the iOS module. */
const faithful: NativeAead = {
  openText(key, nonce, aad, ct) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(xchacha20poly1305(key, nonce, aad).decrypt(fromBase64Url(ct)));
    } catch {
      return null;
    }
  },
  sealText: (key, nonce, aad, text) => toBase64Url(xchacha20poly1305(key, nonce, aad).encrypt(enc(text))),
};
let opened = 0;
const counting: NativeAead = {
  openText: (...args) => {
    opened++;
    return faithful.openText(...args);
  },
  sealText: (...args) => faithful.sealText(...args),
};

afterEach(() => {
  useNativeAead(undefined);
  opened = 0;
});

test("a faithful native cipher is installed and used both ways, interoperating with JS frames", () => {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const jsFrame = seal(key, { t: "x", s: "héllo 👋" }, { sid: "s", seq: 3, ctr: 1 });
  expect(useNativeAead(counting)).toBe(true);
  opened = 0; // the self-test's own opens
  expect(open(key, jsFrame)).toEqual({ t: "x", s: "héllo 👋" });
  expect(opened).toBe(1);
  const nativeFrame = seal(key, { a: 1 }, { ctr: 2 });
  useNativeAead(undefined);
  expect(open(key, nativeFrame)).toEqual({ a: 1 });
});

test("a native cipher that disagrees is refused, and the JS cipher stays", () => {
  const accepting: NativeAead = { ...faithful, openText: (key, nonce, aad, ct) => faithful.openText(key, nonce, aad, ct) ?? "{}" };
  const wrongBytes: NativeAead = { ...faithful, sealText: () => "AAAA" };
  const throwing: NativeAead = { ...faithful, openText: () => { throw new Error("boom"); } };
  for (const broken of [accepting, wrongBytes, throwing]) expect(useNativeAead(broken)).toBe(false);
});

test("fails closed: a native refusal or throw on a real frame is a rejected frame", () => {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const frame = seal(key, { ok: true }, { ctr: 1 });
  let mode: "ok" | "null" | "throw" = "ok";
  const switchable: NativeAead = {
    sealText: (...args) => faithful.sealText(...args),
    openText: (...args) => {
      if (mode === "null") return null;
      if (mode === "throw") throw new Error("native failure");
      return faithful.openText(...args);
    },
  };
  expect(useNativeAead(switchable)).toBe(true);
  mode = "null";
  expect(open(key, frame)).toBeUndefined();
  mode = "throw";
  expect(open(key, frame)).toBeUndefined();
});
