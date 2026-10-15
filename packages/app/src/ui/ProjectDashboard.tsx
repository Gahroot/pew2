/**
 * Every project with its agent state, queue, live activity and last result,
 * folded from the voice store (voice.event / voice.sync). A tall sheet, like
 * the voice screen it opens from. UNTESTED ON DEVICE.
 */
import { useEffect, useMemo, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { theme } from "../theme";
import { Sheet } from "./Sheet";
import { buildDashboard, type AgentState, type ProjectRow, type SessionRef } from "../voice/dashboard";
import { taskStatus } from "../voice/taskBoard";
import type { VoiceTask } from "../voice/types";
import type { VoiceStore } from "../voice/voiceStore";

const TONE: Record<AgentState, string> = {
  idle: theme.color.textFaint,
  working: theme.color.accent,
  waiting: theme.color.danger,
  blocked: theme.color.danger,
  done: theme.color.success,
};

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

function TaskLine({ task, now }: { task: VoiceTask; now: number }) {
  const status = taskStatus(task, now);
  // A task on one of the repo's branches says which, beside its timing.
  const timing = task.repo?.branch ? `${task.repo.branch} · ${status.timing}` : status.timing;
  return (
    <View style={styles.taskLine}>
      <Text style={styles.taskTitle} numberOfLines={2}>
        {task.title}
      </Text>
      <Text style={styles.dim}>{timing}</Text>
    </View>
  );
}

function Row({ row, now }: { row: ProjectRow; now: number }) {
  const color = TONE[row.state];
  return (
    <View style={styles.card} accessible accessibilityLabel={`${row.name}, ${row.stateLabel}`}>
      <View style={[styles.bar, { backgroundColor: color }]} />
      <View style={styles.cardBody}>
        <View style={styles.head}>
          <Text style={styles.name} numberOfLines={1}>
            {row.name}
          </Text>
          <View style={[styles.badge, { backgroundColor: color + "26" }]}>
            <View style={[styles.dot, { backgroundColor: color }]} />
            <Text style={[styles.badgeText, { color }]}>{row.stateLabel}</Text>
          </View>
        </View>

        {row.liveSessions > 0 && row.running.length === 0 ? (
          <Text style={styles.activity}>
            {row.liveSessions === 1 ? "A conversation is open and active" : `${row.liveSessions} conversations are open and active`}
          </Text>
        ) : null}

        {row.approval ? (
          <View style={styles.approval}>
            <Ionicons name="shield-checkmark-outline" size={16} color={theme.color.danger} />
            <Text style={styles.approvalText}>{row.approval}</Text>
          </View>
        ) : null}

        {row.running.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Working on</Text>
            {row.running.map((t) => (
              <TaskLine key={t.taskId} task={t} now={now} />
            ))}
            {row.activity ? <Text style={styles.activity}>{row.activity}</Text> : null}
          </View>
        ) : null}

        {row.queued.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>{`Up next · ${row.queued.length}`}</Text>
            {row.queued.map((t) => (
              <TaskLine key={t.taskId} task={t} now={now} />
            ))}
          </View>
        ) : null}

        {row.lastResult ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Last result</Text>
            <Text style={styles.activity}>{row.lastResult}</Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

export function ProjectDashboard({ visible, store, sessions, onClose }: { visible: boolean; store: VoiceStore; sessions?: readonly SessionRef[]; onClose: () => void }) {
  const rows = useMemo(() => buildDashboard(store, sessions), [store, sessions]);
  const now = useNow(visible);
  return (
    <Sheet visible={visible} title="Projects" onClose={onClose} tall>
      <ScrollView style={styles.list} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {rows.length === 0 ? (
          <View style={styles.empty}>
            <Ionicons name="folder-open-outline" size={22} color={theme.color.textFaint} />
            <Text style={styles.emptyTitle}>No agent activity yet</Text>
            <Text style={styles.dim}>Ask by voice to start work on a project and it will show up here.</Text>
          </View>
        ) : (
          rows.map((row) => <Row key={row.projectId} row={row} now={now} />)
        )}
      </ScrollView>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  list: { flex: 1 },
  content: { gap: theme.space(3), paddingBottom: theme.space(4) },
  empty: { alignItems: "center", gap: theme.space(2), paddingVertical: theme.space(8), paddingHorizontal: theme.space(4) },
  emptyTitle: { color: theme.color.text, fontSize: theme.font.title, fontWeight: "600" },
  card: { flexDirection: "row", borderRadius: theme.radius.lg, backgroundColor: theme.color.surface, overflow: "hidden" },
  bar: { width: 4 },
  cardBody: { flex: 1, padding: theme.space(3), gap: theme.space(3) },
  head: { flexDirection: "row", alignItems: "center", gap: theme.space(2) },
  name: { flex: 1, color: theme.color.text, fontSize: theme.font.title, fontWeight: "700" },
  badge: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 8, paddingVertical: 3, borderRadius: theme.radius.pill },
  badgeText: { fontSize: theme.font.small, fontWeight: "700" },
  dot: { width: 6, height: 6, borderRadius: 3 },
  approval: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    padding: theme.space(3),
    borderRadius: theme.radius.md,
    backgroundColor: theme.color.danger + "1a",
  },
  approvalText: { flex: 1, color: theme.color.text, fontSize: theme.font.body },
  section: { gap: theme.space(1) },
  sectionTitle: { color: theme.color.textDim, fontSize: theme.font.small, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.6 },
  taskLine: { gap: 2 },
  taskTitle: { color: theme.color.text, fontSize: theme.font.body },
  activity: { color: theme.color.textDim, fontSize: theme.font.body },
  dim: { color: theme.color.textDim, fontSize: theme.font.small },
});
