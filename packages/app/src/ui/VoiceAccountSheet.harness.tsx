/** Native fixtures only. EXPO_PUBLIC_HARNESS=VoiceAccountSheet EXPO_PUBLIC_VOICE_ACCOUNT=authorizing bun run harness */
import { useEffect, useState } from "react";
import { View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { KeyboardProvider } from "react-native-keyboard-controller";
import * as SplashScreen from "expo-splash-screen";
import { VoiceAccountSheet } from "./VoiceAccountSheet";
import type { AccountView } from "../voice/account";
import { theme } from "../theme";

const scenes: Record<string, AccountView> = {
  offline: { availability: "offline" },
  checking: { availability: "checking", pending: "status" },
  unsupported: {
    availability: "unsupported",
    message: "Update Pew2 on your computer to connect a voice account.",
  },
  empty: { availability: "supported" },
  authorizing: {
    availability: "supported",
    account: {
      t: "voice.account.state",
      requestId: "fixture",
      supported: true,
      state: "authorizing",
      voiceReady: false,
      authorization: {
        attemptId: "12345678-1234-4234-8234-123456789012",
        userCode: "DEMO-1234",
        verificationUrl: "https://auth.openai.com/codex/device",
        expiresAt: 4_000_000_000_000,
      },
    },
  },
  connected: {
    availability: "supported",
    account: {
      t: "voice.account.state",
      requestId: "fixture",
      supported: true,
      state: "connected",
      voiceReady: true,
    },
  },
  reconnect: {
    availability: "supported",
    account: {
      t: "voice.account.state",
      requestId: "fixture",
      supported: true,
      state: "reconnect-required",
      voiceReady: false,
    },
  },
  notEntitled: {
    availability: "supported",
    account: {
      t: "voice.account.state",
      requestId: "fixture",
      supported: true,
      state: "not-entitled",
      voiceReady: false,
    },
  },
  retry: {
    availability: "supported",
    account: {
      t: "voice.account.state",
      requestId: "fixture",
      supported: true,
      state: "connected",
      voiceReady: false,
      error: {
        code: "rate-limited",
        retryable: true,
        message: "OpenAI is limiting voice sessions. Try again later.",
      },
    },
  },
  expired: {
    availability: "supported",
    message: "The sign-in code expired. Connect ChatGPT again.",
  },
};
export default function VoiceAccountSheetHarness() {
  const [view, setView] = useState(
    scenes[process.env.EXPO_PUBLIC_VOICE_ACCOUNT ?? "empty"] ?? scenes.empty,
  );
  useEffect(() => {
    void SplashScreen.hideAsync().catch(() => undefined);
  }, []);
  if (!view) return null;
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <KeyboardProvider>
        <SafeAreaProvider>
          <View style={{ flex: 1, backgroundColor: theme.color.bg }}>
            <VoiceAccountSheet
              visible
              machineLabel="Fixture computer with a very long name for wrapping"
              view={view}
              onClose={() => {}}
              command={(command) => {
                setView(
                  command === "connect"
                    ? scenes.authorizing
                    : command === "cancel" || command === "disconnect"
                      ? scenes.empty
                      : scenes.connected,
                );
                return true;
              }}
            />
          </View>
        </SafeAreaProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}
