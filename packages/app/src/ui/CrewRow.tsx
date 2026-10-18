/**
 * A GG Goals crew: one scrollable row of worker chips (small Pew + LED name).
 * Tapping a chip selects it and shows a one-line tip: role · activity · time.
 */
import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { theme } from "../theme";
import { withAlpha } from "../motion";
import { Pew } from "../pew/Pew";
import { roleColor, workerMood } from "../pew/palette";
import { elapsedLabel, workerElapsed, type GoalWorker } from "../ggState";
import { Led } from "./stage/Led";
import { PressScale } from "./stage/PressScale";
import { dashedOutline } from "./stage/DashedRule";
import Reanimated, {
  FadeIn,
  FadeOut,
  LinearTransition,
  ZoomIn,
  ZoomOut,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useReducedMotion } from "./useReducedMotion";
import { EASE_OUT } from "./motion/ease";
import { SPRING } from "../motion";

export interface CrewRowProps {
  workers: readonly GoalWorker[];
  onPressWorker?: (worker: GoalWorker) => void;
  /**
   * Fade out while something hangs over the row (the ticker's step list).
   * Only opacity moves: the row keeps its height, because the thread starts
   * below the measured nav and collapsing it would shove the chat up and back.
   */
  hidden?: boolean;
}

/** Fast enough to be out of the way before the list has finished unfolding. */
const HIDE_MS = 160;
const SHOW_MS = 220;

const CHIP_HEIGHT = 32;
/** The chip's height is fixed, so its name may grow only this far with Dynamic Type. */
const CHIP_FONT_SCALE = 1.4;

const isLive = (w: GoalWorker) => w.state === "starting" || w.state === "running";

/**
 * Only the workers doing something now. A finished, failed or closed worker
 * leaves the row (with an exit animation) instead of lingering on screen for
 * the rest of the goal; the row itself is gone when nobody is working.
 */
export function liveWorkers(workers: readonly GoalWorker[]): GoalWorker[] {
  return workers.filter(isLive);
}

export function CrewRow({ workers: all, onPressWorker, hidden = false }: CrewRowProps) {
  const workers = liveWorkers(all);
  const [selected, setSelected] = useState<string | undefined>();
  const [now, setNow] = useState(() => Date.now());
  const reduce = useReducedMotion();
  const picked = workers.find((w) => w.id === selected);
  const shown = useSharedValue(hidden ? 0 : 1);
  useEffect(() => {
    const to = hidden ? 0 : 1;
    shown.value = reduce ? to : withTiming(to, { duration: hidden ? HIDE_MS : SHOW_MS, easing: EASE_OUT });
  }, [hidden, reduce, shown]);
  const fade = useAnimatedStyle(() => ({ opacity: shown.value }));

  // Tick the tip's clock only while it shows a live worker.
  useEffect(() => {
    if (!picked || !isLive(picked)) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [picked]);

  const tip = picked
    ? [picked.agent ?? "worker", picked.activity ?? picked.error ?? picked.state, elapsedLabel(workerElapsed(picked, now))]
        .filter(Boolean)
        .join(" · ")
    : undefined;

  if (workers.length === 0) return null;
  return (
    <Reanimated.View
      // The whole row arrives with the first worker and leaves with the last.
      entering={reduce ? undefined : FadeIn.duration(220)}
      exiting={reduce ? undefined : FadeOut.duration(200)}
    >
      {/* Its own view: the row's entering/exiting animate opacity too, and one
          view driven by both would fight. pointerEvents follows the fade, so a
          tap meant for the list over a hidden chip reaches the list. */}
      <Reanimated.View
        style={fade}
        pointerEvents={hidden ? "none" : "auto"}
        accessibilityElementsHidden={hidden}
        importantForAccessibility={hidden ? "no-hide-descendants" : "auto"}
      >
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
        {workers.map((w, i) => {
          const color = roleColor(w.agent ?? w.name);
          const live = isLive(w);
          const on = w.id === selected;
          return (
            <Reanimated.View
              key={w.id}
              // Arrives with a little spring, leaves by shrinking away, and the
              // chips beside it slide over to close the gap.
              entering={reduce ? undefined : ZoomIn.duration(SPRING.arrive.duration).easing(EASE_OUT).delay(Math.min(i, 4) * 40)}
              exiting={reduce ? undefined : ZoomOut.duration(220)}
              layout={reduce ? undefined : LinearTransition.duration(SPRING.settle.duration).easing(EASE_OUT)}
            >
              <PressScale
                feel="select"
                // The chip is a face and an LED name; without these VoiceOver
                // reads the raw name with no hint that tapping shows details.
                accessibilityLabel={[w.name, w.agent, live ? w.activity ?? w.state : w.state].filter(Boolean).join(", ")}
                accessibilityHint={on ? "Hides details" : "Shows what this worker is doing"}
                accessibilityState={{ selected: on }}
                // The chip is 32pt tall; the slop takes it to the 44pt target.
                hitSlop={(theme.size.touch - CHIP_HEIGHT) / 2}
                onPress={() => {
                  setNow(Date.now());
                  setSelected(on ? undefined : w.id);
                  onPressWorker?.(w);
                }}
                style={[
                  styles.chip,
                  live || on ? { borderStyle: "solid", borderColor: color } : null,
                  on ? { backgroundColor: withAlpha(color, 0.1) } : null,
                ]}
              >
                <View style={styles.pew}>
                  <Pew size={28} mood={workerMood(w.state)} color={color} paused={!live} />
                </View>
                <Led color={color} unlit={!live} style={styles.name} maxFontSizeMultiplier={CHIP_FONT_SCALE}>
                  {w.name}
                </Led>
              </PressScale>
            </Reanimated.View>
          );
        })}
      </ScrollView>
      {tip && picked && (
        <Reanimated.View entering={reduce ? undefined : FadeIn.duration(180)} exiting={reduce ? undefined : FadeOut.duration(140)}>
          <Text
            style={styles.tip}
            numberOfLines={1}
            // Spoken in sentence case (all caps can be spelled out letter by
            // letter), and announced politely when a chip is picked.
            accessibilityLabel={tip}
            accessibilityLiveRegion="polite"
          >
            {tip.toUpperCase()}
          </Text>
        </Reanimated.View>
      )}
      </Reanimated.View>
    </Reanimated.View>
  );
}

const styles = StyleSheet.create({
  row: { paddingHorizontal: theme.gutter, gap: theme.space(2) },
  chip: {
    ...dashedOutline,
    flexDirection: "row",
    alignItems: "center",
    height: CHIP_HEIGHT,
    borderRadius: CHIP_HEIGHT / 2,
    paddingLeft: theme.space(1),
    paddingRight: theme.space(3),
    gap: theme.space(1),
  },
  pew: { width: 24, height: 24, alignItems: "center", justifyContent: "center", overflow: "visible" },
  name: { maxWidth: 140 },
  tip: { color: theme.color.textDim, fontSize: 12, marginTop: theme.space(2), paddingHorizontal: theme.gutter },
});
