/**
 * The voice conversation screen: state, orb, task cards, End.
 * Approve/Deny go through the existing permission path (see voice/approvals.ts).
 */
import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import Animated, { cancelAnimation, Easing, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from "react-native-reanimated";
import { theme } from "../theme";
import { Sheet } from "./Sheet";
import { ThinkingOrb } from "./ThinkingOrb";
import { cardApproval, type HeldPermission } from "../voice/approvals";
import { isActive, type MachineState } from "../voice/voiceMachine";
import { voiceStatus, type StatusKey } from "../voice/presentation";
import type { TranscriptLine } from "../voice/transcript";
import { orderedTasks, type VoiceStore } from "../voice/voiceStore";
import type { VoiceTask } from "../voice/types";

interface Props {
  visible: boolean;
  machine: MachineState;
  store: VoiceStore;
  transcript: TranscriptLine[];
  held: HeldPermission[];
  onOpenProjects: () => void;
  onClose: () => void;
  onTalk: () => void;
  onEnd: () => void;
  onAnswer: (sessionId: string, requestId: string, optionId: string, deny: boolean) => void;
}

function Button({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} style={styles.btn} onPress={onPress}>
      <Text style={styles.btnText}>{label}</Text>
    </Pressable>
  );
}

function Card({ task, held, onAnswer }: { task: VoiceTask; held: HeldPermission[]; onAnswer: Props["onAnswer"] }) {
  const [confirming, setConfirming] = useState(false);
  const approval = cardApproval(task, held);
  return (
    <View style={styles.card}>
      <Text style={styles.project}>{`${task.projectName} - ${task.state}`}</Text>
      <Text style={styles.title}>{task.title}</Text>
      {task.activity ? <Text style={styles.activity}>{task.activity}</Text> : null}
      {approval ? (
        <View style={styles.approval}>
          <Text style={styles.title}>{approval.summary}</Text>
          {approval.kind === "voice_only" ? (
            <Text style={styles.activity}>Say "approve" or "deny" to decide, or open that conversation.</Text>
          ) : confirming ? (
            <View style={styles.row}>
              <Text style={styles.activity}>{`Approve a ${approval.risk} action?`}</Text>
              <Button
                label="Yes, approve"
                onPress={() => {
                  setConfirming(false);
                  onAnswer(approval.sessionId, approval.requestId, approval.approve.optionId, false);
                }}
              />
              <Button label="Cancel" onPress={() => setConfirming(false)} />
            </View>
          ) : (
            <View style={styles.row}>
              <Button
                label="Approve"
                onPress={() =>
                  approval.confirm
                    ? setConfirming(true)
                    : onAnswer(approval.sessionId, approval.requestId, approval.approve.optionId, false)
                }
              />
              <Button
                label="Deny"
                onPress={() => onAnswer(approval.sessionId, approval.requestId, approval.deny.optionId, true)}
              />
            </View>
          )}
        </View>
      ) : null}
    </View>
  );
}

const RING: Record<StatusKey, { color: string; period: number; scale: number }> = {
  idle: { color: theme.color.textFaint, period: 0, scale: 1 },
  connecting: { color: theme.color.textFaint, period: 1200, scale: 1.15 },
  listening: { color: theme.color.accent, period: 1600, scale: 1.2 },
  thinking: { color: theme.color.accent, period: 700, scale: 1.1 },
  speaking: { color: theme.color.success, period: 500, scale: 1.3 },
  dispatching: { color: theme.color.accent, period: 400, scale: 1.12 },
  reconnecting: { color: theme.color.danger, period: 900, scale: 1.1 },
  paused: { color: theme.color.textFaint, period: 0, scale: 1 },
  ending: { color: theme.color.textFaint, period: 0, scale: 1 },
  ended: { color: theme.color.textFaint, period: 0, scale: 1 },
  error: { color: theme.color.danger, period: 0, scale: 1 },
};

/** A pulsing ring whose tempo follows the phase. Reanimated, UI thread. */
function Pulse({ status }: { status: StatusKey }) {
  const t = useSharedValue(0);
  const cfg = RING[status];
  useEffect(() => {
    cancelAnimation(t);
    t.value = 0;
    if (cfg.period > 0) {
      t.value = withRepeat(withTiming(1, { duration: cfg.period, easing: Easing.inOut(Easing.quad) }), -1, true);
    }
    return () => cancelAnimation(t);
  }, [cfg.period, t]);
  const style = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + (cfg.scale - 1) * t.value }],
    opacity: 0.35 + 0.65 * (1 - t.value * 0.5),
  }));
  return (
    <View style={styles.pulseBox} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Animated.View style={[styles.pulse, { borderColor: cfg.color, backgroundColor: cfg.color + "33" }, style]} />
    </View>
  );
}

function Transcript({ lines }: { lines: TranscriptLine[] }) {
  if (lines.length === 0) return null;
  return (
    <View style={styles.transcript}>
      {lines.slice(-4).map((l) => (
        <Text key={l.id} style={l.role === "user" ? styles.said : styles.reply} numberOfLines={3}>
          {l.role === "user" ? `You: ${l.text}` : l.text}
        </Text>
      ))}
    </View>
  );
}

export function VoiceSheet({ visible, machine, store, transcript, held, onOpenProjects, onClose, onTalk, onEnd, onAnswer }: Props) {
  const live = isActive(machine.phase);
  // The clock only matters for the short "dispatching" window; a status refresh per store change is enough.
  const status = voiceStatus(machine, store, transcript, Date.now());
  const tasks = orderedTasks(store);
  return (
    <Sheet visible={visible} title="Voice" onClose={onClose}>
      <View style={styles.body}>
        <View style={styles.status}>
          <Pulse status={status.key} />
          {status.orb ? <ThinkingOrb state={status.orb} /> : null}
          <Text style={styles.state} accessibilityLiveRegion="polite">
            {status.label}
          </Text>
        </View>
        {status.detail ? <Text style={status.key === "error" ? styles.error : styles.activity}>{status.detail}</Text> : null}
        <Transcript lines={transcript} />
        <ScrollView style={styles.list}>
          {tasks.length === 0 ? <Text style={styles.activity}>No tasks yet. Start talking to create one.</Text> : null}
          {tasks.length > 0 ? <Text style={styles.project}>{`Tasks (${tasks.length})`}</Text> : null}
          {tasks.map((t) => (
            <Card key={t.taskId} task={t} held={held} onAnswer={onAnswer} />
          ))}
        </ScrollView>
        <View style={styles.row}>
          {live || machine.phase === "closing" || machine.phase === "reconnecting" ? (
            <Button label="End" onPress={onEnd} />
          ) : (
            <Button label={status.retry ? "Try again" : "Talk"} onPress={onTalk} />
          )}
          <Button label="Projects" onPress={onOpenProjects} />
        </View>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  body: { padding: 16, gap: 12 },
  status: { flexDirection: "row", alignItems: "center", gap: 10 },
  state: { color: theme.color.text, fontSize: 17, fontWeight: "600" },
  error: { color: theme.color.danger, fontSize: 15 },
  pulseBox: { width: 28, height: 28, alignItems: "center", justifyContent: "center" },
  pulse: { width: 22, height: 22, borderRadius: 11, borderWidth: 2 },
  transcript: { gap: 4 },
  said: { color: theme.color.text, opacity: 0.6, fontSize: 14 },
  reply: { color: theme.color.text, fontSize: 15 },
  list: { maxHeight: 320 },
  card: { paddingVertical: 10, gap: 4 },
  project: { color: theme.color.text, opacity: 0.6, fontSize: 13 },
  title: { color: theme.color.text, fontSize: 15 },
  activity: { color: theme.color.text, opacity: 0.7, fontSize: 14 },
  approval: { gap: 8, marginTop: 6 },
  row: { flexDirection: "row", gap: 8, alignItems: "center", flexWrap: "wrap" },
  btn: { alignItems: "center", paddingHorizontal: 14, paddingVertical: 12, borderRadius: 20, backgroundColor: "#333" },
  btnText: { color: "#fff", fontSize: 15, fontWeight: "600" },
});
