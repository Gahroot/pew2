/**
 * The voice conversation screen: state, orb, task cards, End.
 * Approve/Deny go through the existing permission path (see voice/approvals.ts).
 */
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { theme } from "../theme";
import { Sheet } from "./Sheet";
import { ThinkingOrb } from "./ThinkingOrb";
import { cardApproval, type HeldPermission } from "../voice/approvals";
import { isActive, type MachineState, type Phase } from "../voice/voiceMachine";
import { orderedTasks, type VoiceStore } from "../voice/voiceStore";
import type { VoiceTask } from "../voice/types";

const LABEL: Record<Phase, string> = {
  idle: "Ready",
  opening: "Starting...",
  connecting: "Connecting...",
  listening: "Listening",
  speaking: "Speaking",
  reconnecting: "Reconnecting...",
  interrupted: "Paused by a call or alert",
  closing: "Ending...",
  closed: "Conversation ended",
  error: "Voice unavailable",
};

interface Props {
  visible: boolean;
  machine: MachineState;
  store: VoiceStore;
  held: HeldPermission[];
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

export function VoiceSheet({ visible, machine, store, held, onClose, onTalk, onEnd, onAnswer }: Props) {
  const live = isActive(machine.phase);
  const orb = machine.phase === "speaking" ? "composing" : machine.phase === "listening" ? "listening" : "connecting";
  const tasks = orderedTasks(store);
  return (
    <Sheet visible={visible} title="Voice" onClose={onClose}>
      <View style={styles.body}>
        <View style={styles.status}>
          {live ? <ThinkingOrb state={orb} /> : null}
          <Text style={styles.state} accessibilityLiveRegion="polite">
            {LABEL[machine.phase]}
          </Text>
        </View>
        {machine.phase === "error" && machine.message ? <Text style={styles.error}>{machine.message}</Text> : null}
        <ScrollView style={styles.list}>
          {tasks.length === 0 ? <Text style={styles.activity}>No tasks yet. Start talking to create one.</Text> : null}
          {tasks.map((t) => (
            <Card key={t.taskId} task={t} held={held} onAnswer={onAnswer} />
          ))}
        </ScrollView>
        {live || machine.phase === "closing" ? (
          <Button label="End" onPress={onEnd} />
        ) : (
          <Button label="Talk" onPress={onTalk} />
        )}
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  body: { padding: 16, gap: 12 },
  status: { flexDirection: "row", alignItems: "center", gap: 10 },
  state: { color: theme.color.text, fontSize: 17, fontWeight: "600" },
  error: { color: theme.color.text, fontSize: 15 },
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
