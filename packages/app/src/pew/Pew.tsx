/**
 * Pew, pew2's living mascot, as a React Native component.
 *
 *   <Pew size={120} mood="working" color="#4ade80" interactive />
 *
 * The body is simulated and painted entirely on the UI thread: a Reanimated
 * frame callback advances `engine.ts` and records the frame into a Skia
 * picture, which the canvas draws. The React tree never re-renders while it
 * moves, so a busy transcript cannot make it stutter and it cannot slow the
 * transcript down.
 *
 * It sleeps when nobody can see it: the app in the background, `paused`, or
 * Reduce Motion (then it holds one settled, still pose in its mood). A small
 * Pew runs at half rate; nobody can tell at chip size and it halves the cost.
 *
 * Decorative by default (hidden from assistive tech); pass
 * `accessibilityLabel` when it carries meaning on its own.
 */
import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { BlurStyle, Canvas, Picture, Skia, type SkCanvas, type SkPicture } from "@shopify/react-native-skia";
import Animated, { Easing, cancelAnimation, runOnJS, runOnUI, useAnimatedStyle, useFrameCallback, useSharedValue, withSpring, withTiming, type FrameInfo, type SharedValue } from "react-native-reanimated";
import { sounds } from "../ui/sounds";
import { HOLD_CHARGE_MS, holdPulseGap, holdPulseKind } from "./homeLife";
import { haptics } from "../ui/haptics";
import { useAppActive } from "../ui/useAppActive";
import { useReducedMotion } from "../ui/useReducedMotion";
import {
  advancePew,
  dragPew,
  makePewBody,
  pewSleepSeed,
  PEW_SLEEP_STYLES,
  paintPew,
  pokePew,
  feedPew,
  releasePew,
  touchPew,
  settlePew,
  SPIN_BURST,
  type PewBody,
  type PewMood,
  type PewPainter,
  type PewPalette,
  type RGB,
} from "./engine";
import { pewPalette } from "./palette";
import { beginFrame, blankPicture, endFrame } from "../ui/skiaFrame";

export interface PewProps {
  /** Edge of its square box, in points. */
  size: number;
  mood?: PewMood;
  /** The agent's brand colour; none is pew2's own coral. */
  color?: string;
  /** Drag to spin it, tap to poke it. */
  interactive?: boolean;
  /**
   * Called after a tap pokes it (implies `interactive`). Home opens the agent
   * carousel this way: the poke lands first, so the tap still feels physical.
   */
  onPress?: () => void;
  /**
   * Press and hold (implies `interactive`): Pew squishes as it charges and
   * haptics quicken in rhythm; letting go springs it back with a bounce.
   * Called with "start" when the hold begins and "end" on release. A hold
   * never also fires `onPress`.
   */
  onHold?: (phase: "start" | "end") => void;
  /**
   * Hold still while this is strictly between 0 and 1: a transition that must
   * get every frame (home passes the keyboard's progress, so the composer
   * tracks the keyboard at full rate). Read on the UI thread, so it costs no
   * re-render to start or stop.
   */
  holdWhile?: SharedValue<number>;
  /**
   * Feed it from outside: each time this counter goes up, Pew takes a small
   * ripple at `feedFrom` (box coordinates, default its left edge) as if
   * something just landed in it. Mission control's packets drive it.
   */
  feeds?: SharedValue<number>;
  feedFrom?: { x: number; y: number };
  /** Freeze it (an off-screen row, a closed drawer). */
  paused?: boolean;
  /**
   * The spin toy (home's Pew): spun like a basketball, flicks add up, and
   * past SPIN_BURST it bursts. `spin` is written on the UI thread with the
   * speed every frame (rad/s, signed); `onBurst` fires once as it bursts.
   * `gone` (0..1) hides him while his dots are flying, and he comes back as
   * it drops to 0. A real tap or hold still works as before.
   */
  toy?: { spin: SharedValue<number>; gone: SharedValue<number>; onBurst: () => void };
  /**
   * How far past his box a finger still counts as on him, in points: a
   * near miss grabs Pew instead of the page under him. Default none.
   */
  reach?: number;
  accessibilityLabel?: string;
  /** Picks one of ten sleeping styles (hashed), e.g. a provider id, so a column of dozing Pews differs. */
  sleepKey?: string;
  /**
   * Picks the sleeping style outright (0–9) instead of from the key's hash, for
   * a list that must never repeat one next to another (the agent rail). The key
   * still gives each its own breathing phase.
   */
  sleepStyle?: number;
  style?: StyleProp<ViewStyle>;
}

/** Below this edge it runs at half rate. */
const HALF_RATE_BELOW = 40;

/** Paints one recorded frame through Skia. Built per frame on the UI thread. */
/**
 * The Skia objects a frame paints with, made once per UI runtime and reused.
 *
 * Measured: the hero Pew used to cost so much UI-thread time per frame that the
 * whole screen fell to ~20fps (the keyboard-tracking events arrived every 50ms
 * instead of every 16ms, so the composer stepped behind the keyboard). Most of
 * it was allocation and string parsing per dot: three Paints and a set of blur
 * filters built every frame, and every colour formatted as an `rgba(...)`
 * string and parsed back by `Skia.Color`. Now the paints and filters live for
 * the runtime and a colour is four floats written into one reused array.
 */
interface PewTools {
  fill: ReturnType<typeof Skia.Paint>;
  halo: ReturnType<typeof Skia.Paint>;
  stroke: ReturnType<typeof Skia.Paint>;
  col: Float32Array;
  blurs: Record<number, ReturnType<typeof Skia.MaskFilter.MakeBlur>>;
  /** One path, reset per shape: a recorded picture keeps its own copy. */
  shape: ReturnType<typeof Skia.Path.Make>;
}

function pewTools(): PewTools {
  "worklet";
  const g = globalThis as unknown as { __pewTools?: PewTools };
  if (g.__pewTools) return g.__pewTools;
  const fill = Skia.Paint();
  fill.setAntiAlias(true);
  const halo = Skia.Paint();
  halo.setAntiAlias(true);
  halo.setBlendMode(12); // Plus: lights add up, like LEDs
  const stroke = Skia.Paint();
  stroke.setAntiAlias(true);
  stroke.setStyle(1); // Stroke
  stroke.setStrokeCap(1); // Round
  g.__pewTools = { fill, halo, stroke, col: new Float32Array(4), blurs: {}, shape: Skia.Path.Make() };
  return g.__pewTools;
}

/** Paints one recorded frame through Skia. */
function skiaPainter(canvas: SkCanvas): PewPainter {
  "worklet";
  const { fill, halo, stroke, col, blurs, shape } = pewTools();
  // Writes the colour into the shared array; setColor copies it on the call.
  const color = (c: RGB, a: number) => {
    col[0] = c[0] / 255;
    col[1] = c[1] / 255;
    col[2] = c[2] / 255;
    col[3] = a < 0 ? 0 : a > 1 ? 1 : a;
    return col;
  };
  const black = (a: number) => {
    col[0] = 0;
    col[1] = 0;
    col[2] = 0;
    col[3] = a;
    return col;
  };
  // Blur filters cached by rounded radius, for the runtime's life.
  const blur = (sigma: number) => {
    const k = Math.max(0.5, Math.round(sigma * 2) / 2);
    return (blurs[k] ??= Skia.MaskFilter.MakeBlur(BlurStyle.Normal, k, true));
  };
  const path = (pts: number[], close: boolean) => {
    const p = shape;
    p.reset();
    p.moveTo(pts[0]!, pts[1]!);
    for (let i = 2; i < pts.length; i += 2) p.lineTo(pts[i]!, pts[i + 1]!);
    if (close) p.close();
    return p;
  };
  fill.setMaskFilter(null);
  return {
    dot(x, y, r, c, a) {
      if (r <= 0.05 || a <= 0.01) return;
      fill.setColor(color(c, a));
      canvas.drawCircle(x, y, r, fill);
    },
    glow(x, y, r, c, a) {
      if (r <= 0.1 || a <= 0.01) return;
      halo.setColor(color(c, a));
      halo.setMaskFilter(blur(r * 0.45));
      canvas.drawCircle(x, y, r * 0.55, halo);
    },
    oval(cx, cy, rx, ry, rot, c, a, glowR, gc) {
      if (rx <= 0.05 || ry <= 0.05) return;
      canvas.save();
      canvas.translate(cx, cy);
      canvas.rotate((rot * 180) / Math.PI, 0, 0);
      const rect = Skia.XYWHRect(-rx, -ry, rx * 2, ry * 2);
      if (glowR > 0) {
        halo.setColor(color(gc, a * 0.9));
        halo.setMaskFilter(blur(glowR * 0.5));
        canvas.drawOval(rect, halo);
      }
      fill.setColor(color(c, a));
      canvas.drawOval(rect, fill);
      canvas.restore();
    },
    line(pts, width, c, a, glowR, gc) {
      if (pts.length < 4) return;
      const p = path(pts, false);
      if (glowR > 0) {
        stroke.setStrokeWidth(width * 1.6);
        stroke.setColor(color(gc, a * 0.7));
        stroke.setMaskFilter(blur(glowR * 0.5));
        canvas.drawPath(p, stroke);
      }
      stroke.setMaskFilter(null);
      stroke.setStrokeWidth(width);
      stroke.setColor(color(c, a));
      canvas.drawPath(p, stroke);
    },
    poly(pts, c, a) {
      if (pts.length < 6) return;
      fill.setColor(color(c, a));
      canvas.drawPath(path(pts, true), fill);
    },
    shadow(cx, cy, w, h, a) {
      if (w <= 0.1) return;
      fill.setColor(black(a));
      fill.setMaskFilter(blur(Math.max(1, h * 0.8)));
      canvas.drawOval(Skia.XYWHRect(cx - w * 0.85, cy - h * 0.6, w * 1.7, h * 1.2), fill);
      fill.setMaskFilter(null);
    },
  };
}

/** One frame, recorded with the runtime's shared recorder (see `skiaFrame.ts`). */
function recordFrame(body: PewBody, t: number, mood: PewMood, pal: PewPalette): SkPicture {
  "worklet";
  const canvas = beginFrame(body.S, body.S);
  paintPew(body, t, mood, pal, skiaPainter(canvas));
  return endFrame();
}

interface TickerProps {
  S: number;
  seed: number;
  body: SharedValue<PewBody | null>;
  mood: SharedValue<PewMood>;
  palette: SharedValue<PewPalette>;
  /** The palette actually painted, easing toward `palette`. */
  shown: SharedValue<PewPalette | null>;
  picture: SharedValue<SkPicture>;
  clock: SharedValue<number>;
  /** Seconds since the last repaint (repaints are capped per second). */
  sinceDraw: SharedValue<number>;
  /** While strictly between 0 and 1, hold still (see PewProps.holdWhile). */
  hold?: SharedValue<number>;
  feeds?: SharedValue<number>;
  /** The last `feeds` value taken, so each landing ripples once. */
  fed: SharedValue<number>;
  feedX: number;
  feedY: number;
  toy?: { spin: SharedValue<number>; gone: SharedValue<number>; burst: () => void };
}

const PALETTE_KEYS = ["base", "light", "dark", "glow", "eye", "off"] as const;

/**
 * The heartbeat, mounted only while Pew is awake. Mounting and unmounting is
 * how it starts and stops: Reanimated registers a frame callback in an effect,
 * and toggling one with `setActive` while it re-registers can reach a callback
 * that is already gone. The callback is stable for the same reason — a new
 * function every render would re-register it every render.
 */
function PewTicker({ S, seed, body, mood, palette, shown, picture, clock, sinceDraw, hold, feeds, fed, feedX, feedY, toy }: TickerProps) {
  const tick = useCallback(
    (info: FrameInfo) => {
      "worklet";
      if (body.value === null || body.value.S !== S || body.value.seed !== seed) body.value = makePewBody(S, seed < 0 ? undefined : seed);
      const B = body.value;
      const dt = Math.min(1 / 30, Math.max(0.001, (info.timeSincePreviousFrame ?? 16) / 1000));
      clock.value += dt;
      // A packet landed since the last frame: take it on the side it came in.
      // A first sight of the counter, or a jump (a new target, a reset), only
      // catches up: a ripple is for a landing seen as it happened.
      if (feeds && feeds.value !== fed.value) {
        const was = fed.value;
        const delta = feeds.value - was;
        fed.value = feeds.value;
        if (was >= 0 && delta > 0 && delta <= 3) feedPew(B, feedX, feedY, 0.7 + 0.3 * delta);
      }
      if (toy) B.toy = true;
      advancePew(B, clock.value, dt, mood.value);
      if (toy) {
        toy.spin.value = B.spinV;
        // Spun past bursting: it goes, and starts again from rest.
        if (Math.abs(B.spinV) >= SPIN_BURST && toy.gone.value === 0) {
          toy.gone.value = 1;
          B.spinV = 0;
          B.yawExtra = 0;
          B.pitchExtra = 0;
          toy.spin.value = 0;
          runOnJS(toy.burst)();
        }
      }
      // Something on screen is moving that must not be starved of frames
      // (the keyboard, while the composer tracks it): hold this pose.
      if (hold && hold.value > 0.01 && hold.value < 0.99) return;
      // Repainted at most 60 times a second (30 for a small Pew), whatever the
      // display's rate: a 120Hz screen otherwise doubles the cost of something
      // nobody can see the difference in. The simulation still runs every frame.
      sinceDraw.value += dt;
      if (sinceDraw.value < (S < HALF_RATE_BELOW ? 1 / 31 : 1 / 61)) return;
      sinceDraw.value = 0;
      // A colour change morphs: the painted palette eases toward the target,
      // so switching agent recolours the same Pew instead of swapping it.
      const target = palette.value;
      let pal = shown.value;
      if (pal === null) pal = target;
      else if (pal !== target) {
        const k = 1 - Math.exp(-dt * 9);
        let done = true;
        const next = {} as PewPalette;
        for (const key of PALETTE_KEYS) {
          const a = pal[key];
          const b = target[key];
          const c: RGB = [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
          if (Math.abs(c[0] - b[0]) + Math.abs(c[1] - b[1]) + Math.abs(c[2] - b[2]) > 1.5) done = false;
          next[key] = c;
        }
        pal = done ? target : next;
      }
      shown.value = pal;
      picture.value = recordFrame(B, clock.value, mood.value, pal);
    },
    [S, seed, body, mood, palette, shown, picture, clock, sinceDraw, hold, feeds, fed, feedX, feedY, toy],
  );
  useFrameCallback(tick, true);
  return null;
}

function PewView({ size, mood = "idle", color, interactive: interactiveProp = false, onPress, onHold, paused = false, accessibilityLabel, sleepKey, sleepStyle, holdWhile, feeds, feedFrom, toy, reach = 0, style }: PewProps) {
  const hashed = sleepKey === undefined ? -1 : pewSleepSeed(sleepKey);
  // The style is the seed's remainder by the style count: swap just that part.
  const seed =
    sleepStyle === undefined
      ? hashed
      : Math.max(0, hashed) - (Math.max(0, hashed) % PEW_SLEEP_STYLES) + (((sleepStyle % PEW_SLEEP_STYLES) + PEW_SLEEP_STYLES) % PEW_SLEEP_STYLES);
  // First: the squish style below reads it (a worklet closing over a `const`
  // declared later threw on the UI thread and left Pew blank).
  const S = Math.max(10, Math.round(size));
  const interactive = interactiveProp || onPress !== undefined || onHold !== undefined;
  const holdRef = useRef(onHold);
  holdRef.current = onHold;
  const holdable = onHold !== undefined;
  // How far the hold has squished it: 0 at rest, 1 fully charged.
  const squish = useSharedValue(0);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const holdStart = useRef(0);
  const stopPulses = useCallback(() => {
    if (holdTimer.current) clearTimeout(holdTimer.current);
    holdTimer.current = undefined;
  }, []);
  const held = useCallback(() => {
    stopPulses();
    holdStart.current = Date.now();
    haptics.tap(null);
    sounds.charge(0, HOLD_CHARGE_MS);
    cancelAnimation(squish);
    squish.value = withTiming(1, { duration: HOLD_CHARGE_MS, easing: Easing.out(Easing.quad) });
    // Silent pulses (the charge sound already ticks), closer and firmer as it charges.
    const pulse = () => {
      const elapsed = Date.now() - holdStart.current;
      if (holdPulseKind(elapsed) === "detent") haptics.detent(null);
      else haptics.poke(null);
      holdTimer.current = setTimeout(pulse, holdPulseGap(elapsed));
    };
    holdTimer.current = setTimeout(pulse, holdPulseGap(0));
    holdRef.current?.("start");
  }, [squish, stopPulses]);
  const letGo = useCallback(() => {
    if (!holdTimer.current) return;
    stopPulses();
    sounds.stop("charge", 60);
    haptics.finished();
    cancelAnimation(squish);
    squish.value = withSpring(0, { damping: 6, stiffness: 260, mass: 0.6 });
    holdRef.current?.("end");
  }, [squish, stopPulses]);
  useEffect(() => () => {
    if (holdTimer.current) sounds.stop("charge", 60);
    stopPulses();
  }, [stopPulses]);
  // Wider and lower while charging; the spring back overshoots into a bounce.
  const squishStyle = useAnimatedStyle(() => ({
    transform: [{ scaleX: 1 + squish.value * 0.08 }, { scaleY: 1 - squish.value * 0.12 }, { translateY: squish.value * S * 0.05 }],
  }));
  const pressRef = useRef(onPress);
  pressRef.current = onPress;
  const tapped = useCallback(() => {
    haptics.poke();
    pressRef.current?.();
  }, []);
  const spun = useCallback(() => haptics.select(), []);
  const burstRef = useRef(toy?.onBurst);
  burstRef.current = toy?.onBurst;
  const toyBurst = useCallback(() => burstRef.current?.(), []);
  const toyTicker = useMemo(() => (toy ? { spin: toy.spin, gone: toy.gone, burst: toyBurst } : undefined), [toy, toyBurst]);
  // Gone while his dots are flying; back with a pop as `gone` drops.
  const goneStyle = useAnimatedStyle(() => {
    const g = toy ? toy.gone.value : 0;
    return { opacity: 1 - g, transform: [{ scale: 1 - 0.35 * g }] };
  });
  const appActive = useAppActive();
  const reduceMotion = useReducedMotion();
  const palette = useMemo(() => pewPalette(color), [color]);

  // UI-thread state. The body is rebuilt only when the size changes.
  const body = useSharedValue<PewBody | null>(null);
  const moodSV = useSharedValue<PewMood>(mood);
  const paletteSV = useSharedValue<PewPalette>(palette);
  const shownPal = useSharedValue<PewPalette | null>(null);
  // The app-wide blank, never one of its own: see skiaFrame.ts (the crash).
  const picture = useSharedValue<SkPicture>(blankPicture());
  const clock = useSharedValue(0);
  const sinceDraw = useSharedValue(1);
  // -1: not yet in step with `feeds` (it is read on the UI thread, never during render).
  const fed = useSharedValue(-1);

  useEffect(() => {
    moodSV.value = mood;
  }, [mood, moodSV]);
  useEffect(() => {
    paletteSV.value = palette;
  }, [palette, paletteSV]);

  const live = appActive && !paused && !reduceMotion;

  // Not animating: one settled, still frame in its mood (and repaint on change).
  useEffect(() => {
    if (live) return;
    // On the UI thread like every other frame: the engine paints through
    // module-level scratch colours, and once a worklet has captured those the
    // JS-thread copies are frozen, so painting here would warn on every write.
    runOnUI((size: number, m: PewMood, pal: PewPalette, sd: number) => {
      "worklet";
      const still = makePewBody(size, sd < 0 ? undefined : sd);
      settlePew(still, 1.2, m);
      picture.value = recordFrame(still, 1.2, m, pal);
    })(S, mood, palette, seed);
  }, [live, S, mood, palette, picture, seed]);

  // Development only: `EXPO_PUBLIC_DEV_SPIN=1` flicks the toy every 700 ms,
  // through the same dragPew a finger uses, so a capture can show each stage.
  useEffect(() => {
    if (!__DEV__ || process.env.EXPO_PUBLIC_DEV_SPIN !== "1" || !toy) return;
    const t = setInterval(() => {
      runOnUI(() => {
        "worklet";
        const B = body.value;
        if (!B) return;
        for (let i = 0; i < 8; i++) dragPew(B, 30, 0, 0.016);
        releasePew(B);
      })();
    }, 700);
    return () => clearInterval(t);
  }, [toy, body]);
  const holdingSV = useSharedValue(false);
  const gesture = useMemo(() => {
    if (!interactive) return undefined;
    const pan = Gesture.Pan()
      .minDistance(4)
      .hitSlop(reach)
      // The finger is on it from the moment it lands (a tap, a hold or a
      // drag): it dents under the finger, and springs back when it lifts.
      .onBegin((e) => {
        "worklet";
        if (body.value) touchPew(body.value, e.x, e.y, true);
      })
      .onStart(() => {
        "worklet";
        runOnJS(spun)();
      })
      .onChange((e) => {
        "worklet";
        if (!body.value) return;
        touchPew(body.value, e.x, e.y, true);
        dragPew(body.value, e.changeX, e.changeY, 1 / 60);
      })
      .onFinalize((e) => {
        "worklet";
        if (!body.value) return;
        // Cancelled by a hold taking over: the finger is still down.
        if (!holdingSV.value) touchPew(body.value, e.x, e.y, false);
        releasePew(body.value);
      });
    const tap = Gesture.Tap().hitSlop(reach).onEnd((e) => {
      "worklet";
      if (body.value) pokePew(body.value, e.x, e.y);
      runOnJS(tapped)();
    });
    if (!holdable) return Gesture.Exclusive(pan, tap);
    // Pan and hold race (moving past 4pt spins; resting 350ms holds); the tap
    // waits for the hold to fail, so a hold never also taps.
    const hold = Gesture.LongPress()
      .minDuration(350)
      .maxDistance(12)
      .hitSlop(reach)
      .onStart((e) => {
        "worklet";
        // The hold takes over from the pan (which lets go of the finger):
        // keep pressing where the finger is, so the dent stays.
        if (body.value) {
          touchPew(body.value, e.x, e.y, true);
          // The pan's hand-over isn't a lift: no release wobble.
          body.value.jiggle = 0;
        }
        holdingSV.value = true;
        runOnJS(held)();
      })
      .onEnd((_e, success) => {
        "worklet";
        if (success && body.value) pokePew(body.value, S / 2, S * 0.35);
      })
      .onFinalize((e) => {
        "worklet";
        holdingSV.value = false;
        if (body.value) touchPew(body.value, e.x, e.y, false);
        runOnJS(letGo)();
      });
    return Gesture.Race(pan, Gesture.Exclusive(hold, tap));
  }, [interactive, holdable, body, tapped, spun, held, letGo, S, holdingSV, reach]);

  const canvas = (
    <Canvas style={{ width: S, height: S }} pointerEvents="none">
      <Picture picture={picture as SharedValue<SkPicture>} />
    </Canvas>
  );

  return (
    <View
      style={[{ width: S, height: S }, style]}
      accessible={accessibilityLabel !== undefined}
      accessibilityLabel={accessibilityLabel}
      accessibilityElementsHidden={accessibilityLabel === undefined}
      importantForAccessibility={accessibilityLabel === undefined ? "no-hide-descendants" : "yes"}
    >
      {live ? (
        <PewTicker S={S} seed={seed} body={body} mood={moodSV} palette={paletteSV} shown={shownPal} picture={picture} clock={clock} sinceDraw={sinceDraw} hold={holdWhile} feeds={feeds} fed={fed} feedX={feedFrom?.x ?? S * 0.18} feedY={feedFrom?.y ?? S * 0.5} toy={toyTicker} />
      ) : null}
      {/* The canvas never takes touches (pointerEvents none), so a detector
          attached to it saw nothing: a real view holds the gesture instead. */}
      {gesture ? (
        <GestureDetector gesture={gesture}>
          <Animated.View collapsable={false} style={[StyleSheet.absoluteFill, holdable && squishStyle]}>
            {toy ? <Animated.View style={[StyleSheet.absoluteFill, goneStyle]}>{canvas}</Animated.View> : canvas}
          </Animated.View>
        </GestureDetector>
      ) : (
        canvas
      )}
    </View>
  );
}

export const Pew = memo(PewView);
