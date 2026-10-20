/**
 * Dev-only harness for the call screen ("Mission control"): the scripted
 * ~50 s demo call from `voiceDemo.ts` drives the real screen, with no OpenAI,
 * daemon or pairing. A plain full-screen view, not the Modal or a Sheet, so it
 * also renders under `expo start --web`. Tap the strip at the top to restart;
 * `EXPO_PUBLIC_CALL_AT=<seconds>` starts (and holds) at one moment, e.g. 14.2
 * (Pew typing), 19.2 (all working), 33.4 (Pew reading), 40.6 (fifth session
 * folds one), 50 (ended). `EXPO_PUBLIC_CALL_WAITED=<minutes>` makes what is
 * waiting on the user that much older, so a lane reads "Needs you · 12m".
 *
 *   EXPO_PUBLIC_HARNESS=CallScreen bun run harness
 */
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import * as SplashScreen from "expo-splash-screen";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { useFonts } from "expo-font";
import { BitcountPropSingle_400Regular } from "@expo-google-fonts/bitcount-prop-single/400Regular";
import { BitcountPropSingle_600SemiBold } from "@expo-google-fonts/bitcount-prop-single/600SemiBold";
import { theme } from "../theme";
import { DEMO_COLORS, DEMO_DURATION_S, demoAt } from "../voiceDemo";
import { MissionControl } from "./CallScreen";

const PROVIDERS = Object.entries(DEMO_COLORS).map(([id, color]) => ({ id, color }));
const HOLD_AT = Number(process.env.EXPO_PUBLIC_CALL_AT);
const WAITED_MS = (Number(process.env.EXPO_PUBLIC_CALL_WAITED) || 0) * 60_000;

export default function CallScreenHarness() {
  useFonts({ BitcountPropSingle_400Regular, BitcountPropSingle_600SemiBold });
  const [startedAt, setStartedAt] = useState(() => Date.now());
  const [wall, setWall] = useState(() => Date.now());
  useEffect(() => {
    SplashScreen.hideAsync().catch(() => undefined);
    if (Number.isFinite(HOLD_AT)) return;
    const timer = setInterval(() => setWall(Date.now()), 50);
    return () => clearInterval(timer);
  }, []);
  const seconds = Number.isFinite(HOLD_AT)
    ? HOLD_AT
    : Math.min(DEMO_DURATION_S, (wall - startedAt) / 1000);
  const demo = demoAt(seconds);
  const { call, now } = demo;
  const board = WAITED_MS
    ? {
        ...demo.board,
        sessions: demo.board.sessions.map((s) => (s.status === "asks" || s.status === "needs" ? { ...s, since: s.since - WAITED_MS } : s)),
      }
    : demo.board;
  const restart = () => {
    setStartedAt(Date.now());
    setWall(Date.now());
  };
  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <KeyboardProvider>
          <StatusBar style="light" />
          <View style={styles.root}>
            <MissionControl
              call={call}
              board={board}
              providers={PROVIDERS}
              now={now}
              onHangUp={restart}
              onMute={() => undefined}
              onDismiss={restart}
              onRetry={restart}
              onSpeaker={() => true}
            color="#d97757"
            />
            <Pressable
              accessibilityLabel="Restart the demo call"
              onPress={restart}
              style={styles.restart}
            />
          </View>
        </KeyboardProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.color.bg },
  restart: { position: "absolute", top: 0, left: 0, right: 0, height: 44 },
});
