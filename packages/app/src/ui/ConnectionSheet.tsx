import { Alert, Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { StageScroll } from "./stage/StageScroll";
import { Sheet } from "./Sheet";
import { PrivacyLink } from "./PrivacyLink";
import { TermsLink } from "./TermsLink";
import { haptics } from "./haptics";
import { Handshake, type HandshakePhase } from "./Handshake";
import { Led } from "./stage/Led";
import { DashedRule } from "./stage/DashedRule";
import { Dissolve } from "./motion/Dissolve";
import { theme } from "../theme";
import type { Status } from "../useDaemon";

// Same fixed desktop install/update instruction formerly shown in Sidebar.
const INSTALL_COMMAND = "curl -fsSL https://raw.githubusercontent.com/Gahroot/pew2/main/install.sh | sh";
/** Shared label column, so every value starts at the same x. */
const LABEL_WIDTH = 92;

interface Props {
  visible: boolean;
  machineLabel: string;
  machineRemote: boolean;
  status: Status;
  update?: { latest: string; automatic: boolean };
  onClose: () => void;
  onUnpair: () => void;
  /** The voice row: absent when this daemon has no voice (older, or never answered). */
  voice?: { line: string; onOpen: () => void };
  /** Notification permission: On / Off / Not set, and what tapping it does. */
  alerts?: { value: string; onPress: () => void };
}

const PHASE = { online: "paired", connecting: "pairing", offline: "waiting" } satisfies Record<Status, HandshakePhase>;

function Row({ label, index, children }: { label: string; index: number; children: React.ReactNode }) {
  return (
    <Dissolve kind="row" delay={index * 50}>
      <View style={styles.row}>
        <Led tone="dim" style={styles.rowLabel}>{label}</Led>
        <View style={styles.rowValue}>{children}</View>
      </View>
    </Dissolve>
  );
}

export function ConnectionSheet({ visible, machineLabel, machineRemote, status, update, onClose, onUnpair, voice, alerts }: Props) {
  const { height: screenHeight } = useWindowDimensions();
  const title = status === "online" ? "Connected" : status === "connecting" ? "Connecting…" : "Offline";
  return <Sheet visible={visible} label="Connection" labelTone={status === "connecting" ? "attention" : "agent"} pewMood={status === "online" ? "happy" : status === "connecting" ? "thinking" : "sleepy"} title={title} onClose={onClose} dismissLabel="Close connection details">
    <StageScroll style={[styles.scroll, { maxHeight: Math.round(screenHeight * 0.75) }]} contentContainerStyle={styles.content}>
      <Handshake phase={PHASE[status]} />
      <DashedRule />
      <Row label="Computer" index={0}>
        {/* The computer's own name, never the relay's address. */}
        <Text selectable numberOfLines={1} style={styles.value}>{machineLabel}</Text>
      </Row>
      <Row label="Route" index={1}>
        <Text numberOfLines={1} style={styles.value}>{machineRemote ? "Relay, sealed end to end" : "Same network"}</Text>
      </Row>
      {update && <Row label="pew2" index={2}>
        {update.automatic ? <Text numberOfLines={1} style={styles.value}>Updating to {update.latest}…</Text> :
          <Pressable accessibilityRole="button" accessibilityLabel={`pew2 ${update.latest} is available for ${machineLabel}. How to update.`} hitSlop={8} onPress={() => {
            haptics.tap();
            Alert.alert(`pew2 ${update.latest} is available`, `This computer can't update itself, so run this on ${machineLabel}:\n\n${INSTALL_COMMAND}`, [{ text: "OK" }]);
          }}><Text numberOfLines={1} style={[styles.value, styles.link]}>{update.latest} available · How</Text></Pressable>}
      </Row>}
      {voice && <Row label="Calls" index={3}>
        <Pressable accessibilityRole="button" accessibilityLabel={`Calls: ${voice.line}. Open call settings.`} hitSlop={8} onPress={() => { haptics.tap(); voice.onOpen(); }}>
          <Text numberOfLines={1} style={[styles.value, styles.link]}>{`${voice.line} · Settings ›`}</Text>
        </Pressable>
      </Row>}
      {alerts && <Row label="Alerts" index={4}>
        <Pressable accessibilityRole="button" accessibilityLabel={`Alerts: ${alerts.value}`} hitSlop={8} onPress={() => { haptics.tap(); alerts.onPress(); }}>
          <Text numberOfLines={1} style={[styles.value, styles.link]}>{alerts.value}</Text>
        </Pressable>
      </Row>}
      <DashedRule />
      <View style={styles.legal}>
        <PrivacyLink />
        <TermsLink />
      </View>
      <Pressable accessibilityRole="button" accessibilityLabel={`Forget pairing with ${machineLabel}`} style={styles.action} onPress={() => {
        haptics.warned();
        Alert.alert("Forget this computer?", "You'll need to scan its code to connect again.", [
          { text: "Cancel", style: "cancel" },
          { text: "Forget", style: "destructive", onPress: () => { haptics.warned(); onUnpair(); } },
        ]);
      }}><Text style={styles.destructive}>Unpair this computer</Text></Pressable>
    </StageScroll>
  </Sheet>;
}
const styles = StyleSheet.create({
  // Everything shows at once (it is short); only a very small screen scrolls.
  scroll: { flexGrow: 0 },
  legal: { flexDirection: "row", gap: theme.space(5) },
  content: { paddingBottom: theme.sectionGap, gap: theme.space(3) },
  row: { flexDirection: "row", alignItems: "center", minHeight: theme.size.touch },
  rowLabel: { width: LABEL_WIDTH },
  rowValue: { flex: 1, alignItems: "flex-end" },
  value: { color: theme.color.text, fontSize: theme.font.body, lineHeight: theme.line.body, textAlign: "right" },
  link: { color: theme.color.accent },
  action: { minHeight: theme.size.touch, justifyContent: "center" },
  destructive: { color: theme.color.danger, fontSize: theme.font.body, lineHeight: 20 },
});
