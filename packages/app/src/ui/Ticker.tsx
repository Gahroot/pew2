/**
 * The chat's LED ticker: one dotted strip under the title naming what the agent
 * is doing. Tool calls never enter the thread; this is where they live. Tap it
 * to drop down this turn's steps. Words are decided in `tickerText.ts`.
 */
import { memo, useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, View, type LayoutChangeEvent } from "react-native";
import Animated, {
  FadeIn,
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import Ionicons from "@expo/vector-icons/Ionicons";
import { theme } from "../theme";
import { Pew } from "../pew/Pew";
import { Led } from "./stage/Led";
import { DotGrid } from "./stage/DotGrid";
import { Pixel } from "./stage/Pixel";
import { haptics } from "./haptics";
import { useReducedMotion } from "./useReducedMotion";
import { useAppActive } from "./useAppActive";
import { receiptLength, receiptParts, receiptText, revealParts, tickerLine, tickerSteps, type TickerInput } from "./tickerText";
import type { TurnReceipt } from "../activity";
import { useStatusRowHeight } from "./useStatusRowHeight";
import { SPRING } from "../motion";

const PEW = 40;
const STRIP = 34;
/** The strip's pill rounding, which the dropped list carries on at the bottom. */
const ROUND = STRIP / 2;
/**
 * How far the list has to drop before the strip's lower corners are fully
 * square. Short, so the seam closes as the list starts to show and only
 * reopens as it finishes folding away.
 */
const SEAM = 12;
/**
 * Shifts the list's dot texture so its rows carry on from the strip's: each
 * grid starts half a step into its own box, and the list's box starts STRIP
 * below the strip's.
 */
const GRID_SHIFT = (theme.stage.fine - (STRIP % theme.stage.fine)) % theme.stage.fine;
/** Marquee pace, points per second. */
const SPEED = 40;

type Props = TickerInput & {
  color?: string;
  /**
   * Told whenever the step list opens or closes (and closed when the ticker
   * goes away), so whatever sits under the strip can step aside: the list
   * hangs over it, and a goal's crew row is drawn later and so on top.
   */
  onOpenChange?: (open: boolean) => void;
};

function Marquee({ text, tone, color }: { text: string; tone: "agent" | "attention" | "dim"; color?: string }) {
  const reduced = useReducedMotion();
  const appActive = useAppActive();
  const [box, setBox] = useState(0);
  const [width, setWidth] = useState(0);
  const x = useSharedValue(0);
  const overflow = box > 0 && width > box;
  useEffect(() => {
    cancelAnimation(x);
    x.value = 0;
    if (!overflow || reduced || !appActive) return;
    const distance = width - box + theme.space(4);
    x.value = withRepeat(
      withSequence(
        withDelay(1200, withTiming(-distance, { duration: (distance / SPEED) * 1000, easing: Easing.linear })),
        withDelay(1200, withTiming(0, { duration: 300 })),
      ),
      -1,
    );
  }, [overflow, reduced, appActive, width, box, x, text]);
  const moving = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  return (
    <View style={styles.marquee} onLayout={(e: LayoutChangeEvent) => setBox(e.nativeEvent.layout.width)}>
      <Animated.View style={[styles.marqueeRun, moving]}>
        <View onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}>
          <Led tone={tone} color={tone === "agent" ? color : undefined}>{text}</Led>
        </View>
      </Animated.View>
    </View>
  );
}

function TickerView({ color, onOpenChange, ...input }: Props) {
  const reduced = useReducedMotion();
  const line = tickerLine(input);
  const steps = useMemo(() => tickerSteps(input.activity), [input.activity]);
  const [open, setOpen] = useState(false);
  const [listHeight, setListHeight] = useState(0);
  const height = useSharedValue(0);
  const turn = useSharedValue(0);
  useEffect(() => {
    const to = open ? listHeight : 0;
    height.value = reduced ? to : withSpring(to, SPRING.settle);
    turn.value = reduced ? (open ? 1 : 0) : withTiming(open ? 1 : 0, { duration: 180 });
  }, [open, listHeight, reduced, height, turn]);
  useEffect(() => {
    onOpenChange?.(open);
  }, [open, onOpenChange]);
  // Unmounting while open (a chat reopening hides the strip) must not leave
  // the crew hidden with no list on screen to explain it.
  useEffect(() => () => onOpenChange?.(false), [onOpenChange]);
  const drop = useAnimatedStyle(() => ({ height: height.value }));
  // The strip's lower corners square off while the list hangs from it, so the
  // two read as one surface unfolding instead of a pill with a panel under it.
  const seam = useAnimatedStyle(() => {
    const r = ROUND * (1 - Math.min(1, height.value / SEAM));
    return { borderBottomLeftRadius: r, borderBottomRightRadius: r };
  });
  const chevron = useAnimatedStyle(() => ({ transform: [{ rotate: `${turn.value * 180}deg` }] }));

  return (
    // Fades in when it mounts (a chat that has just finished reopening), so
    // the strip arrives with the messages rather than snapping in.
    <Animated.View entering={reduced ? undefined : FadeIn.duration(260)}>
      <Animated.View style={[styles.strip, seam]}>
        <Pressable
          onPress={() => {
            haptics.select();
            setOpen((o) => !o);
          }}
          accessibilityRole="button"
          accessibilityLabel={line.text}
          accessibilityState={{ expanded: open }}
          accessibilityHint="Shows this turn's steps"
          style={styles.stripPress}
        >
          <DotGrid fine />
          <Pew size={PEW} mood={line.mood} color={color} style={styles.pew} />
          <Marquee text={line.text} tone={line.tone} color={color} />
          <Animated.View style={chevron}>
            <Ionicons name="chevron-down" size={14} color={theme.color.textDim} />
          </Animated.View>
        </Pressable>
      </Animated.View>
      {/* Hangs over the thread rather than sitting in the measured top area:
          growing that area moved the whole chat down every time the list
          opened. Absolute, so the ticker's own height never changes. */}
      <Animated.View style={[styles.drop, drop]} pointerEvents={open ? "auto" : "none"}>
        <View style={styles.list} onLayout={(e: LayoutChangeEvent) => setListHeight(e.nativeEvent.layout.height)}>
          {/* The strip's texture, carried on. Inside the list rather than the
              animated box, so it is drawn once at the list's size instead of
              re-recorded on every frame of the drop. */}
          <DotGrid fine style={styles.listGrid} />
          {steps.length === 0 ? (
            <Led tone="dim">NO STEPS THIS TURN</Led>
          ) : (
            steps.map((step) => (
              <View key={step.id} style={styles.step}>
                <View style={styles.stepMark}>
                  {step.state === "live" ? (
                    <Pixel kind="live" color={color} />
                  ) : (
                    <Ionicons
                      name={step.state === "failed" ? "close" : "checkmark"}
                      size={12}
                      color={step.state === "failed" ? theme.color.danger : theme.color.textDim}
                    />
                  )}
                </View>
                <Led tone={step.state === "live" ? "agent" : "dim"} color={step.state === "live" ? color : undefined}>
                  {step.verb}
                </Led>
                <View style={styles.stepTarget}>
                  <Led tone="dim">{step.target}</Led>
                </View>
              </View>
            ))
          )}
        </View>
      </Animated.View>
    </Animated.View>
  );
}

export const Ticker = memo(TickerView);

const styles = StyleSheet.create({
  strip: {
    height: STRIP,
    marginHorizontal: theme.gutter,
    marginBottom: theme.space(2),
    borderRadius: ROUND,
    overflow: "hidden",
    backgroundColor: theme.stage.strip,
  },
  stripPress: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(2),
    paddingLeft: theme.space(1),
    paddingRight: theme.space(3),
  },
  // The globe fills ~60% of its box; overhang instead of growing the strip.
  pew: { marginVertical: -(PEW - STRIP) / 2 - 2 },
  marquee: { flex: 1, overflow: "hidden" },
  // Wide enough that the measured child keeps its natural one-line width.
  marqueeRun: { flexDirection: "row", width: 4000 },
  // Directly under the strip, over whatever is beneath it, in the strip's own
  // fill, texture and rounding so it reads as the strip unfolding.
  drop: {
    position: "absolute",
    top: STRIP,
    left: theme.gutter,
    right: theme.gutter,
    zIndex: 10,
    overflow: "hidden",
    backgroundColor: theme.stage.strip,
    borderBottomLeftRadius: ROUND,
    borderBottomRightRadius: ROUND,
    shadowColor: "#000",
    shadowOpacity: 0.5,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 10 },
  },
  list: { position: "absolute", left: 0, right: 0, top: 0, gap: theme.space(2), paddingHorizontal: theme.space(3), paddingTop: theme.space(3), paddingBottom: theme.space(3) },
  listGrid: { top: GRID_SHIFT },
  step: { flexDirection: "row", alignItems: "center", gap: theme.space(2) },
  stepMark: { width: 16, alignItems: "center" },
  stepTarget: { flex: 1 },
  // On the thread's rail like the replies above it: the list's footer spans
  // the full width, so the row carries the gutter itself (the receipt it
  // replaced did too; without it the LED line ran off the left edge).
  receipt: { marginTop: theme.space(5), paddingHorizontal: theme.gutter, flexDirection: "row", alignItems: "center", gap: theme.space(2), overflow: "hidden" },
});

/** Per character of the receipt's type-on. */
const TYPE_MS = 28;

/** The finished turn under the thread, typed on left to right the first time. */
function LedReceiptView({ receipt }: { receipt: TurnReceipt }) {
  const reduced = useReducedMotion();
  const height = useStatusRowHeight();
  const parts = useMemo(() => receiptParts(receipt), [receipt]);
  const total = receiptLength(parts);
  const [shown, setShown] = useState(reduced ? total : 0);
  useEffect(() => {
    if (reduced) {
      setShown(total);
      return;
    }
    setShown(0);
    const timer = setInterval(() => {
      setShown((n) => {
        if (n + 1 >= total) clearInterval(timer);
        return Math.min(total, n + 1);
      });
    }, TYPE_MS);
    return () => clearInterval(timer);
  }, [parts, total, reduced]);
  return (
    <View style={[styles.receipt, { height }]} accessible accessibilityLabel={receiptText(receipt)}>
      {revealParts(parts, shown).map((part, i) => (
        <Led key={i} tone={part.tone}>{part.text}</Led>
      ))}
    </View>
  );
}

export const LedReceipt = memo(LedReceiptView);
