import { useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Alert,
  findNodeHandle,
  StyleSheet,
  Text,
  useWindowDimensions,
} from "react-native";
import * as WebBrowser from "expo-web-browser";
import * as Clipboard from "expo-clipboard";
import { accountLabel, type AccountCommand, type AccountView } from "../voice/account";
import { theme } from "../theme";
import { Sheet } from "./Sheet";
import { StageScroll } from "./stage/StageScroll";
import { Pill, Caption } from "./controls";

interface Props {
  visible: boolean;
  machineLabel: string;
  view: AccountView;
  command: (command: AccountCommand) => boolean;
  onClose: () => void;
}

/** The phone displays only the device code, never OAuth credentials. */
export function VoiceAccountSheet({ visible, machineLabel, view, command, onClose }: Props) {
  const { height } = useWindowDimensions();
  const [notice, setNotice] = useState<string>();
  const status = useRef<Text>(null);
  const label = accountLabel(view);
  const authorization = view.account?.authorization;
  const busy = view.pending !== undefined;
  const supported = view.availability === "supported";
  const connected = ["connected", "not-entitled", "reconnect-required"].includes(
    view.account?.state ?? "",
  );
  useEffect(() => {
    if (!visible) return;
    setNotice(undefined);
    const timer = setTimeout(() => {
      const node = findNodeHandle(status.current);
      if (node !== null) AccessibilityInfo.setAccessibilityFocus(node);
    }, 500);
    return () => clearTimeout(timer);
  }, [visible]);
  useEffect(() => {
    if (visible) AccessibilityInfo.announceForAccessibility(label);
  }, [visible, label]);
  async function open() {
    // Never navigate to an arbitrary URL supplied by a peer.
    if (authorization?.verificationUrl !== "https://auth.openai.com/codex/device") return;
    try {
      await WebBrowser.openBrowserAsync("https://auth.openai.com/codex/device");
    } catch {
      setNotice(
        "Could not open ChatGPT. Retry, or open auth.openai.com/codex/device in your browser.",
      );
    }
  }
  async function copy() {
    if (!authorization) return;
    try {
      await Clipboard.setStringAsync(authorization.userCode);
      setNotice("Code copied.");
      AccessibilityInfo.announceForAccessibility("Code copied");
    } catch {
      setNotice("Could not copy the code. Enter the code shown above.");
    }
  }
  const action = (name: AccountCommand) => {
    setNotice(undefined);
    command(name);
  };
  return (
    <Sheet
      visible={visible}
      title="Voice account"
      label="ChatGPT"
      onClose={onClose}
      dismissLabel="Close voice account"
    >
      <StageScroll
        style={{ flexGrow: 0, maxHeight: height * 0.65 }}
        contentContainerStyle={styles.content}
      >
        <Text ref={status} accessible accessibilityRole="header" style={styles.text}>
          {label}
        </Text>
        {connected && <Text style={styles.text}>Connected on {machineLabel}</Text>}
        {view.availability === "offline" && (
          <Text style={styles.text}>
            Your paired computer must be awake and online to connect a voice account.
          </Text>
        )}
        {view.message && <Text style={styles.text}>{view.message}</Text>}
        {view.account?.error && <Text style={styles.text}>{view.account.error.message}</Text>}
        {notice && (
          <Text accessibilityLiveRegion="polite" style={styles.text}>
            {notice}
          </Text>
        )}
        {authorization ? (
          <>
            <Text style={styles.text}>
              Open ChatGPT and enter this code. Keep your computer online while signing in.
            </Text>
            <Text
              selectable
              accessibilityLabel={`Sign-in code ${authorization.userCode.split("").join(" ")}`}
              style={styles.code}
            >
              {authorization.userCode}
            </Text>
            <Pill
              label="Open ChatGPT"
              onPress={() => {
                void open();
              }}
            >
              <Caption>Open ChatGPT</Caption>
            </Pill>
            <Pill
              label="Copy sign-in code"
              onPress={() => {
                void copy();
              }}
            >
              <Caption>Copy code</Caption>
            </Pill>
            <Pill label="Cancel ChatGPT sign-in" disabled={busy} onPress={() => action("cancel")}>
              <Caption>Cancel</Caption>
            </Pill>
          </>
        ) : (
          <>
            {supported && (
              <Pill
                label={connected ? "Reconnect ChatGPT" : "Connect ChatGPT"}
                disabled={busy}
                onPress={() => action("connect")}
              >
                <Caption>{connected ? "Reconnect ChatGPT" : "Connect ChatGPT"}</Caption>
              </Pill>
            )}
            {view.availability !== "offline" && (
              <Pill
                label="Retry voice account status"
                disabled={busy}
                onPress={() => action("status")}
              >
                <Caption>Retry</Caption>
              </Pill>
            )}
          </>
        )}
        {connected && (
          <Pill
            label="Disconnect voice account"
            disabled={busy}
            onPress={() =>
              Alert.alert(
                "Disconnect voice account?",
                "Remove only Pew2 voice credentials from this computer and end active voice calls. Coding sessions and EZ Coder login are unchanged.",
                [
                  { text: "Cancel", style: "cancel" },
                  { text: "Disconnect", style: "destructive", onPress: () => action("disconnect") },
                ],
              )
            }
          >
            <Caption>Disconnect</Caption>
          </Pill>
        )}
        <Text style={styles.text}>
          Voice availability is checked separately from sign-in. Pew2 does not fall back to an API
          key.
        </Text>
      </StageScroll>
    </Sheet>
  );
}
const styles = StyleSheet.create({
  content: { gap: theme.space(3), paddingBottom: theme.sectionGap },
  text: { color: theme.color.text, fontSize: theme.font.body, lineHeight: theme.line.body },
  code: {
    color: theme.color.text,
    fontSize: theme.font.body,
    lineHeight: theme.line.body,
    fontWeight: "600",
    letterSpacing: 2,
  },
});
