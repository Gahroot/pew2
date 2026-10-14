/**
 * The voice screen: a tall sheet that shows the conversation, how every task is
 * getting on, and the controls to talk, end, or decide an approval.
 *
 * Laid out as three bands so nothing important scrolls away:
 *  - fixed top: the live state (what the voice agent is doing) and headline counts;
 *  - scrolling middle: what was said, then tasks grouped by what needs the user
 *    first, each expandable into its own recent timeline;
 *  - fixed bottom: Talk / End and Projects.
 *
 * Approve/Deny go through the existing permission path (see voice/approvals.ts).
 * Grouping, wording and ages are pure and live in voice/taskBoard.ts.
 */
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { Image } from "expo-image";
import Animated, { cancelAnimation, Easing, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from "react-native-reanimated";
import Ionicons from "@expo/vector-icons/Ionicons";
import { theme } from "../theme";
import { haptics } from "./haptics";
import { Sheet } from "./Sheet";
import { ThinkingOrb } from "./ThinkingOrb";
import { useReducedMotion } from "./useReducedMotion";
import { cardApproval, type HeldPermission } from "../voice/approvals";
import { isActive, type MachineState } from "../voice/voiceMachine";
import { voiceStatus, type StatusKey } from "../voice/presentation";
import { currentLine, groupTasks, summarize, taskStatus, taskTimeline, type GroupKey, type Tone } from "../voice/taskBoard";
import { placeTitle } from "../voice/place";
import type { TranscriptLine } from "../voice/transcript";
import { sendTarget, type ScreenshotCard } from "../voice/screenshots";
import type { VoiceStore } from "../voice/voiceStore";
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
  /** Screenshots shared with voice, newest first. */
  screenshots?: ScreenshotCard[];
  onPickScreenshot?: () => void;
  onRemoveScreenshot?: (card: ScreenshotCard) => void;
  onSendScreenshot?: (attachmentId: string, taskId: string) => void;
}

const TONE: Record<Tone, string> = {
  accent: theme.color.accent,
  danger: theme.color.danger,
  success: theme.color.success,
  dim: theme.color.textFaint,
};

/**
 * Below this window height (iPhone SE and the like) the hero shrinks, so the
 * task list keeps a usable share of the screen between it and the footer.
 */
const COMPACT_HEIGHT = 700;

/** Finished tasks shown before "Show more": they are history, not the point. */
const FINISHED_PREVIEW = 3;

/** Ticks while the sheet is open so ages and durations keep moving. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

function Button({
  label,
  onPress,
  kind = "secondary",
  icon,
}: {
  label: string;
  onPress: () => void;
  kind?: "primary" | "danger" | "secondary";
  icon?: keyof typeof Ionicons.glyphMap;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.btn, kind === "primary" && styles.btnPrimary, kind === "danger" && styles.btnDanger, pressed && styles.pressed]}
      onPress={() => {
        haptics.tap();
        onPress();
      }}
    >
      {icon ? <Ionicons name={icon} size={18} color={theme.color.text} /> : null}
      <Text style={styles.btnText}>{label}</Text>
    </Pressable>
  );
}

function LiveDot({ color, live }: { color: string; live: boolean }) {
  const reduce = useReducedMotion();
  const t = useSharedValue(1);
  useEffect(() => {
    cancelAnimation(t);
    t.value = 1;
    if (live && !reduce) t.value = withRepeat(withTiming(0.25, { duration: 700, easing: Easing.inOut(Easing.quad) }), -1, true);
    return () => cancelAnimation(t);
  }, [live, reduce, t]);
  const style = useAnimatedStyle(() => ({ opacity: t.value }));
  return <Animated.View style={[styles.liveDot, { backgroundColor: color }, style]} />;
}

function Approval({
  task,
  held,
  onAnswer,
}: {
  task: VoiceTask;
  held: HeldPermission[];
  onAnswer: Props["onAnswer"];
}) {
  const [confirming, setConfirming] = useState(false);
  const approval = cardApproval(task, held);
  if (!approval) return null;
  return (
    <View style={styles.approval}>
      <View style={styles.approvalHead}>
        <Ionicons name="shield-checkmark-outline" size={16} color={theme.color.danger} />
        <Text style={styles.approvalRisk}>{`${approval.risk} action`}</Text>
      </View>
      <Text style={styles.approvalText}>{approval.summary}</Text>
      {approval.kind === "voice_only" ? (
        <Text style={styles.dim}>Say "approve" or "deny" to decide, or open that conversation.</Text>
      ) : confirming ? (
        <View style={styles.stack}>
          <Text style={styles.dim}>{`Approve this ${approval.risk} action?`}</Text>
          <View style={styles.row}>
            <Button
              kind="primary"
              label="Yes, approve"
              onPress={() => {
                setConfirming(false);
                onAnswer(approval.sessionId, approval.requestId, approval.approve.optionId, false);
              }}
            />
            <Button label="Cancel" onPress={() => setConfirming(false)} />
          </View>
        </View>
      ) : (
        <View style={styles.row}>
          <Button
            kind="primary"
            label="Approve"
            onPress={() =>
              approval.confirm ? setConfirming(true) : onAnswer(approval.sessionId, approval.requestId, approval.approve.optionId, false)
            }
          />
          <Button label="Deny" onPress={() => onAnswer(approval.sessionId, approval.requestId, approval.deny.optionId, true)} />
        </View>
      )}
    </View>
  );
}

function TaskCard({
  task,
  store,
  held,
  now,
  expanded,
  onToggle,
  onAnswer,
}: {
  task: VoiceTask;
  store: VoiceStore;
  held: HeldPermission[];
  now: number;
  expanded: boolean;
  onToggle: () => void;
  onAnswer: Props["onAnswer"];
}) {
  const status = taskStatus(task, now);
  const color = TONE[status.tone];
  const line = currentLine(store, task);
  const timeline = expanded ? taskTimeline(store, task.taskId, now) : [];
  return (
    <View style={styles.card}>
      <View style={[styles.bar, { backgroundColor: color }]} />
      <View style={styles.cardBody}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          accessibilityLabel={`${placeTitle(task)}: ${task.title}. ${status.label}. ${status.timing}`}
          accessibilityHint={expanded ? "Hides the timeline" : "Shows the timeline"}
          onPress={() => {
            haptics.tap();
            onToggle();
          }}
          style={styles.stack}
        >
          <View style={styles.cardTop}>
            <Text style={styles.project} numberOfLines={1}>
              {placeTitle(task)}
            </Text>
            <View style={[styles.badge, { backgroundColor: color + "26" }]}>
              <LiveDot color={color} live={task.state === "running" && !task.approval} />
              <Text style={[styles.badgeText, { color }]}>{status.label}</Text>
            </View>
          </View>
          <Text style={styles.title} numberOfLines={expanded ? undefined : 2}>
            {task.title}
          </Text>
          {line ? (
            <Text style={styles.activity} numberOfLines={expanded ? undefined : 2}>
              {line}
            </Text>
          ) : null}
          <View style={styles.cardTop}>
            <Text style={styles.dim}>{status.timing}</Text>
            <Ionicons name={expanded ? "chevron-up" : "chevron-down"} size={16} color={theme.color.textFaint} />
          </View>
        </Pressable>
        <Approval task={task} held={held} onAnswer={onAnswer} />
        {expanded ? (
          <View style={styles.timeline}>
            {timeline.length === 0 ? (
              <Text style={styles.dim}>No recent activity recorded for this task.</Text>
            ) : (
              timeline.map((row) => (
                <View key={row.eventId} style={styles.tlRow}>
                  <View style={[styles.tlDot, { backgroundColor: TONE[row.tone] }]} />
                  <Text style={styles.tlText}>{row.text}</Text>
                  <Text style={styles.tlWhen}>{row.when}</Text>
                </View>
              ))
            )}
          </View>
        ) : null}
      </View>
    </View>
  );
}

const RING: Record<StatusKey, { color: string; period: number; scale: number }> = {
  idle: { color: theme.color.textFaint, period: 0, scale: 1 },
  connecting: { color: theme.color.textFaint, period: 1200, scale: 1.15 },
  listening: { color: theme.color.accent, period: 1600, scale: 1.25 },
  thinking: { color: theme.color.accent, period: 700, scale: 1.12 },
  speaking: { color: theme.color.success, period: 500, scale: 1.3 },
  dispatching: { color: theme.color.accent, period: 400, scale: 1.14 },
  reconnecting: { color: theme.color.danger, period: 900, scale: 1.1 },
  paused: { color: theme.color.textFaint, period: 0, scale: 1 },
  ending: { color: theme.color.textFaint, period: 0, scale: 1 },
  ended: { color: theme.color.textFaint, period: 0, scale: 1 },
  error: { color: theme.color.danger, period: 0, scale: 1 },
};

/** A core with a halo whose tempo follows the phase. Reanimated, UI thread. */
function Pulse({ status, compact }: { status: StatusKey; compact: boolean }) {
  const reduce = useReducedMotion();
  const t = useSharedValue(0);
  const cfg = RING[status];
  useEffect(() => {
    cancelAnimation(t);
    t.value = 0;
    if (cfg.period > 0 && !reduce) {
      t.value = withRepeat(withTiming(1, { duration: cfg.period, easing: Easing.inOut(Easing.quad) }), -1, true);
    }
    return () => cancelAnimation(t);
  }, [cfg.period, reduce, t]);
  const style = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + (cfg.scale - 1) * t.value }],
    opacity: 0.35 + 0.65 * (1 - t.value * 0.5),
  }));
  return (
    <View style={[styles.pulseBox, compact && styles.pulseBoxCompact]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Animated.View style={[styles.halo, compact && styles.haloCompact, { borderColor: cfg.color, backgroundColor: cfg.color + "33" }, style]} />
      <View style={[styles.core, compact && styles.coreCompact, { backgroundColor: cfg.color }]} />
    </View>
  );
}

/**
 * One shared screenshot: what it is, where it is, and the one obvious next
 * step. "Send to …" appears only when there is a single task it could mean;
 * otherwise the card says to name one, which is a sentence to the voice agent.
 */
function ScreenshotRow({
  card,
  target,
  onRemove,
  onSend,
}: {
  card: ScreenshotCard;
  target?: VoiceTask;
  onRemove?: (card: ScreenshotCard) => void;
  onSend?: (attachmentId: string, taskId: string) => void;
}) {
  const status =
    card.status === "uploading"
      ? "Sending to your computer…"
      : card.status === "failed"
        ? (card.error ?? "Could not be sent.")
        : card.status === "sent"
          ? `Sent to ${card.sentTo.at(-1)?.title ?? "a task"}`
          : target
            ? `Not sent yet. For “${target.title}”?`
            : "Say which project or task it's for";
  const tone = card.status === "failed" ? styles.error : card.status === "sent" ? styles.sentText : styles.dim;
  return (
    <View style={styles.shot} accessible={false}>
      <View style={styles.thumb}>
        {card.localUri ? (
          <Image source={{ uri: card.localUri }} style={StyleSheet.absoluteFill} contentFit="cover" accessibilityIgnoresInvertColors />
        ) : (
          <Ionicons name="image-outline" size={22} color={theme.color.textFaint} />
        )}
        {card.status === "uploading" ? (
          <View style={styles.thumbBusy}>
            <ActivityIndicator color={theme.color.text} />
          </View>
        ) : null}
      </View>
      <View style={styles.shotBody}>
        <Text style={styles.shotName} numberOfLines={1}>
          {card.name}
        </Text>
        <Text style={[styles.shotStatus, tone]} numberOfLines={3} accessibilityLiveRegion="polite">
          {status}
        </Text>
        {card.status === "held" && target && card.attachmentId && onSend ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Send ${card.name} to ${target.title}`}
            style={({ pressed }) => [styles.sendBtn, pressed && styles.pressed]}
            onPress={() => {
              haptics.tap();
              if (card.attachmentId) onSend(card.attachmentId, target.taskId);
            }}
          >
            <Ionicons name="paper-plane-outline" size={14} color={theme.color.text} />
            <Text style={styles.sendText}>Send to agent</Text>
          </Pressable>
        ) : null}
      </View>
      {card.status !== "uploading" && onRemove ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Remove ${card.name}`}
          hitSlop={8}
          style={({ pressed }) => [styles.remove, pressed && styles.pressed]}
          onPress={() => {
            haptics.tap();
            onRemove(card);
          }}
        >
          <Ionicons name="close" size={18} color={theme.color.textDim} />
        </Pressable>
      ) : null}
    </View>
  );
}

function Chip({ count, label, tone }: { count: number; label: string; tone: Tone }) {
  if (count === 0) return null;
  return (
    <View style={[styles.chip, { backgroundColor: TONE[tone] + "22" }]} accessible accessibilityLabel={`${count} ${label}`}>
      <View style={[styles.chipDot, { backgroundColor: TONE[tone] }]} />
      <Text style={[styles.chipText, { color: TONE[tone] }]}>{`${count} ${label}`}</Text>
    </View>
  );
}

function Transcript({ lines }: { lines: TranscriptLine[] }) {
  if (lines.length === 0) return null;
  return (
    <View style={styles.stack}>
      <Text style={styles.sectionTitle}>Conversation</Text>
      {lines.slice(-4).map((l) => (
        <View key={l.id} style={[styles.bubble, l.role === "user" ? styles.bubbleUser : styles.bubbleAssistant]}>
          <Text style={l.role === "user" ? styles.said : styles.reply} numberOfLines={5}>
            {l.text}
          </Text>
        </View>
      ))}
    </View>
  );
}

export function VoiceSheet({
  visible,
  machine,
  store,
  transcript,
  held,
  onOpenProjects,
  onClose,
  onTalk,
  onEnd,
  onAnswer,
  screenshots = [],
  onPickScreenshot,
  onRemoveScreenshot,
  onSendScreenshot,
}: Props) {
  const live = isActive(machine.phase);
  const now = useNow(visible);
  const status = voiceStatus(machine, store, transcript, now);
  const groups = groupTasks(store);
  const counts = summarize(store);
  // What the user opened or closed by hand; anything untouched follows the default.
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const [showAllFinished, setShowAllFinished] = useState(false);
  const isOpenByDefault = (key: GroupKey) => key === "attention" || key === "working";
  const compact = useWindowDimensions().height < COMPACT_HEIGHT;
  const target = sendTarget(store.tasks);

  return (
    <Sheet visible={visible} title="Voice" onClose={onClose} tall>
      <View style={styles.body}>
        <View style={[styles.hero, compact && styles.heroCompact]}>
          <Pulse status={status.key} compact={compact} />
          <View style={styles.statusRow}>
            {status.orb ? <ThinkingOrb state={status.orb} /> : null}
            <Text style={styles.state} accessibilityLiveRegion="polite">
              {status.label}
            </Text>
          </View>
          {status.detail ? <Text style={[styles.heroDetail, status.key === "error" && styles.error]}>{status.detail}</Text> : null}
        </View>

        <View style={styles.chips}>
          <Chip count={counts.attention} label="need you" tone="danger" />
          <Chip count={counts.working} label="working" tone="accent" />
          <Chip count={counts.waiting} label="up next" tone="dim" />
          <Chip count={counts.finished - counts.failed} label="done" tone="success" />
          <Chip count={counts.failed} label="failed" tone="danger" />
        </View>

        <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
          {screenshots.length > 0 ? (
            <View style={styles.stack}>
              <Text style={styles.sectionTitle}>Screenshots</Text>
              {screenshots.map((card) => (
                <ScreenshotRow key={card.key} card={card} target={target} onRemove={onRemoveScreenshot} onSend={onSendScreenshot} />
              ))}
            </View>
          ) : null}
          <Transcript lines={transcript} />
          {groups.length === 0 ? (
            <View style={styles.empty}>
              <Ionicons name="sparkles-outline" size={22} color={theme.color.textFaint} />
              <Text style={styles.emptyTitle}>No tasks yet</Text>
              <Text style={styles.emptyText}>Say what you want done, like "ask the pew2 agent to run the tests", or share a screenshot of a fix. Each task will appear here as it starts.</Text>
            </View>
          ) : null}
          {groups.map((group) => {
            const hidden = group.key === "finished" && !showAllFinished ? group.tasks.length - FINISHED_PREVIEW : 0;
            const shown = hidden > 0 ? group.tasks.slice(0, FINISHED_PREVIEW) : group.tasks;
            return (
              <View key={group.key} style={styles.stack}>
                <Text style={styles.sectionTitle}>{`${group.title} · ${group.tasks.length}`}</Text>
                {shown.map((t) => (
                  <TaskCard
                    key={t.taskId}
                    task={t}
                    store={store}
                    held={held}
                    now={now}
                    expanded={toggled[t.taskId] ?? isOpenByDefault(group.key)}
                    onToggle={() =>
                      setToggled((prev) => ({ ...prev, [t.taskId]: !(prev[t.taskId] ?? isOpenByDefault(group.key)) }))
                    }
                    onAnswer={onAnswer}
                  />
                ))}
                {hidden > 0 ? (
                  <Pressable accessibilityRole="button" style={styles.more} onPress={() => setShowAllFinished(true)}>
                    <Text style={styles.moreText}>{`Show ${hidden} more`}</Text>
                  </Pressable>
                ) : null}
              </View>
            );
          })}
        </ScrollView>

        <View style={styles.footer}>
          {live || machine.phase === "closing" || machine.phase === "reconnecting" ? (
            <Button kind="danger" icon="stop-circle-outline" label="End" onPress={onEnd} />
          ) : (
            <Button kind="primary" icon="mic-outline" label={status.retry ? "Try again" : "Talk"} onPress={onTalk} />
          )}
          <Button icon="grid-outline" label="Projects" onPress={onOpenProjects} />
          {onPickScreenshot ? (
            // Icon-only to keep three controls on one row at 320pt; named for
            // VoiceOver, and the empty state says screenshots can be shared.
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Share a screenshot"
              accessibilityHint="Opens your photos to send a picture, like a partner's fix, to a coding agent"
              style={({ pressed }) => [styles.btn, styles.iconBtn, pressed && styles.pressed]}
              onPress={() => {
                haptics.tap();
                onPickScreenshot();
              }}
            >
              <Ionicons name="image-outline" size={20} color={theme.color.text} />
            </Pressable>
          ) : null}
        </View>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  body: { flex: 1, gap: theme.space(3) },
  hero: { alignItems: "center", gap: theme.space(2), paddingTop: theme.space(1) },
  // Sized for the halo at its largest (72 × the 1.3 speaking scale), so the
  // pulse never spills over the status line under it.
  pulseBox: { width: 96, height: 96, alignItems: "center", justifyContent: "center" },
  halo: { position: "absolute", width: 72, height: 72, borderRadius: 36, borderWidth: 2 },
  core: { width: 36, height: 36, borderRadius: 18 },
  heroCompact: { gap: theme.space(1), paddingTop: 0 },
  pulseBoxCompact: { width: 72, height: 72 },
  haloCompact: { width: 54, height: 54, borderRadius: 27 },
  coreCompact: { width: 28, height: 28, borderRadius: 14 },
  statusRow: { flexDirection: "row", alignItems: "center", gap: theme.space(2) },
  state: { color: theme.color.text, fontSize: 22, fontWeight: "700" },
  heroDetail: { color: theme.color.textDim, fontSize: theme.font.body, textAlign: "center" },
  error: { color: theme.color.danger },
  chips: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: theme.space(2) },
  chip: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, paddingVertical: 6, borderRadius: theme.radius.pill },
  chipDot: { width: 6, height: 6, borderRadius: 3 },
  chipText: { fontSize: theme.font.small, fontWeight: "600" },
  scroll: { flex: 1 },
  // Grows to the viewport so an empty screen can centre its hint between the
  // hero and the footer instead of leaving a dead band above the buttons.
  scrollContent: { flexGrow: 1, gap: theme.space(5), paddingBottom: theme.space(4) },
  stack: { gap: theme.space(2) },
  row: { flexDirection: "row", gap: theme.space(2), alignItems: "center", flexWrap: "wrap" },
  sectionTitle: { color: theme.color.textDim, fontSize: theme.font.small, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.6 },
  bubble: { maxWidth: "88%", paddingHorizontal: 12, paddingVertical: 8, borderRadius: theme.radius.lg },
  bubbleUser: { alignSelf: "flex-end", backgroundColor: theme.color.surfacePressed },
  bubbleAssistant: { alignSelf: "flex-start", backgroundColor: theme.color.surface },
  said: { color: theme.color.text, fontSize: theme.font.body },
  reply: { color: theme.color.text, fontSize: theme.font.body },
  empty: { flexGrow: 1, alignItems: "center", justifyContent: "center", gap: theme.space(2), paddingVertical: theme.space(6), paddingHorizontal: theme.space(4) },
  emptyTitle: { color: theme.color.text, fontSize: theme.font.title, fontWeight: "600" },
  emptyText: { color: theme.color.textDim, fontSize: theme.font.small, textAlign: "center", maxWidth: 300 },
  card: { flexDirection: "row", borderRadius: theme.radius.lg, backgroundColor: theme.color.surface, overflow: "hidden" },
  bar: { width: 4 },
  cardBody: { flex: 1, padding: theme.space(3), gap: theme.space(2) },
  cardTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: theme.space(2) },
  project: { flex: 1, color: theme.color.textDim, fontSize: theme.font.small, fontWeight: "600" },
  badge: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 8, paddingVertical: 3, borderRadius: theme.radius.pill },
  badgeText: { fontSize: theme.font.small, fontWeight: "700" },
  liveDot: { width: 6, height: 6, borderRadius: 3 },
  title: { color: theme.color.text, fontSize: theme.font.title, fontWeight: "600" },
  activity: { color: theme.color.textDim, fontSize: theme.font.body },
  dim: { color: theme.color.textDim, fontSize: theme.font.small },
  approval: { gap: theme.space(2), padding: theme.space(3), borderRadius: theme.radius.md, backgroundColor: theme.color.danger + "1a" },
  approvalHead: { flexDirection: "row", alignItems: "center", gap: 6 },
  approvalRisk: { color: theme.color.danger, fontSize: theme.font.small, fontWeight: "700", textTransform: "uppercase" },
  approvalText: { color: theme.color.text, fontSize: theme.font.body },
  timeline: { gap: theme.space(2), paddingTop: theme.space(2), borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.color.border },
  tlRow: { flexDirection: "row", alignItems: "flex-start", gap: theme.space(2) },
  tlDot: { width: 6, height: 6, borderRadius: 3, marginTop: 7 },
  tlText: { flex: 1, color: theme.color.text, fontSize: theme.font.small + 1, lineHeight: 20 },
  tlWhen: { color: theme.color.textFaint, fontSize: theme.font.tiny, marginTop: 3 },
  more: { alignSelf: "center", paddingVertical: theme.space(2), paddingHorizontal: theme.space(3), minHeight: theme.size.touch, justifyContent: "center" },
  moreText: { color: theme.color.accent, fontSize: theme.font.body, fontWeight: "600" },
  footer: { flexDirection: "row", gap: theme.space(2) },
  iconBtn: { flex: 0, width: theme.size.touch + 6, paddingHorizontal: 0 },
  shot: { flexDirection: "row", alignItems: "flex-start", gap: theme.space(3), padding: theme.space(3), borderRadius: theme.radius.lg, backgroundColor: theme.color.surfaceRaised },
  thumb: { width: 56, height: 56, borderRadius: theme.radius.md, overflow: "hidden", alignItems: "center", justifyContent: "center", backgroundColor: theme.color.surfacePressed },
  thumbBusy: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0,0,0,0.45)" },
  shotBody: { flex: 1, minWidth: 0, gap: 4 },
  shotName: { color: theme.color.text, fontSize: theme.font.body, fontWeight: "600" },
  shotStatus: { fontSize: theme.font.small },
  sentText: { color: theme.color.success },
  sendBtn: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: theme.space(1),
    minHeight: theme.size.touch,
    paddingHorizontal: theme.space(3),
    borderRadius: theme.radius.pill,
    backgroundColor: theme.color.accent,
    maxWidth: "100%",
  },
  sendText: { color: "#fff", fontSize: theme.font.small, fontWeight: "700", flexShrink: 1 },
  remove: { width: theme.size.touch, height: theme.size.touch, alignItems: "center", justifyContent: "center", marginTop: -theme.space(2), marginRight: -theme.space(2) },
  btn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    minHeight: theme.size.touch + 6,
    paddingHorizontal: theme.space(4),
    borderRadius: theme.radius.pill,
    backgroundColor: theme.color.surfacePressed,
  },
  btnPrimary: { backgroundColor: theme.color.accent },
  btnDanger: { backgroundColor: theme.color.danger + "cc" },
  pressed: { opacity: 0.7 },
  btnText: { color: "#fff", fontSize: theme.font.body, fontWeight: "700" },
});
