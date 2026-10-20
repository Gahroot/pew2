/**
 * A ScrollView with the Stage scroll rail instead of the system indicator.
 *
 * The system bar is drawn over the content's right edge, so in a sheet it ran
 * across option borders and row text. This rail lives in a lane of its own:
 *
 *   outside  (default) in the padding to the right of the content, the sheet's
 *            own 20pt margin, so the content keeps its full width and rail
 *   inside   for a clipped box (a picker panel): the content gives up a lane
 *            at its right edge and the rail sits in it
 *
 * Glow room: a scroll view clips to its own bounds, and those were the
 * content's exact edges, so a lit button's glow was cut off flat at both
 * sides. An `outside` scroll view reaches `GLOW_BLEED` into the sheet's margin
 * on each side and pads its content back by the same amount: the layout is
 * unchanged, the glow has room. (`inside` sits in a clipped box with no
 * margin to reach into, so it doesn't.)
 *
 * The rail is a column of faint dots, the canvas's dot grid turned on its
 * side, with a short lit bar for the thumb. It only appears when the content
 * overflows; the thumb takes the agent's colour while you scroll and settles
 * back to dim after.
 */
import { useCallback, useRef, useState, type ReactNode } from "react";
import { StyleSheet, View, type LayoutChangeEvent, type ScrollViewProps, type StyleProp, type ViewStyle } from "react-native";
import Reanimated, {
  interpolateColor,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from "react-native-reanimated";
import { DUR } from "../../motion";
import { railDots, railThumb } from "../../scrollRail";
import { theme } from "../../theme";
import { EASE_OUT } from "../motion/ease";
import { useReducedMotion } from "../useReducedMotion";
import { useAgentColor } from "./agentColor";

const RAIL_WIDTH = 3;
const DOT = 2;
const DOT_PITCH = 6;
/** Lane the content gives up for an `inside` rail. */
const INSIDE_LANE = 12;
/** How long the thumb stays lit after the scroll stops. */
const LINGER_MS = 700;
/** Room each side for a lit control's glow (StageButton's is 10pt). Under a sheet's 20pt margin. */
export const GLOW_BLEED = 12;

type Padding = { paddingLeft?: unknown; paddingRight?: unknown; paddingHorizontal?: unknown; padding?: unknown };
const num = (value: unknown) => (typeof value === "number" ? value : undefined);
/** The content's own side padding plus `extra`, so the bleed never eats into it. */
function sidePadding(style: StyleProp<ViewStyle>, extra: number, laneRight: number) {
  const flat = (StyleSheet.flatten(style) ?? {}) as Padding;
  const horizontal = num(flat.paddingHorizontal) ?? num(flat.padding) ?? 0;
  return {
    paddingLeft: (num(flat.paddingLeft) ?? horizontal) + extra,
    paddingRight: (num(flat.paddingRight) ?? horizontal) + extra + laneRight,
  };
}

export interface StageScrollProps extends Omit<ScrollViewProps, "showsVerticalScrollIndicator" | "onScroll"> {
  children?: ReactNode;
  /** Where the rail goes; see the module comment. */
  rail?: "outside" | "inside";
  /**
   * Gap between the content's right edge and the rail's centre, for an
   * `outside` rail. Defaults to the middle of a sheet's 20pt padding.
   */
  railGap?: number;
}

export function StageScroll({ children, style, contentContainerStyle, rail = "outside", railGap = 10, onLayout, onContentSizeChange, ...rest }: StageScrollProps) {
  const reduce = useReducedMotion();
  const agent = useAgentColor();
  const y = useSharedValue(0);
  const view = useSharedValue(0);
  const content = useSharedValue(0);
  const lit = useSharedValue(0);
  // React state only for what changes the tree: whether there is a rail and
  // how many dots its track has. Scroll position never re-renders.
  const [track, setTrack] = useState({ height: 0, overflows: false });

  // The JS side keeps its own copy of both sizes: a shared value written from
  // JS reads back stale on the same tick, and the rail decided there was
  // nothing to scroll.
  const sizes = useRef({ view: 0, content: 0 });
  const measure = useCallback(() => {
    const { view: v, content: c } = sizes.current;
    const next = { height: v, overflows: railThumb(v, c, 0).overflows };
    setTrack((now) => (now.height === next.height && now.overflows === next.overflows ? now : next));
  }, []);

  const light = () => {
    "worklet";
    lit.value = withTiming(1, { duration: reduce ? 0 : DUR.enter });
  };
  const dim = () => {
    "worklet";
    lit.value = withDelay(LINGER_MS, withTiming(0, { duration: reduce ? 0 : DUR.dissolve, easing: EASE_OUT }));
  };
  const onScroll = useAnimatedScrollHandler({
    onScroll: (e) => {
      y.value = e.contentOffset.y;
    },
    onBeginDrag: () => light(),
    onEndDrag: () => dim(),
    onMomentumBegin: () => light(),
    onMomentumEnd: () => dim(),
  });

  const thumb = useAnimatedStyle(() => {
    const t = railThumb(view.value, content.value, y.value, 24);
    return {
      height: t.length,
      transform: [{ translateY: t.offset }],
      backgroundColor: interpolateColor(lit.value, [0, 1], [theme.color.textFaint, agent]),
      opacity: 0.55 + 0.45 * lit.value,
    };
  });

  const inside = rail === "inside";
  const dots = track.overflows ? railDots(track.height, DOT_PITCH) : 0;
  const bleed = inside ? 0 : GLOW_BLEED;
  const lane = inside && track.overflows ? INSIDE_LANE : 0;

  return (
    // The size limit (maxHeight, height) stays on the scroll view itself: on a
    // wrapper the scroll view grew to its whole content and nothing scrolled.
    <View style={styles.host}>
      <Reanimated.ScrollView
        {...rest}
        style={[style, bleed > 0 && styles.bleed]}
        showsVerticalScrollIndicator={false}
        scrollEventThrottle={16}
        onScroll={onScroll}
        contentContainerStyle={[contentContainerStyle, sidePadding(contentContainerStyle, bleed, lane)]}
        onLayout={(e: LayoutChangeEvent) => {
          sizes.current.view = e.nativeEvent.layout.height;
          view.value = e.nativeEvent.layout.height;
          measure();
          onLayout?.(e);
        }}
        onContentSizeChange={(w: number, h: number) => {
          sizes.current.content = h;
          content.value = h;
          measure();
          onContentSizeChange?.(w, h);
        }}
      >
        {children}
      </Reanimated.ScrollView>
      {track.overflows && (
        <View
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={[styles.rail, inside ? styles.railInside : ({ right: -railGap - RAIL_WIDTH / 2 } satisfies StyleProp<ViewStyle>)]}
        >
          <View style={styles.track}>
            {Array.from({ length: dots }, (_, i) => (
              <View key={i} style={styles.dot} />
            ))}
          </View>
          <Reanimated.View style={[styles.thumb, thumb]} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  host: { flexShrink: 1 },
  bleed: { marginHorizontal: -GLOW_BLEED },
  rail: { position: "absolute", top: 0, bottom: 0, width: RAIL_WIDTH },
  railInside: { right: (INSIDE_LANE - RAIL_WIDTH) / 2 },
  track: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "space-between", paddingVertical: 1 },
  dot: { width: DOT, height: DOT, borderRadius: DOT / 2, backgroundColor: theme.stage.dash },
  thumb: { position: "absolute", top: 0, left: 0, width: RAIL_WIDTH, borderRadius: RAIL_WIDTH / 2 },
});
