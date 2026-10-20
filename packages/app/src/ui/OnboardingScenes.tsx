/**
 * The little shows behind each onboarding step, so every page shows what it
 * is for: alerts popping out of Pew, the computer typing `pew2 setup` and
 * showing a code that Pew reads, Pew and you taking turns to talk. Timing is
 * `onboardingScenes.ts` (pure, tested); this only draws it with the app's own
 * pieces (dashed cards, Led, the code look, ListeningWave).
 */
import { useEffect, useState } from "react";
import { Image, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { BlurView } from "expo-blur";
import { EASE } from "../motion";
import Animated, { Easing, cancelAnimation, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from "react-native-reanimated";
import { theme } from "../theme";
import { DOT_CODE, INSTALL_TYPE, PAIR_TYPE, SETUP_REPLY, alertsAt, installAt } from "../onboardingScenes";
import { Dissolve } from "./motion/Dissolve";
import { codeBlockStyles } from "./codeBlock";
import { ListeningWave } from "./ListeningWave";

/** Milliseconds since `key` last changed, re-rendered every `every` ms while `on`. */
export function useSceneClock(key: string, on: boolean, every = 100): number {
  const [started, setStarted] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t0 = Date.now();
    setStarted(t0);
    setNow(t0);
    if (!on) return;
    const timer = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(timer);
  }, [key, on, every]);
  return Math.max(0, now - started);
}

// ── Notifications ───────────────────────────────────────────────────────

const BANNER_H = 74;
/** How far the banner behind peeks out under the front one. */
const PEEK = 12;

/**
 * Notification banners arriving at the top of the stage, the way iOS shows
 * them: frosted card, the app icon, title and "now", the message under it.
 * Each new one slides down in front and the last pushes back into a stack.
 */
export function AlertsScene({ ms }: { ms: number }) {
  const { width } = useWindowDimensions();
  const shown = alertsAt(ms);
  const bannerW = Math.min(420, width - theme.gutter * 2);
  return (
    <View style={[styles.alerts, { height: BANNER_H + PEEK * 2 }]} pointerEvents="none">
      {/* Oldest first, so the newest draws on top. */}
      {[...shown].reverse().map((entry) => {
        const depth = entry.index === shown[0]!.index ? 0 : entry.index === shown[1]?.index ? 1 : 2;
        return <Banner key={entry.index} title={entry.alert.title} body={entry.alert.body} depth={depth} width={bannerW} />;
      })}
    </View>
  );
}

function Banner({ title, body, depth, width }: { title: string; body: string; depth: number; width: number }) {
  const [a, b, c, d] = EASE.out;
  const ease = Easing.bezier(a, b, c, d);
  // 0 → 1 as it arrives; `place` follows its depth in the stack.
  const arrive = useSharedValue(0);
  const place = useSharedValue(depth);
  useEffect(() => {
    arrive.value = withTiming(1, { duration: ARRIVE_MS, easing: ease });
    // Mounted once per banner: the arrival plays once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    place.value = withTiming(depth, { duration: ARRIVE_MS, easing: ease });
  }, [depth, place, ease]);
  const style = useAnimatedStyle(() => {
    const p = place.value;
    return {
      opacity: arrive.value * (p <= 1 ? 1 - p * 0.35 : Math.max(0, 0.65 - (p - 1) * 0.65)),
      transform: [
        { translateY: (1 - arrive.value) * -BANNER_H * 0.7 + p * PEEK },
        { scale: (0.96 + arrive.value * 0.04) * (1 - p * 0.07) },
      ],
    };
  });
  return (
    <Animated.View style={[styles.banner, { width, zIndex: 3 - depth }, style]}>
      <BlurView style={StyleSheet.absoluteFill} intensity={40} tint="dark" />
      <View style={styles.bannerTint} />
      <Image source={APP_ICON} style={styles.appIcon} />
      <View style={styles.bannerText}>
        <View style={styles.bannerHead}>
          <Text style={styles.bannerTitle} numberOfLines={1}>
            {title}
          </Text>
          <Text style={styles.bannerTime}>now</Text>
        </View>
        <Text style={styles.bannerBody} numberOfLines={2}>
          {body}
        </Text>
      </View>
    </Animated.View>
  );
}

const ARRIVE_MS = 460;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const APP_ICON = require("../../assets/icon.png");

// ── Install ─────────────────────────────────────────────────────────────

const CODE = codeBlockStyles(theme.font.body, theme.line.body);
const QR_DOT = 5;

/**
 * A terminal window on the computer, wide enough to read: `pew2 setup` types
 * out and answers, then `pew2 pair` shows the pairing code, and a packet runs
 * down to Pew as he reads it (the real order of the commands).
 */
export function InstallScene({ ms, color }: { ms: number; color: string }) {
  const { width } = useWindowDimensions();
  const frame = installAt(ms);
  const cursorOn = Math.floor(ms / 450) % 2 === 0;
  const termW = Math.min(360, width - theme.gutter * 2);
  return (
    <View style={styles.install} pointerEvents="none">
      <View style={[styles.terminal, { width: termW }]}>
        <View style={styles.termBar}>
          {TERM_DOTS.map((dot) => (
            <View key={dot} style={[styles.termDot, { backgroundColor: dot }]} />
          ))}
          <Text style={styles.termTitle}>Terminal</Text>
        </View>
        <View style={styles.termBody}>
          <View style={styles.termLines}>
            <Text style={[CODE.text, styles.termLine]} numberOfLines={1}>
              <Text style={{ color }}>$ </Text>
              {INSTALL_TYPE.slice(0, frame.typed)}
              {!frame.setupDone ? <Text style={{ color: cursorOn ? color : "transparent" }}>▍</Text> : null}
            </Text>
            {frame.setupDone ? (
              <Dissolve kind="row" dissolveKey="setup">
                <Text style={[CODE.text, styles.termLine, { color: theme.color.success }]} numberOfLines={1}>
                  {SETUP_REPLY}
                </Text>
              </Dissolve>
            ) : null}
            {frame.setupDone ? (
              <Text style={[CODE.text, styles.termLine]} numberOfLines={1}>
                <Text style={{ color }}>$ </Text>
                {PAIR_TYPE.slice(0, frame.pairTyped)}
                {!frame.qr ? <Text style={{ color: cursorOn ? color : "transparent" }}>▍</Text> : null}
              </Text>
            ) : null}
          </View>
          <View style={styles.qrHold}>
            {frame.qr ? (
              <Dissolve kind="in" dissolveKey="qr">
                <View style={styles.qr}>
                  {DOT_CODE.map((row, r) => (
                    <View key={r} style={styles.qrRow}>
                      {row.map((on, c) => (
                        <View key={c} style={[styles.qrDot, { backgroundColor: on ? theme.color.text : "transparent" }]} />
                      ))}
                    </View>
                  ))}
                </View>
              </Dissolve>
            ) : null}
          </View>
        </View>
      </View>
      <Wire color={color} live={frame.linking} />
    </View>
  );
}

/** A window's three dots (macOS's close/minimise/zoom), dimmed into the theme. */
const TERM_DOTS = ["#ff5f57", "#febc2e", "#28c840"];

const WIRE = 48;

/** A short dotted wire from the computer down to Pew; a packet runs it while live. */
function Wire({ color, live }: { color: string; live: boolean }) {
  const t = useSharedValue(0);
  useEffect(() => {
    if (!live) {
      cancelAnimation(t);
      t.value = 0;
      return;
    }
    t.value = withRepeat(withTiming(1, { duration: 700, easing: Easing.inOut(Easing.quad) }), -1);
    return () => cancelAnimation(t);
  }, [live, t]);
  const packet = useAnimatedStyle(() => ({
    opacity: live ? Math.sin(t.value * Math.PI) : 0,
    transform: [{ translateY: t.value * (WIRE - 6) }],
  }));
  return (
    <View style={styles.wire}>
      <View style={styles.wireLine} />
      <Animated.View style={[styles.packet, { backgroundColor: color, shadowColor: color }, packet]} />
    </View>
  );
}

// ── Voice ───────────────────────────────────────────────────────────────

/** Under Pew: the call's own listening wave, lit while it's "your" turn to talk. */
export function VoiceScene({ userSpeaking, color }: { userSpeaking: boolean; color: string }) {
  return (
    <View style={styles.voice} pointerEvents="none">
      <ListeningWave speaking={userSpeaking} color={color} off={theme.stage.dash} />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  // Notifications: an iOS banner stack at the top of the stage.
  alerts: { position: "absolute", top: 0, left: 0, right: 0, alignItems: "center" },
  banner: {
    position: "absolute",
    top: 0,
    height: BANNER_H,
    borderRadius: 22,
    overflow: "hidden",
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(3),
    paddingHorizontal: theme.space(3.5),
  },
  // The frosted card's own tint over the blur (iOS's dark notification material).
  bannerTint: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(52, 52, 56, 0.78)" },
  // pew2's real icon (dark, like iOS shows it), with iOS's hairline rim so it
  // reads against the dark card.
  appIcon: { width: 40, height: 40, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth * 2, borderColor: "rgba(255,255,255,0.22)" },
  bannerText: { flex: 1, minWidth: 0, gap: 1 },
  bannerHead: { flexDirection: "row", alignItems: "baseline", gap: theme.space(2) },
  bannerTitle: { flex: 1, minWidth: 0, color: theme.color.text, fontSize: theme.font.body, fontWeight: "600" },
  bannerTime: { color: theme.color.textDim, fontSize: theme.font.small },
  bannerBody: { color: theme.color.text, fontSize: theme.font.body, lineHeight: 19 },
  // Install: the computer at the top of the stage, the wire down to Pew.
  install: { position: "absolute", top: 0, left: 0, right: 0, alignItems: "center" },
  terminal: { ...CODE.container, overflow: "hidden" },
  termBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    height: 26,
    paddingHorizontal: theme.space(3),
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.color.border,
  },
  termDot: { width: 9, height: 9, borderRadius: 4.5, opacity: 0.8 },
  termTitle: { flex: 1, textAlign: "center", marginRight: 27 + 12, color: theme.color.textDim, fontSize: theme.font.tiny },
  termBody: { flexDirection: "row", alignItems: "center", gap: theme.space(3), ...CODE.padding, minHeight: 84 },
  termLines: { flex: 1, minWidth: 0, gap: 2 },
  termLine: { flexShrink: 1 },
  termDim: { color: theme.color.textDim },
  qrHold: { width: 7 * 5 + 6 * 2, height: 7 * 5 + 6 * 2, alignItems: "center", justifyContent: "center" },
  qr: { gap: 2 },
  qrRow: { flexDirection: "row", gap: 2 },
  qrDot: { width: QR_DOT, height: QR_DOT, borderRadius: QR_DOT / 2 },
  wire: { width: 6, height: WIRE, alignItems: "center", marginTop: theme.space(1) },
  wireLine: { position: "absolute", top: 0, bottom: 0, width: 0, borderLeftWidth: 2, borderStyle: "dotted", borderColor: theme.stage.dash },
  packet: { width: 6, height: 6, borderRadius: 3, shadowOpacity: 1, shadowRadius: theme.stage.glow, shadowOffset: { width: 0, height: 0 } },
  // Voice: the wave under Pew.
  voice: { position: "absolute", bottom: theme.space(4), left: 0, right: 0, alignItems: "center" },
});
