/**
 * Every project with its agent state, queue, live activity and last result,
 * folded from the voice store (voice.event / voice.sync). UNTESTED ON DEVICE.
 */
import { useMemo } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { theme } from "../theme";
import { Sheet } from "./Sheet";
import { buildDashboard, type AgentState, type ProjectRow } from "../voice/dashboard";
import type { VoiceStore } from "../voice/voiceStore";

const TONE: Record<AgentState, string> = {
  idle: theme.color.textFaint,
  working: theme.color.accent,
  waiting: theme.color.danger,
  blocked: theme.color.danger,
  done: theme.color.success,
};

function Row({ row }: { row: ProjectRow }) {
  return (
    <View style={styles.card} accessible accessibilityLabel={`${row.name}, ${row.stateLabel}`}>
      <View style={styles.head}>
        <View style={[styles.dot, { backgroundColor: TONE[row.state] }]} />
        <Text style={styles.name} numberOfLines={1}>
          {row.name}
        </Text>
        <Text style={[styles.state, { color: TONE[row.state] }]}>{row.stateLabel}</Text>
      </View>
      {row.approval ? <Text style={styles.line}>{`Needs approval: ${row.approval}`}</Text> : null}
      {row.activity ? <Text style={styles.line}>{`Now: ${row.activity}`}</Text> : null}
      {row.queued.length > 0 ? (
        <Text style={styles.dim}>{`${row.queued.length} queued: ${row.queued.map((t) => t.title).join(", ")}`}</Text>
      ) : null}
      {row.lastResult ? <Text style={styles.dim}>{`Last: ${row.lastResult}`}</Text> : null}
    </View>
  );
}

export function ProjectDashboard({ visible, store, onClose }: { visible: boolean; store: VoiceStore; onClose: () => void }) {
  const rows = useMemo(() => buildDashboard(store), [store]);
  return (
    <Sheet visible={visible} title="Projects" onClose={onClose}>
      <ScrollView style={styles.list} contentContainerStyle={styles.content}>
        {rows.length === 0 ? (
          <Text style={styles.dim}>No agent activity yet. Ask by voice to start work on a project.</Text>
        ) : (
          rows.map((row) => <Row key={row.projectId} row={row} />)
        )}
      </ScrollView>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  list: { maxHeight: 420 },
  content: { padding: 16, gap: 12 },
  card: { gap: 4, paddingBottom: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.color.border },
  head: { flexDirection: "row", alignItems: "center", gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  name: { flex: 1, color: theme.color.text, fontSize: 16, fontWeight: "600" },
  state: { fontSize: 13, fontWeight: "600" },
  line: { color: theme.color.text, fontSize: 14 },
  dim: { color: theme.color.textDim, fontSize: 13 },
});
