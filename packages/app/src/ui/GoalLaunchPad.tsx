/**
 * The new-goal screen's launch step: hold Ken until the dot ring fills, or a
 * plain button with Reduce Motion or a screen reader. Split out of
 * `NewGoalSheet.tsx`, which owns the launch itself (`onLaunch`, the blast and
 * the reveal); this file only turns a hold into those callbacks.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Pressable, StyleSheet, View, useWindowDimensions } from "react-native";
import Reanimated, {
  cancelAnimation,
  Easing,
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
  useReducedMotion,
  withTiming,
} from "react-native-reanimated";
import { theme } from "../theme";
import { haptics } from "./haptics";
import { Led } from "./stage/Led";
import { StageButton } from "./stage/StageButton";
import { Pew } from "../pew/Pew";
import type { PewMood } from "../pew/engine";
import { KEN_COLOR } from "../pew/palette";
import { EASE_OUT } from "./motion/ease";
import { DUR } from "../motion";
import type { LaunchFxValues } from "./LaunchFx";
import { sounds } from "./sounds";
import { fxKenScale, fxShake, RING_DOTS, RING_SCALE, type FxScene } from "../launchFx";

/** True when the user wants motion off or uses a screen reader: offer a plain button instead of hold. */
export function usePlainLaunch(): boolean {
  const reduce = useReducedMotion();
  const [reader, setReader] = useState(false);
  useEffect(() => {
    const sub = AccessibilityInfo.addEventListener("screenReaderChanged", setReader);
    void AccessibilityInfo.isScreenReaderEnabled().then(setReader);
    return () => sub.remove();
  }, []);
  return reduce || reader;
}

/** How long into the blast the canvas has certainly painted its cover. */
export const COVER_LAG_S = 0.07;
/** A full hold, start to blast. Long enough to feel the build. */
const HOLD_MS = 1600;
const KEN_SIZE = 180;

/**
 * The launch step's hold area: everything under the title. Hold anywhere and
 * Ken charges (the ring of dots and the streaming particles are LaunchFx's,
 * drawn round where he sits); let go early and it drains; hold to the end and
 * he blows. With Reduce Motion or a screen reader it is a plain button.
 */
export function LaunchPad({ ready, pending, plain, fx, onFire, onLaunch, onScene, color = KEN_COLOR, idleMood = "happy", labels, plainLabel = "Launch goal", a11yLabel = "Hold to launch goal", size = KEN_SIZE, captionBelow = false }: {
  ready: boolean;
  pending: boolean;
  plain: boolean;
  fx: LaunchFxValues;
  onFire: () => void;
  onLaunch: () => void;
  onScene: (scene: FxScene) => void;
  /** Pew's colour (the goal launch is Ken's purple). */
  color?: string;
  idleMood?: PewMood;
  /** The caption: waiting / holding / pending / not ready. */
  labels?: { idle: string; holding: string; pending: string; notReady: string };
  plainLabel?: string;
  a11yLabel?: string;
  /** Pew's size (the goal launch's 180 by default). */
  size?: number;
  /** The caption pinned to the pad's bottom edge, so Pew sits dead centre. */
  captionBelow?: boolean;
}) {
  const radius = size * 0.3;
  const ringBox = Math.ceil(radius * RING_SCALE * 2 + 48);
  const words = labels ?? { idle: "Hold anywhere here", holding: "Keep holding", pending: "Launching", notReady: "Name and goal first" };
  const [holding, setHolding] = useState(false);
  const ken = useRef<View>(null);
  // Loaded as the step opens, so the first hold is not a beat late.
  useEffect(() => sounds.preload(["charge", "drain", "burst", "reveal"]), []);
  const { width, height } = useWindowDimensions();
  const measure = useCallback(() => {
    ken.current?.measureInWindow((x, y, w, h) => {
      if (w > 0) onScene({ w: width, h: height, cx: x + w / 2, cy: y + h / 2, kenR: radius });
    });
  }, [width, height, onScene, radius]);
  useEffect(() => {
    if (!pending) setHolding(false);
  }, [pending]);

  // Haptics climb with the charge: sparse soft taps, then every other dot,
  // then a rigid tick on every dot in the last stretch.
  const felt = useCallback((n: number) => {
    if (n >= RING_DOTS) return;
    // Silent: the charge sound already ticks on every dot.
    if (n >= 17) haptics.detent(null);
    else if (n >= 9 ? n % 2 === 0 : n % 4 === 0) haptics.poke(null);
  }, []);
  useAnimatedReaction(
    () => Math.floor(fx.charge.value * RING_DOTS),
    (now, prev) => {
      if (prev !== null && now > prev && fx.burst.value < 0) runOnJS(felt)(now);
    },
    [felt],
  );

  const press = () => {
    if (plain || pending || fx.burst.value >= 0) return;
    if (!ready) {
      haptics.warned();
      return;
    }
    measure();
    setHolding(true);
    haptics.tap(plain ? undefined : null);
    if (!plain) sounds.charge(fx.charge.value, HOLD_MS);
    const { charge, burst } = fx;
    charge.value = withTiming(1, { duration: HOLD_MS * (1 - charge.value), easing: Easing.linear }, (done) => {
      if (!done) return;
      // The blast starts here, on the UI thread, on the very frame the charge
      // completes; React hears about it after.
      burst.value = 0;
      runOnJS(onFire)();
    });
  };
  const release = () => {
    if (plain || fx.burst.value >= 0) return;
    setHolding(false);
    if (fx.charge.value > 0.02) {
      sounds.stop("charge", 60);
      sounds.play("drain");
    }
    cancelAnimation(fx.charge);
    fx.charge.value = withTiming(0, { duration: DUR.dissolve, easing: EASE_OUT });
  };

  // `EXPO_PUBLIC_DEV_LAUNCH_DEMO=1` (development only): holds Ken by itself
  // a moment after the step opens, for recording the launch on a simulator,
  // which cannot hold a finger down.
  useEffect(() => {
    if (!__DEV__ || process.env.EXPO_PUBLIC_DEV_LAUNCH_DEMO !== "1" || !ready || !onScene) return;
    const t = setTimeout(press, 2500);
    return () => clearTimeout(t);
    // Dev-only demo, armed once when the step is ready: `press` is recreated
    // every render and would reset the 2.5s timer on each one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  const kenStyle = useAnimatedStyle(() => {
    const c = fx.charge.value;
    const t = fx.clock.value;
    return {
      opacity: fx.burst.value >= COVER_LAG_S ? 0 : 1,
      transform: [{ translateX: fxShake(t, c) }, { translateY: fxShake(t + 0.37, c) * 0.6 }, { scale: fxKenScale(c) }],
    };
  });

  const caption = pending ? words.pending : ready ? (holding ? words.holding : words.idle) : words.notReady;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={a11yLabel}
      accessibilityState={{ disabled: !ready }}
      onPressIn={press}
      onPressOut={release}
      style={[styles.pad, !ready && !pending && styles.padOff]}
    >
      <View style={[styles.ring, { width: ringBox, height: ringBox }]}>
        <Reanimated.View style={kenStyle}>
          <View ref={ken} collapsable={false} onLayout={measure}>
            <Pew size={size} mood={holding || pending ? "working" : idleMood} color={color} accessibilityLabel="Pew" />
          </View>
        </Reanimated.View>
      </View>
      {/* Under the ring, without moving Pew off centre: the ring box keeps its
          place and the caption hangs just below it. */}
      <Led
        tone={ready ? "agent" : "dim"}
        color={ready ? color : undefined}
        numberOfLines={1}
        style={captionBelow ? [styles.captionBelow, { top: "50%", marginTop: ringBox / 2 + theme.space(2) }] : undefined}
      >
        {caption}
      </Led>
      {plain && (
        <StageButton color={color} disabled={!ready} feel="sent" label={pending ? `${words.pending}…` : plainLabel} onPress={onLaunch} />
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // The hold area: everything under the title, so a thumb can't miss it.
  pad: { flex: 1, alignSelf: "stretch", alignItems: "center", justifyContent: "center", gap: theme.space(4) },
  padOff: { opacity: 0.45 },
  ring: { alignItems: "center", justifyContent: "center" },
  captionBelow: { position: "absolute" },
});
