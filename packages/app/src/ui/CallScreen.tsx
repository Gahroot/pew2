/**
 * The call with Pew, as "Mission control": full screen, because a call is the
 * one thing happening.
 *
 * Pew (the voice assistant, purple) sits top-left with live captions beside
 * it; below, up to four session lanes, each with its own Pew in the agent's
 * colour, a status and the *one* thing it is doing now, which swaps in place
 * (held long enough to read, however fast the agent works). A dotted bus runs
 * from Pew down the left to the lanes; while Pew acts on a session, light
 * packets ride it into that session and its Pew takes each one in. Everything about *what* is shown is
 * decided in `voiceBoard.ts` (pure); this file only lays it out and animates.
 *
 * Nothing wraps: every one-line text is `numberOfLines={1}` with a tail
 * ellipsis, rows have fixed heights and a Dynamic Type ceiling, captions stop
 * at three lines. Two type families, as in the rest of the app: the system
 * font for anything read, the LED face (`Led`) for labels and states.
 */
import { createContext, memo, useContext, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Modal, Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { Canvas, DashPathEffect, Path, Skia } from "@shopify/react-native-skia";
import { theme } from "../theme";
import { DUR, EASE, dissolvePlan, withAlpha } from "../motion";
import { Pew } from "../pew/Pew";
import { pewInk, pewPalette } from "../pew/palette";
import { PEW_BODY_CY } from "../pew/engine";
import { canSwitchSpeaker, setSpeaker as routeSpeaker } from "../../modules/pew-audio-route";
import type { CallInput, CallState } from "../voiceCall";
import { cardFor, reopenable, tappedAnswerText, tappedApprovalText, voicePick, type CardItem } from "../voiceCard";
import { ApprovalSheet } from "./ApprovalSheet";
import { AskUserSheet } from "./AskUserSheet";
import { Sheet } from "./Sheet";
import { StageButton } from "./stage/StageButton";
import { Dissolve } from "./motion/Dissolve";
import { AgentColorProvider } from "./stage/agentColor";
import {
  IDLE_BOARD,
  SPEECH_CPS,
  boardEngaged,
  captionPageAt,
  learnSpeechRate,
  spokenLength,
  boardView,
  busyLine,
  callActions,
  captionView,
  CAPTION_LINES,
  pageChars,
  toolFloat,
  voiceMood,
  type BoardState,
  type FoldView,
  type LaneView,
  type LineView,
  type StatusTone,
  type StatusView,
} from "../voiceBoard";
import { haptics } from "./haptics";
import { DotGrid } from "./stage/DotGrid";
import { CallingFx } from "./LaunchFx";
import { ListeningWave } from "./ListeningWave";
import { DotGlyph } from "./stage/DotGlyph";
import { Led } from "./stage/Led";
import { CircleButton } from "./controls";
import { ShimmerText } from "./ShimmerText";
import { useSmoothText } from "./useSmoothText";
import { MS_PER_SYLLABLE, highlightRuns, learnPace, sayPosition, totalSyllables, voicedNow, type SpeechClock } from "../speechSync";
import { useReducedMotion } from "./useReducedMotion";

/** Pew's text colour on the canvas: the purple, lifted for reading. */
/**
 * Pew's colour on a call: the agent the user is in (Claude Code's orange, GG
 * Goals' green), as on the home screen. `ink` is its lit LED colour, `text`
 * the brightest, for words in it on the dark ground.
 */
interface VoiceInk {
  ink: string;
  text: string;
}
function voiceInk(color: string | undefined): VoiceInk {
  const hex = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, "0");
  const [r, g, b] = pewPalette(color).light;
  return { ink: pewInk(color), text: `#${hex(r)}${hex(g)}${hex(b)}` };
}
const VoiceInkContext = createContext<VoiceInk>(voiceInk(undefined));
/** Fixed-height rows stop growing past this Dynamic Type step. */
const ROW_FONT_MAX = 1.2;

// Geometry, from the mockup (393pt wide phone), relative to the safe-area top.
const PEW_SIZE = 132;
/** Pew alone on the call, before the board: big and centred. */
const SOLO_SIZE = 220;
/** Pew's move from the centre to the board's corner. */
const BOARD_MOVE_MS = 700;
const PEW_LEFT = 6;
const PEW_TOP = 20;
const CAP_LEFT = 146;
const LANES_TOP = 160;
const LANES_LEFT = 26;
const LANES_RIGHT = 14;
const BUS_X = 13;
const LANE_H = 76;
const LANE_GAP = 10;
/** The lane's Pew: its box, and the centre the wire aims at. */
const LANE_PEW = 54;
const LANE_PEW_LEFT = 6;
const LANE_PEW_TOP = 11;
const BRANCH_Y = LANE_PEW_TOP + LANE_PEW / 2;
/** Where text starts in a lane, clear of its Pew. */
const LANE_TEXT_LEFT = 68;
const FOLD_H = 30;
/** The activity row's shimmer: the same slow sweep as the chat's activity line. */
const SWEEP_MS = 2200;
const NOW_LINE_H = 18;
const CONTROLS_H = 76;

export interface ProviderColor {
  id: string;
  name?: string;
  color?: string;
}

/** The card's answer, ready for the voice hook: the daemon frame, and what Pew is told. */
export type ScreenAnswer = Omit<Extract<CallInput, { type: "answeredOnScreen" }>, "type">;

interface Props {
  call: CallState;
  board?: BoardState;
  providers?: readonly ProviderColor[];
  onHangUp: () => void;
  onMute: (muted: boolean) => void;
  onDismiss: () => void;
  onRetry: () => void;
  /** The user answered the on-screen card by tapping. Absent: the card is read-only (still shown). */
  onAnswer?: (answer: ScreenAnswer) => void;
  /** The agent the user is in: Pew takes its colour. */
  color?: string;
  /** Tap Pew to cut it off mid-sentence. */
  onInterrupt?: () => void;
  /** The mic's loudness, for the listening waves. */
  micLevel?: SharedValue<number>;
  /** Pew's speaking clock: the captions follow its voice word by word. */
  speech?: RefObject<SpeechClock>;
}

export function CallScreen({ call, board = IDLE_BOARD, providers = [], onHangUp, onMute, onDismiss, onRetry, onAnswer, color, onInterrupt, micLevel, speech }: Props) {
  const visible = call.phase !== "idle";
  const over = call.phase === "ended" || call.phase === "failed";
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen" onRequestClose={over ? onDismiss : onHangUp}>
      <MissionControl
        call={call}
        board={board}
        providers={providers}
        onHangUp={onHangUp}
        onMute={onMute}
        onDismiss={onDismiss}
        onRetry={onRetry}
        onAnswer={onAnswer}
        color={color}
        onInterrupt={onInterrupt}
        micLevel={micLevel}
        speech={speech}
        onSpeaker={canSwitchSpeaker ? routeSpeaker : undefined}
      />
    </Modal>
  );
}

export interface MissionControlProps {
  call: CallState;
  board: BoardState;
  providers: readonly ProviderColor[];
  onHangUp: () => void;
  onMute: (muted: boolean) => void;
  onDismiss: () => void;
  onRetry: () => void;
  /** A scripted clock (the demo). Absent: the screen runs its own. */
  now?: number;
  /**
   * Route the call to the loudspeaker or back. Returns false when it did not
   * switch (the button then stays as it was). Absent: no speaker button, for a
   * build without the native route switch.
   */
  onSpeaker?: (on: boolean) => boolean | void;
  /** The user tapped an answer on the card. */
  onAnswer?: (answer: ScreenAnswer) => void;
  /** The agent the user is in: Pew takes its colour. Absent: pew2's own coral. */
  color?: string;
  /** Tap Pew while it talks to cut it off (the mic is closed while it speaks). */
  onInterrupt?: () => void;
  /** The mic's loudness for the listening waves (0..1, -1 unknown). */
  micLevel?: SharedValue<number>;
  /** Pew's speaking clock (absent: captions paced by time, as in the demo). */
  speech?: RefObject<SpeechClock>;
}

/** Re-render on a short clock while a call is on screen, for type-out and captions. */
function useClock(active: boolean, override: number | undefined): number {
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    if (!active || override !== undefined) return;
    const timer = setInterval(() => setTick(Date.now()), 60);
    return () => clearInterval(timer);
  }, [active, override]);
  return override ?? tick;
}

/** Remember when `key` last changed, on the screen's clock (adjusted during render, React's pattern). */
function useChangedAt(key: unknown, now: number): number {
  const [seen, setSeen] = useState<{ key: unknown; at: number }>({ key, at: now });
  if (seen.key !== key) {
    setSeen({ key, at: now });
    return now;
  }
  return seen.at;
}

function toneColor(tone: StatusTone, brand: string, pew: string): string {
  switch (tone) {
    case "agent":
      return brand;
    case "attention":
      return theme.color.attention;
    case "success":
      return theme.color.success;
    case "pew":
      return pew;
    case "dim":
      return theme.color.textDim;
  }
}

/**
 * Whether a lane's header has room for the agent's name beside the folder.
 * Two truncated names ("customer-portal-front… Cursor A…") read as broken, so a
 * long folder keeps the row to itself; the agent is still in the accessibility
 * label and its Pew is already in the agent's colour.
 */
export function showAgentName(folder: string | undefined, agent: string | undefined): boolean {
  if (!agent) return false;
  return (folder?.length ?? 0) + agent.length <= 24;
}

function brandOf(lane: Pick<LaneView, "providerId" | "agentName">, providers: readonly ProviderColor[]): string {
  const byId = lane.providerId ? providers.find((p) => p.id === lane.providerId) : undefined;
  const byName = byId ?? providers.find((p) => p.name !== undefined && p.name === lane.agentName);
  return byName?.color ?? theme.color.orb;
}

/** The end sheet's LED line: "0:46 · 5 actions". */
function endMeta(time: string, count: number): string {
  return `${time} · ${count === 1 ? "1 action" : `${count} actions`}`;
}

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function MissionControl({ call, board, providers, onHangUp, onMute, onDismiss, onRetry, now: override, onSpeaker, onAnswer, color, onInterrupt, micLevel, speech }: MissionControlProps) {
  const insets = useSafeAreaInsets();
  const reduceMotion = useReducedMotion();
  const over = call.phase === "ended" || call.phase === "failed";
  const now = useClock(call.phase !== "idle", override);
  const [speaker, setSpeaker] = useState(false);
  /** Counts packets landing in the session Pew is acting on; its Pew takes each one in. */
  const feeds = useSharedValue(0);

  // One haptic per phase change: connected, ended, failed.
  const lastPhase = useRef(call.phase);
  useEffect(() => {
    if (lastPhase.current === call.phase) return;
    lastPhase.current = call.phase;
    // Felt only: the call's own cues (connect, end) are the sound.
    if (call.phase === "live") haptics.finished(null);
    else if (call.phase === "failed") haptics.warned(null);
    else if (call.phase === "ended") haptics.tap(null);
  }, [call.phase]);

  useEffect(() => {
    if (!over || !speaker) return;
    setSpeaker(false);
    onSpeaker?.(false);
  }, [over, speaker, onSpeaker]);
  // iOS says where the call really plays (`call.speaker`, from route events):
  // the button follows it, so it never shows a choice that didn't take.
  const routed = call.speaker;
  useEffect(() => {
    if (!over) setSpeaker(routed);
  }, [routed, over]);

  const liveAt = useChangedAt(call.phase === "connecting" || call.phase === "idle" ? "pre" : "live", now);
  const endedAt = useChangedAt(over, now);
  const lastActionAt = useChangedAt(call.completed.length, now);

  const view = useMemo(() => boardView(board, call, now), [board, call, now]);
  // Pew alone until it works with sessions (`boardEngaged`), then the board;
  // kept once shown, so the layout never flips back and forth. A new call
  // starts alone again.
  const [engaged, setEngaged] = useState(false);
  // Questions and approvals put away this call, and the one a lane's tap
  // asked for: the card comes back from the lane that still says "Needs you".
  const [hiddenCards, setHiddenCards] = useState<ReadonlySet<string>>(() => new Set());
  const [chosenCard, setChosenCard] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (call.phase !== "connecting") return;
    setHiddenCards(new Set());
    setChosenCard(undefined);
  }, [call.phase]);
  const reopenCard = (sessionId: string) => {
    const id = reopenable(call.inbox, sessionId, hiddenCards);
    if (!id) return;
    haptics.select();
    setChosenCard(id);
    setHiddenCards((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };
  const live = call.phase === "live" || call.phase === "ending";
  const spot = live ? view.spotlight : undefined;

  // Lane positions: one height for every lane, in slot order, so nothing ever jumps.
  const layout = useMemo(() => {
    let y = 0;
    const out = new Map<string, { y: number; h: number }>();
    for (const lane of [...view.lanes].sort((a, b) => a.slot - b.slot)) {
      out.set(lane.sessionId, { y, h: LANE_H });
      y += LANE_H + LANE_GAP;
    }
    return { rows: out, bottom: y };
  }, [view.lanes]);

  // What a running tool is doing: a word floating off Pew while it stands
  // alone (`ToolFloats`); on the board, the caption's line, but never over
  // Pew's own voice, which used to be swapped out mid-sentence for it.
  const pewTalking = call.pewAudio || (call.caption?.who === "pew" && call.responding);
  const busy = engaged && !pewTalking ? busyLine(call, board.sessions) : undefined;
  const caption = captionView(call.caption, busy);
  const voiceLine = useSaidLength(caption, call.pewAudio, now, speech);
  const said = voiceLine.said;
  // Your turn, from the moment you start until Pew's voice starts answering:
  // the waves, never your words. A reply's first words wait for its voice.
  const lastYou = useRef(-1);
  if (call.caption?.who === "you") lastYou.current = call.caption.serial;
  const answering = call.caption?.who === "pew" && call.caption.serial === lastYou.current + 1 && said === 0;
  const listening = live && !busy && (call.userSpeaking || call.caption?.who === "you" || answering);
  const mood = voiceMood(call, now, call.completed.length > 0 ? lastActionAt : 0);
  const elapsed = call.phase === "connecting" ? 0 : (over ? endedAt : now) - liveAt;

  const top = insets.top;
  const { width, height } = useWindowDimensions();
  const voice = useMemo(() => voiceInk(color), [color]);

  const engagedNow = live && view.lanes.length > 0 && boardEngaged(board, call);
  useEffect(() => {
    if (call.phase === "connecting") setEngaged(false);
    else if (engagedNow) setEngaged(true);
  }, [call.phase, engagedNow]);
  // The board has finished arriving: the question card may rise.
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (!engaged) {
      setSettled(false);
      return;
    }
    const timer = setTimeout(() => setSettled(true), reduceMotion ? 0 : BOARD_MOVE_MS);
    return () => clearTimeout(timer);
  }, [engaged, reduceMotion]);
  // The move is started on the UI thread, inside a frame: started from JS
  // while the captions stream (a repaint every frame), its start time could
  // be stale and the 700ms glide finished in a single frame.
  const k = useSharedValue(0);
  const target = useSharedValue(0);
  useEffect(() => {
    target.value = engaged ? 1 : 0;
  }, [engaged, target]);
  useAnimatedReaction(
    () => target.value,
    (to, from) => {
      if (from === null || to === from) return;
      // The app's in-out curve (EASE.inOut): a move across the screen, not an
      // arrival. The out-curve put three quarters of the travel in the first
      // 200ms, so the glide read as a jump and then a crawl.
      k.value = reduceMotion ? to : withTiming(to, { duration: BOARD_MOVE_MS, easing: Easing.bezier(0.4, 0, 0.2, 1) });
    },
    [reduceMotion],
  );
  // Pew alone sits dead centre of the screen: his body, not his box (the body
  // stands low in the box, on its ground line), so the box rides up by the gap.
  const soloCY = Math.round(height / 2 - (PEW_BODY_CY - 0.5) * SOLO_SIZE);
  const pewStyle = useAnimatedStyle(() => {
    const cx = width / 2 + (PEW_LEFT + PEW_SIZE / 2 - width / 2) * k.value;
    const cy = soloCY + (top + PEW_TOP + PEW_SIZE / 2 - soloCY) * k.value;
    const scale = 1 + (PEW_SIZE / SOLO_SIZE - 1) * k.value;
    return { transform: [{ translateX: cx - SOLO_SIZE / 2 }, { translateY: cy - SOLO_SIZE / 2 }, { scale }] };
  });
  // The centred caption leaves in the first half of the move, the corner one arrives in the second.
  const soloStyle = useAnimatedStyle(() => ({ opacity: Math.max(0, 1 - k.value * 2), transform: [{ translateY: -12 * k.value }] }));
  const boardCaptionStyle = useAnimatedStyle(() => ({ opacity: Math.max(0, k.value * 2 - 1) }));
  // Lanes wait until Pew has mostly passed over their space, then rise in.
  const boardStyle = useAnimatedStyle(() => {
    const b = Math.max(0, (k.value - 0.55) / 0.45);
    return { opacity: b, transform: [{ translateY: 18 * (1 - b) }] };
  });

  const sendingRow = view.sending && live ? layout.rows.get(view.sending) : undefined;
  const busTop = top + PEW_TOP + PEW_SIZE - 6;
  const lanesTop = top + LANES_TOP;
  // The trunk ends at the lowest lane's branch: no dotted tail past the last session.
  const lastBranchY = view.lanes.reduce<number | undefined>((low, lane) => {
    const row = layout.rows.get(lane.sessionId);
    if (!row) return low;
    const y = lanesTop + row.y + BRANCH_Y;
    return low === undefined || y > low ? y : low;
  }, undefined);

  return (
    <VoiceInkContext.Provider value={voice}>
    <View style={styles.screen}>
      <DotGrid />
      {/* The board: wires, lanes and packets, in once Pew works with sessions. */}
      {/* Mounted as soon as there are lanes, hidden until Pew engages: building
          the board (wires, lanes, five Pews) at the moment of the move cost
          more than the move itself, and the screen jumped straight to the end. */}
      <Animated.View style={[StyleSheet.absoluteFill, boardStyle]} pointerEvents={engaged ? "box-none" : "none"}>
        {live && view.lanes.length > 0 ? (
          <>
            <Bus
              busTop={busTop}
              lanesTop={lanesTop}
              lanes={view.lanes}
              layout={layout.rows}
              spot={spot}
              sending={sendingRow ? view.sending : undefined}
              providers={providers}
              bottom={lastBranchY ?? busTop}
            />
            <View style={[styles.lanes, { top: lanesTop, bottom: insets.bottom + 32 + CONTROLS_H + 12 }]} pointerEvents="box-none">
              {view.lanes.map((lane) => {
                const row = layout.rows.get(lane.sessionId) ?? { y: 0, h: LANE_H };
                return (
                  <Lane
                    key={lane.sessionId}
                    lane={lane}
                    open={lane.sessionId === spot}
                    y={row.y}
                    brand={brandOf(lane, providers)}
                    reduceMotion={reduceMotion}
                    feeds={sendingRow && lane.sessionId === view.sending ? feeds : undefined}
                    onReopen={reopenable(call.inbox, lane.sessionId, hiddenCards) ? () => reopenCard(lane.sessionId) : undefined}
                  />
                );
              })}
              {view.fold ? <FoldChip fold={view.fold} y={layout.bottom + 4} brand={theme.color.glyph} /> : null}
            </View>
            {/* Over the lanes, so a packet is seen sinking into the lane past its Pew. */}
            {sendingRow ? (
              <View style={StyleSheet.absoluteFill} pointerEvents="none">
                <Packets fromX={PEW_LEFT + PEW_SIZE / 2} fromY={busTop} toY={lanesTop + sendingRow.y + BRANCH_Y} reduceMotion={reduceMotion} feeds={feeds} />
              </View>
            ) : null}
          </>
        ) : null}
      </Animated.View>

      {/* While the call connects: the New goal launch's charge, gentled. Gone
          the moment the board takes over, and it fades as the call picks up. */}
      {!engaged ? (
        <CallingFx
          scene={{ w: width, h: height, cx: width / 2, cy: soloCY + (PEW_BODY_CY - 0.5) * SOLO_SIZE, kenR: SOLO_SIZE * 0.29 }}
          color={voice.ink}
          on={call.phase === "connecting"}
        />
      ) : null}

      {/* Pew alone, big and centred, until it works with sessions; then it
          travels to the board's corner. Drawn at the big size and scaled, so
          the move is one transform, never a re-layout. */}
      <Animated.View style={[styles.pewStage, pewStyle]} accessibilityLiveRegion="polite">
        <Pew
          size={SOLO_SIZE}
          mood={mood}
          color={color}
          accessibilityLabel={call.pewAudio ? "Pew is talking. Tap to interrupt." : `Pew, ${mood}`}
          interactive
          onPress={call.pewAudio && onInterrupt ? () => {
            haptics.select();
            onInterrupt();
          } : undefined}
        />
      </Animated.View>

      {/* What Pew is doing, floating off its head while it stands alone. */}
      <Animated.View style={[StyleSheet.absoluteFill, soloStyle]} pointerEvents="none">
        {live ? <ToolFloats call={call} sessions={board.sessions} cx={width / 2} headY={height / 2 - SOLO_SIZE * FLOAT_HEAD} color={voice.ink} reduceMotion={reduceMotion} /> : null}
      </Animated.View>

      <Animated.View style={[styles.soloCaption, { top: soloCY + SOLO_SIZE / 2 + 30 }, soloStyle]} pointerEvents="none">
        <SoloCaption width={width} caption={caption} said={said} voiceLine={voiceLine} connecting={call.phase === "connecting"} listening={listening} speaking={call.userSpeaking} micLevel={micLevel} interruptible={call.pewAudio && onInterrupt !== undefined} />
      </Animated.View>
      <Animated.View style={[StyleSheet.absoluteFill, boardCaptionStyle]} pointerEvents="none">
        <Caption width={width} top={top + PEW_TOP + 14} caption={caption} said={said} voiceLine={voiceLine} connecting={call.phase === "connecting"} listening={listening} speaking={call.userSpeaking} micLevel={micLevel} />
      </Animated.View>

      <View style={[styles.controls, { bottom: insets.bottom + 32 }]}>
        <CircleButton
          size={60}
          label={call.muted ? "Unmute" : "Mute"}
          tint={call.muted ? theme.color.accentSoft : undefined}
          disabled={call.phase !== "live"}
          onPress={() => onMute(!call.muted)}
        >
          <DotGlyph name={call.muted ? "mic-off" : "mic"} size={22} />
        </CircleButton>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="End call"
          disabled={over}
          onPress={() => {
            haptics.warned(null);
            onHangUp();
          }}
          style={({ pressed }) => [styles.hangUp, pressed && styles.hangUpPressed]}
        >
          <DotGlyph name="close" size={26} color={theme.color.text} />
        </Pressable>
        {/* Only offered once a route switch exists: a dead button reads as broken. Until
            then iOS routes the call like any other: earpiece, or AirPods when connected. */}
        {onSpeaker ? (
          <CircleButton
            size={60}
            label={speaker ? "Speaker off" : "Speaker"}
            tint={speaker ? theme.color.accentSoft : undefined}
            disabled={call.phase !== "live"}
            onPress={() => {
              // The choice is kept even when it can't take yet (the call's
              // audio still starting): it takes on the next route change, and
              // the route event then sets the button.
              const next = !speaker;
              haptics.select();
              setSpeaker(next);
              onSpeaker(next);
            }}
          >
            <DotGlyph name="speaker" size={22} />
          </CircleButton>
        ) : (
          <View style={styles.controlSpacer} />
        )}
      </View>

      {/* After the move: a sheet rising while Pew travels is two things at once. */}
      {!over && settled ? (
        <CallCard
          call={chosenCard ? { ...call, focus: chosenCard } : call}
          providers={providers}
          lanes={view.lanes}
          onAnswer={onAnswer}
          hidden={hiddenCards}
          onHide={(id) => setHiddenCards((prev) => new Set(prev).add(id))}
        />
      ) : null}

      <EndCard
        visible={over}
        call={call}
        board={board}
        meta={endMeta(clock(elapsed), callActions(call.completed, board.sessions).length)}
        onDismiss={onDismiss}
        onRetry={onRetry}
      />
    </View>
    </VoiceInkContext.Provider>
  );
}

// ── Tool floats ───────────────────────────────────────────

/** How far above the body's centre the words start, in Pew's size: just over the head. */
const FLOAT_HEAD = 0.44;
/** One word's whole life: in, drift up, out. */
const FLOAT_MS = 2400;
/** How far it drifts up while it fades. */
const FLOAT_RISE = 30;
/** Most words on screen at once; a burst of tools drops the oldest. */
const FLOAT_MAX = 3;

interface FloatWord {
  id: string;
  text: string;
  dx: number;
  dy: number;
}

/** A stable scatter from the tool call's id: alternate sides, a little height. */
function floatSpot(id: string, index: number): { dx: number; dy: number } {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  const r = (h >>> 0) / 4294967296;
  const side = index % 2 === 0 ? -1 : 1;
  return { dx: side * (24 + r * 64), dy: -Math.round(((h >>> 8) & 0xff) / 255 * 26) };
}

/**
 * Each tool Pew calls, said as a little word in its own voice ("Peeking at
 * storefront"), rising off its head and fading: what it is up to, without
 * taking over the caption where its words are. Scattered so a few in a row
 * don't stack.
 */
function ToolFloats({ call, sessions, cx, headY, color, reduceMotion }: {
  call: CallState;
  sessions: BoardState["sessions"];
  cx: number;
  headY: number;
  color: string;
  reduceMotion: boolean;
}) {
  const [words, setWords] = useState<FloatWord[]>([]);
  const seen = useRef(new Set<string>());
  const count = useRef(0);
  useEffect(() => {
    const fresh = call.tools.filter((tool) => !seen.current.has(tool.toolCallId));
    if (fresh.length === 0) return;
    const add = fresh.map((tool) => {
      seen.current.add(tool.toolCallId);
      return { id: tool.toolCallId, text: toolFloat(tool.name, tool.arguments, sessions, call.inbox), ...floatSpot(tool.toolCallId, count.current++) };
    });
    setWords((prev) => [...prev, ...add].slice(-FLOAT_MAX));
  }, [call.tools, call.inbox, sessions]);
  const done = useRef((id: string) => setWords((prev) => prev.filter((word) => word.id !== id))).current;
  return (
    <>
      {words.map((word) => (
        <Float key={word.id} word={word} x={cx + word.dx} y={headY + word.dy} color={color} reduceMotion={reduceMotion} onDone={done} />
      ))}
    </>
  );
}

const FLOAT_W = 220;

function Float({ word, x, y, color, reduceMotion, onDone }: { word: FloatWord; x: number; y: number; color: string; reduceMotion: boolean; onDone: (id: string) => void }) {
  const t = useSharedValue(0);
  useEffect(() => {
    t.value = withTiming(1, { duration: FLOAT_MS, easing: Easing.out(Easing.quad) });
    const timer = setTimeout(() => onDone(word.id), FLOAT_MS + 50);
    return () => clearTimeout(timer);
  }, [t, word.id, onDone]);
  const style = useAnimatedStyle(() => {
    const v = t.value;
    // In over the first 12%, held, out over the last 40%.
    const opacity = v < 0.12 ? v / 0.12 : v > 0.6 ? Math.max(0, (1 - v) / 0.4) : 1;
    return { opacity, transform: [{ translateY: reduceMotion ? 0 : -FLOAT_RISE * v }, { scale: reduceMotion ? 1 : 0.92 + 0.08 * Math.min(1, v / 0.12) }] };
  });
  return (
    <Animated.View style={[styles.float, { left: x - FLOAT_W / 2, top: y }, style]}>
      <Led color={color} size={12} numberOfLines={1} maxFontSizeMultiplier={ROW_FONT_MAX}>
        {word.text}
      </Led>
    </Animated.View>
  );
}

// ── Caption ───────────────────────────────────────────────

/**
 * How much of the caption has been *said*. Your words show as they are
 * transcribed (they are already spoken). Pew's arrive from OpenAI well ahead
 * of its voice, so they are held back: revealed from the moment its audio
 * starts, at the pace it speaks, learned from each finished line (the
 * transcript carries no word timings). A finished line stays until the next.
 */
function useSaidLength(
  caption: ReturnType<typeof captionView>,
  pewAudio: boolean,
  now: number,
  speech?: RefObject<SpeechClock>,
): { said: number; started: boolean; spoken: boolean; position: (at: number) => number } {
  // Reads the speaking clock (a ref the call's stats loop moves) on every
  // tick: never memoised, or a cached value would freeze the caption.
  "use no memo";
  const rate = useRef(SPEECH_CPS);
  const pace = useRef(MS_PER_SYLLABLE);
  const voice = useRef<{ key: string; startedAt?: number; stoppedAt?: number; voicedAt?: number; furthest: number }>({ key: "", furthest: 0 });
  if (voice.current.key !== caption.key) voice.current = { key: caption.key, furthest: 0 };
  const line = voice.current;
  const clock = speech?.current;
  if (caption.who === "pew" && pewAudio && line.startedAt === undefined) {
    line.startedAt = now;
    line.voicedAt = clock?.voicedMs;
  }
  if (caption.who === "pew" && !pewAudio && line.startedAt !== undefined && line.stoppedAt === undefined) {
    line.stoppedAt = now;
    rate.current = learnSpeechRate(rate.current, caption.text.length, now - line.startedAt);
    if (clock && line.voicedAt !== undefined) {
      pace.current = learnPace(pace.current, totalSyllables(caption.text), clock.voicedMs - line.voicedAt);
    }
  }
  const text = caption.text;
  /**
   * Where Pew's voice is in the line at `at` (a fractional character index),
   * for the karaoke sweep: on the speaking clock when there is one, by time
   * otherwise. Never moves backwards.
   */
  const position = (at: number): number => {
    if (caption.who !== "pew") return text.length;
    if (line.startedAt === undefined) return 0;
    if (line.stoppedAt !== undefined) return text.length;
    const current = speech?.current;
    const raw =
      current && line.voicedAt !== undefined
        ? sayPosition(text, voicedNow(current, at) - line.voicedAt, pace.current)
        : spokenLength(text, at - line.startedAt, rate.current);
    line.furthest = Math.max(line.furthest, Math.min(text.length, raw));
    return line.furthest;
  };
  const said = caption.who === "pew" ? Math.floor(position(now)) : text.length;
  return {
    said,
    started: caption.who !== "pew" || line.startedAt !== undefined,
    spoken: caption.who !== "pew" || line.stoppedAt !== undefined,
    position,
  };
}

/**
 * One spoken line, streamed the way the chat streams an agent's reply: the
 * text grows through `useSmoothText` (the same reveal engine, pacing and
 * grapheme-safe cuts as `StreamingMarkdown`), so words arrive at an even
 * pace however the transcript deltas bunch up, and nothing is shown before
 * it has been said. A new line (a new speaker or reply) starts its own
 * stream; the old one is replaced, never typed over.
 *
 * Fixed height and line count, so the screen around it never moves while
 * it grows: the box is sized for `lines` lines from the start.
 */
function CaptionText({ caption, said, lines, textStyle, maxChars }: { caption: ReturnType<typeof captionView>; said: number; lines: number; textStyle: { fontSize: number; lineHeight: number }; maxChars: number }) {
  const voice = useContext(VoiceInkContext);
  const ink = caption.who === "you" ? theme.color.accent : caption.who === "busy" ? voice.text : theme.color.text;
  // The page holding what has been said: a long line turns a page at a
  // sentence end instead of shrinking or scrolling what is on screen.
  const page = captionPageAt(caption.text, maxChars, said);
  // Revealed up to what Pew has *said* (or you have), streamed to it with the
  // chat's reveal so a step of several words still flows in.
  const target = page.text.slice(0, Math.max(0, said - page.start));
  const live = caption.who === "pew" || caption.who === "you";
  // Pew's words appear whole as they are spoken (the speaking clock places
  // them): typing them out on top would trail the voice.
  const smooth = useSmoothText(target, `${caption.key}@${page.start}`, live && caption.streaming && caption.who !== "pew");
  const shown = caption.who === "you" && !caption.text ? "…" : smooth.text;
  // The rest of the page is laid out too, unseen: lines wrap where the whole
  // page wraps, so nothing re-flows or re-centres as words appear.
  const rest = shown === smooth.text ? page.text.slice(smooth.text.length) : "";
  return (
    <View style={{ height: textStyle.lineHeight * lines, alignSelf: "stretch" }}>
      <Dissolve kind="swap" dissolveKey={`${caption.key}@${page.start}`}>
        <Text
          numberOfLines={lines}
          maxFontSizeMultiplier={ROW_FONT_MAX}
          style={[textStyle, { color: ink }]}
          accessibilityLabel={page.text}
          accessibilityLiveRegion="polite"
        >
          {shown}
          {rest ? <Text style={styles.unrevealed}>{rest}</Text> : null}
        </Text>
      </Dissolve>
    </View>
  );
}

/**
 * What the caption area shows: Pew's words in time with its voice, or the
 * listening waves while you talk and until Pew starts answering (your words
 * are never shown: they came late and read as clutter), or a status while
 * Pew is busy. Fixed size whichever it is, so nothing around it moves.
 */
function CaptionBody({ caption, said, voiceLine, listening, speaking, micLevel, lines, textStyle, maxChars, centred }: {
  caption: ReturnType<typeof captionView>;
  said: number;
  voiceLine: VoiceLine;
  listening: boolean;
  speaking: boolean;
  micLevel?: SharedValue<number>;
  lines: number;
  textStyle: { fontSize: number; lineHeight: number };
  maxChars: number;
  centred: boolean;
}) {
  const voice = useContext(VoiceInkContext);
  if (listening) {
    return (
      <View style={[styles.waveBox, { height: textStyle.lineHeight * lines, alignItems: centred ? "center" : "flex-start" }]}>
        <Dissolve kind="swap" dissolveKey="listening">
          <ListeningWave speaking={speaking} level={micLevel} color={voice.ink} off={theme.stage.dash} />
        </Dissolve>
      </View>
    );
  }
  if (caption.who === "pew") return <KaraokeText caption={caption} voiceLine={voiceLine} lines={lines} textStyle={textStyle} maxChars={maxChars} />;
  return <CaptionText caption={caption} said={said} lines={lines} textStyle={textStyle} maxChars={maxChars} />;
}

/** Re-render every frame while `active` (the karaoke sweep's own clock, kept to this one Text). */
function useFrameNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    let frame = requestAnimationFrame(function tick() {
      setNow(Date.now());
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [active]);
  return now;
}

/**
 * Pew's line, karaoke style: the whole sentence (page) appears dim the moment
 * Pew starts saying it, and a soft highlight sweeps through it in time with
 * the voice (the speaking clock, `sayPosition`), every frame. Nothing is
 * typed in and nothing re-flows: the text is all there from the start, only
 * its brightness changes. When the voice ends, all of it is lit.
 */
function KaraokeText({ caption, voiceLine, lines, textStyle, maxChars }: { caption: ReturnType<typeof captionView>; voiceLine: VoiceLine; lines: number; textStyle: { fontSize: number; lineHeight: number }; maxChars: number }) {
  // Reads the speaking clock through `voiceLine.position` each frame.
  "use no memo";
  const sweeping = voiceLine.started && !voiceLine.spoken;
  const now = useFrameNow(sweeping);
  const position = voiceLine.position(now);
  const page = captionPageAt(caption.text, maxChars, Math.floor(position));
  const ink = theme.color.text;
  const runs = voiceLine.started ? highlightRuns(page.text, position - page.start) : [];
  return (
    <View style={{ height: textStyle.lineHeight * lines, alignSelf: "stretch" }}>
      {voiceLine.started ? (
        <Dissolve kind="swap" dissolveKey={`${caption.key}@${page.start}`}>
          <Text
            numberOfLines={lines}
            maxFontSizeMultiplier={ROW_FONT_MAX}
            style={[textStyle, { color: withAlpha(ink, KARAOKE_DIM) }]}
            accessibilityLabel={page.text}
            accessibilityLiveRegion="polite"
          >
            {runs.map((run, index) => (
              <Text key={index} style={{ color: withAlpha(ink, KARAOKE_DIM + (1 - KARAOKE_DIM) * run.level) }}>
                {run.text}
              </Text>
            ))}
          </Text>
        </Dissolve>
      ) : null}
    </View>
  );
}

/** How bright Pew's words are before they're said (the sweep lights them to 1). */
const KARAOKE_DIM = 0.32;

/** The speaker label: Pew, Listening, Pew is busy. Always the same height, so text never jumps when it changes. */
function CaptionWho({ who, listening, connecting }: { who: ReturnType<typeof captionView>["who"]; listening: boolean; connecting: boolean }) {
  const voice = useContext(VoiceInkContext);
  const label = connecting ? "Calling Pew · AI" : listening ? "Listening" : who === "pew" ? "Pew" : who === "busy" ? "Pew is busy" : " ";
  const color = who === "busy" && !listening ? voice.text : voice.ink;
  return (
    <Led color={color} maxFontSizeMultiplier={ROW_FONT_MAX}>
      {label}
    </Led>
  );
}

interface CaptionProps {
  /** The screen's width: a page is sized to fit two lines of it. */
  width: number;
  caption: ReturnType<typeof captionView>;
  /** The call is still connecting: the label says so, not "Pew is busy". */
  connecting: boolean;
  said: number;
  /** Pew's line on the speaking clock, for the karaoke sweep. */
  voiceLine: VoiceLine;
  listening: boolean;
  speaking: boolean;
  micLevel?: SharedValue<number>;
}

type VoiceLine = ReturnType<typeof useSaidLength>;

/** Under the big centred Pew: who is talking and what was said, larger and centred. */
function SoloCaption({ interruptible, ...props }: CaptionProps & { interruptible: boolean }) {
  return (
    <>
      <CaptionWho who={props.caption.who} listening={props.listening} connecting={props.connecting} />
      <CaptionBody {...props} lines={CAPTION_LINES} textStyle={styles.soloText} maxChars={pageChars(props.width - theme.gutter * 4, styles.soloText.fontSize)} centred />
      {/* Reserved whether shown or not: the hint arriving must not nudge the text. */}
      <Text style={[styles.soloHint, { opacity: interruptible ? 1 : 0 }]} maxFontSizeMultiplier={ROW_FONT_MAX}>
        Tap Pew to cut in
      </Text>
    </>
  );
}

function Caption({ top, ...props }: CaptionProps & { top: number }) {
  return (
    <View style={[styles.caption, { top }]}>
      <CaptionWho who={props.caption.who} listening={props.listening} connecting={props.connecting} />
      <CaptionBody {...props} lines={CAPTION_LINES} textStyle={styles.captionText} maxChars={pageChars(props.width - CAP_LEFT - theme.gutter, styles.captionText.fontSize)} centred={false} />
    </View>
  );
}

// ── Bus and packets ───────────────────────────────────────

/** Where the wire ends inside a lane: the near edge of the agent's Pew, where packets are taken in. */
const INTO_X = LANES_LEFT + LANE_PEW_LEFT + LANE_PEW * 0.2;
/** Height of the trunk's opening curve under Pew. */
const BEND = 26;

/**
 * The route from Pew into one lane, as plain points.
 *
 * Shared by the drawn wire and the packets riding it, so a packet can never
 * leave the line: the bend under Pew is the same cubic, sampled. Lengths are
 * accumulated so packets move at a constant speed in points per second
 * whatever the lane's distance, instead of covering a long route and a short
 * one in the same time.
 */
export function busRoute(fromX: number, fromY: number, toY: number): { pts: number[]; lens: number[]; total: number } {
  const pts: number[] = [];
  const steps = 14;
  for (let i = 0; i <= steps; i++) {
    const u = i / steps;
    const v = 1 - u;
    // Cubic from (fromX, fromY) via (fromX, fromY+4), (BUS_X, fromY-4) to (BUS_X, fromY+BEND).
    const x = v * v * v * fromX + 3 * v * v * u * fromX + 3 * v * u * u * BUS_X + u * u * u * BUS_X;
    const y = v * v * v * fromY + 3 * v * v * u * (fromY + 4) + 3 * v * u * u * (fromY - 4) + u * u * u * (fromY + BEND);
    pts.push(x, y);
  }
  pts.push(BUS_X, Math.max(fromY + BEND, toY - 8));
  // A rounded corner into the branch, so the turn reads as one wire.
  pts.push(BUS_X + 2.3, toY - 2.3, BUS_X + 8, toY);
  pts.push(INTO_X, toY);
  const lens = [0];
  for (let i = 2; i < pts.length; i += 2) {
    lens.push(lens[lens.length - 1]! + Math.hypot(pts[i]! - pts[i - 2]!, pts[i + 1]! - pts[i - 1]!));
  }
  return { pts, lens, total: lens[lens.length - 1]! };
}

/** The point `d` points along a route. Worklet: packets call it every frame. */
function pointAt(pts: readonly number[], lens: readonly number[], d: number): [number, number] {
  "worklet";
  if (d <= 0) return [pts[0]!, pts[1]!];
  for (let i = 1; i < lens.length; i++) {
    if (lens[i]! >= d) {
      const seg = lens[i]! - lens[i - 1]!;
      const k = seg > 0 ? (d - lens[i - 1]!) / seg : 0;
      const ax = pts[(i - 1) * 2]!;
      const ay = pts[(i - 1) * 2 + 1]!;
      return [ax + (pts[i * 2]! - ax) * k, ay + (pts[i * 2 + 1]! - ay) * k];
    }
  }
  return [pts[pts.length - 2]!, pts[pts.length - 1]!];
}

interface BusProps {
  busTop: number;
  lanesTop: number;
  bottom: number;
  lanes: readonly LaneView[];
  layout: ReadonlyMap<string, { y: number; h: number }>;
  spot?: string;
  /** The lane packets are flowing into: its wire is drawn whole and lit. */
  sending?: string;
  providers: readonly ProviderColor[];
}

/**
 * The dotted trunk from Pew down the left, with a short stub to each lane, and
 * the live wire. The lane Pew is acting on gets the full route drawn solid and
 * lit, running past the lane's edge to its Pew, so the packets on it have a
 * line to follow all the way in.
 */
const Bus = memo(function Bus({ busTop, lanesTop, bottom, lanes, layout, spot, sending, providers }: BusProps) {
  const voice = useContext(VoiceInkContext);
  const startX = PEW_LEFT + PEW_SIZE / 2;
  const trunk = useMemo(() => {
    const p = Skia.Path.Make();
    p.moveTo(startX, busTop);
    p.cubicTo(startX, busTop + 4, BUS_X, busTop - 4, BUS_X, busTop + BEND);
    p.lineTo(BUS_X, Math.max(busTop + BEND, bottom));
    return p;
  }, [startX, busTop, bottom]);
  const sendRow = sending ? layout.get(sending) : undefined;
  const sendLane = sending ? lanes.find((lane) => lane.sessionId === sending) : undefined;
  const live = useMemo(() => {
    if (!sendRow) return null;
    const { pts } = busRoute(startX, busTop, lanesTop + sendRow.y + BRANCH_Y);
    const p = Skia.Path.Make();
    p.moveTo(pts[0]!, pts[1]!);
    for (let i = 2; i < pts.length; i += 2) p.lineTo(pts[i]!, pts[i + 1]!);
    return p;
  }, [sendRow, startX, busTop, lanesTop]);
  return (
    <Canvas style={StyleSheet.absoluteFill} pointerEvents="none">
      <Path path={trunk} style="stroke" strokeWidth={2} strokeCap="round" color={theme.stage.dash}>
        <DashPathEffect intervals={[1, 7]} />
      </Path>
      {lanes.map((lane) => {
        const row = layout.get(lane.sessionId);
        if (!row || lane.sessionId === sending) return null;
        const y = lanesTop + row.y + BRANCH_Y;
        const branch = Skia.Path.Make();
        branch.moveTo(BUS_X, y);
        branch.lineTo(LANES_LEFT, y);
        return (
          <Path
            key={lane.sessionId}
            path={branch}
            style="stroke"
            strokeWidth={2}
            color={lane.sessionId === spot ? brandOf(lane, providers) : theme.stage.dash}
          />
        );
      })}
      {live && sendLane ? (
        <>
          <Path path={live} style="stroke" strokeWidth={6} strokeCap="round" strokeJoin="round" color={withAlpha(voice.ink, 0.14)} />
          <Path path={live} style="stroke" strokeWidth={2} strokeCap="round" strokeJoin="round" color={withAlpha(voice.ink, 0.75)} />
        </>
      ) : null}
    </Canvas>
  );
});

/** How fast a packet travels, in points per second: unhurried, readable at a glance. */
const PACKET_SPEED = 150;
/** Distance between packets along the wire. */
const PACKET_GAP = 70;

/**
 * Light packets riding the wire from Pew into the lane it is acting on.
 *
 * They follow `busRoute` exactly, at a constant speed, fade in leaving Pew and
 * shrink into the receiving Pew's edge. Each landing bumps `feeds` on the UI
 * thread, which that Pew answers with a small ripple: it is being fed.
 */
function Packets({ fromX, fromY, toY, reduceMotion, feeds }: { fromX: number; fromY: number; toY: number; reduceMotion: boolean; feeds: SharedValue<number> }) {
  const route = useMemo(() => busRoute(fromX, fromY, toY), [fromX, fromY, toY]);
  const count = Math.max(2, Math.min(6, Math.round(route.total / PACKET_GAP)));
  const period = (route.total / PACKET_SPEED) * 1000;
  const t = useSharedValue(0);
  useEffect(() => {
    if (reduceMotion) {
      t.value = 0.55;
      return;
    }
    t.value = 0;
    t.value = withRepeat(withTiming(1, { duration: period, easing: Easing.linear }), -1, false);
    return () => cancelAnimation(t);
  }, [reduceMotion, period, t]);
  // A packet lands each time t passes a multiple of 1/count (packet i is at
  // (t + i/count) mod 1, and lands as that wraps), so counting those steps
  // counts landings, wrap of t itself included.
  useAnimatedReaction(
    () => (reduceMotion ? -1 : Math.floor(t.value * count)),
    (step, prev) => {
      if (step < 0 || prev === null || prev < 0 || step === prev) return;
      feeds.value += 1;
    },
    [count, reduceMotion],
  );
  return (
    <>
      {Array.from({ length: reduceMotion ? 1 : count }, (_, i) => (
        <Packet key={i} t={t} offset={i / count} pts={route.pts} lens={route.lens} total={route.total} />
      ))}
    </>
  );
}

function Packet({ t, offset, pts, lens, total }: { t: SharedValue<number>; offset: number; pts: number[]; lens: number[]; total: number }) {
  const voice = useContext(VoiceInkContext);
  const style = useAnimatedStyle(() => {
    const f = (t.value + offset) % 1;
    const [x, y] = pointAt(pts, lens, f * total);
    // Fade in over the first 24pt; over the last 16 (across the lane's edge,
    // into its Pew) shrink and dim, as if taken in.
    const d = f * total;
    const sink = Math.min(1, (total - d) / 16);
    const alpha = Math.min(1, d / 24, 0.25 + 0.75 * sink);
    const scale = 0.45 + 0.55 * sink;
    return { opacity: Math.max(0, alpha), transform: [{ translateX: x - 4 }, { translateY: y - 4 }, { scale }] };
  });
  return <Animated.View pointerEvents="none" style={[styles.packet, { backgroundColor: voice.ink, shadowColor: voice.ink }, style]} />;
}

// ── Lanes ─────────────────────────────────────────────────

interface LaneProps {
  lane: LaneView;
  open: boolean;
  y: number;
  brand: string;
  reduceMotion: boolean;
  /** Set on the lane packets are landing in: its Pew takes each one in. */
  feeds?: SharedValue<number>;
  /** Its question or approval was put away: a tap brings the card back. */
  onReopen?: () => void;
}

/**
 * One session: its Pew, its name, a status, and one row for what it is doing
 * now. Always the same height; the lane Pew is working with is marked by its
 * border and the lit wire, never by growing.
 */
function Lane({ lane, open, y, brand, reduceMotion, feeds, onReopen }: LaneProps) {
  const top = useSharedValue(y);
  const enter = useSharedValue(reduceMotion ? 1 : 0);
  useEffect(() => {
    top.value = reduceMotion ? y : withTiming(y, { duration: theme.motion.base + 120, easing: Easing.bezier(0.2, 0.8, 0.2, 1) });
  }, [y, reduceMotion, top]);
  useEffect(() => {
    enter.value = reduceMotion ? 1 : withTiming(1, { duration: 700, easing: Easing.bezier(0.2, 0.8, 0.2, 1) });
  }, [enter, reduceMotion]);
  const box = useAnimatedStyle(() => ({
    top: top.value,
    opacity: enter.value,
    transform: [{ translateX: (1 - enter.value) * 70 }],
  }));

  const status = lane.status;
  const current = lane.current;
  return (
    <Animated.View
      style={[
        styles.lane,
        open && { borderStyle: "solid", borderWidth: 1.5, borderColor: brand, shadowColor: brand, shadowOpacity: 0.35, shadowRadius: 16, shadowOffset: { width: 0, height: 0 } },
        box,
      ]}
      accessible
      accessibilityRole={onReopen ? "button" : undefined}
      accessibilityHint={onReopen ? "Shows the question again" : undefined}
      accessibilityLabel={`${lane.folder}, ${lane.agentName}, ${status.word}${current ? `. ${current.text}` : ""}`}
      onAccessibilityTap={onReopen}
    >
      <View style={styles.lanePew}>
        <Pew size={LANE_PEW} mood={lane.mood} color={brand} sleepKey={lane.sessionId} feeds={feeds} feedFrom={{ x: LANE_PEW * 0.14, y: LANE_PEW * 0.5 }} />
      </View>
      <View style={styles.laneHead}>
        <View style={styles.laneName}>
          <Text numberOfLines={1} ellipsizeMode="tail" maxFontSizeMultiplier={ROW_FONT_MAX} style={styles.folder}>
            {lane.folder}
          </Text>
          {showAgentName(lane.folder, lane.agentName) ? (
            <Text numberOfLines={1} ellipsizeMode="tail" maxFontSizeMultiplier={ROW_FONT_MAX} style={styles.agent}>
              {lane.agentName}
            </Text>
          ) : null}
        </View>
        <Status status={status} brand={brand} reduceMotion={reduceMotion} />
      </View>
      <View style={styles.nowRow}>
        {current ? (
          <NowLine line={current} working={lane.status.tone === "agent"} reduceMotion={reduceMotion} />
        ) : null}
        {lane.steps >= 2 ? (
          <Led tone="dim" size={10} maxFontSizeMultiplier={ROW_FONT_MAX} style={styles.steps}>
            {`${lane.steps} steps`}
          </Led>
        ) : null}
      </View>
      {onReopen ? <Pressable style={StyleSheet.absoluteFill} onPress={onReopen} /> : null}
    </Animated.View>
  );
}

function Status({ status, brand, reduceMotion }: { status: StatusView; brand: string; reduceMotion: boolean }) {
  const voice = useContext(VoiceInkContext);
  const color = toneColor(status.tone, brand, voice.ink);
  const pulse = useSharedValue(1);
  useEffect(() => {
    if (!status.pulse || reduceMotion) {
      cancelAnimation(pulse);
      pulse.value = 1;
      return;
    }
    pulse.value = withRepeat(withSequence(withTiming(0.25, { duration: 550 }), withTiming(1, { duration: 550 })), -1, false);
    return () => cancelAnimation(pulse);
  }, [status.pulse, reduceMotion, pulse]);
  const dot = useAnimatedStyle(() => ({ opacity: pulse.value }));
  return (
    <View style={styles.status}>
      <Animated.View style={[styles.statusDot, { backgroundColor: color, shadowColor: color }, dot]} />
      <Led color={status.tone === "dim" ? undefined : color} tone={status.tone === "dim" ? "dim" : undefined} maxFontSizeMultiplier={ROW_FONT_MAX}>
        {status.word}
      </Led>
    </View>
  );
}

/** The swap's new line starts this long after the old one begins to leave: a handover, not a double exposure. */
const HANDOVER_MS = 70;

/**
 * The one thing a session is doing, in one row.
 *
 * Two layers, both always mounted, handing over: the visible one holds the
 * current line, the idle one rests at opacity 0. A new line is written into
 * the *idle* layer, so whatever its text does on the way in (a mask being
 * rebuilt, a first unmeasured frame) happens where nothing can be seen. Then
 * the old layer leaves on the app's exit (`DUR.exit`, ease-in) and the new one
 * resolves in on the app's own swap dissolve (`dissolvePlan("swap")`: opacity
 * from 0 and a hair of scale, 340ms ease-out), starting `HANDOVER_MS` later so
 * the two texts never sit on top of each other at strength.
 *
 * Nothing mounts per line, so there is no per-mount animation that could
 * start late and pop. Colour says what a line is (amber waiting on the user,
 * purple Pew's own message, green a result), with no tag in front, so every
 * line starts on the same edge. A running tool keeps the chat's slow sheen.
 */
function NowLine({ line, working, reduceMotion }: { line: LineView; working: boolean; reduceMotion: boolean }) {
  const [layers, setLayers] = useState<{ lines: [LineView | undefined, LineView | undefined]; front: 0 | 1 }>({ lines: [line, undefined], front: 0 });
  // A new line goes into the idle layer, decided during render (derived state),
  // so the commit that shows it already has it in the transparent layer.
  if (layers.lines[layers.front]?.key !== line.key) {
    const next = layers.front === 0 ? 1 : 0;
    const lines: [LineView | undefined, LineView | undefined] = [...layers.lines];
    lines[next] = line;
    setLayers({ lines, front: next });
  }
  const opacity0 = useSharedValue(1);
  const opacity1 = useSharedValue(0);
  const scale0 = useSharedValue(1);
  const scale1 = useSharedValue(1);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const [inOpacity, inScale, outOpacity] = layers.front === 0 ? [opacity0, scale0, opacity1] : [opacity1, scale1, opacity0];
    if (reduceMotion) {
      outOpacity.value = 0;
      inOpacity.value = withTiming(1, { duration: DUR.reduced });
      return;
    }
    const plan = dissolvePlan("swap", false, HANDOVER_MS);
    const [a, b, c, d] = plan.easing;
    const [ia, ib, ic, id] = EASE.in;
    outOpacity.value = withTiming(0, { duration: DUR.exit, easing: Easing.bezier(ia, ib, ic, id) });
    inOpacity.value = plan.fromOpacity;
    inScale.value = plan.fromScale;
    const timing = { duration: plan.duration, easing: Easing.bezier(a, b, c, d) };
    inOpacity.value = withDelay(plan.delay, withTiming(1, timing));
    inScale.value = withDelay(plan.delay, withTiming(1, timing));
  }, [layers.front, reduceMotion, opacity0, opacity1, scale0, scale1]);
  const style0 = useAnimatedStyle(() => ({ opacity: opacity0.value, transform: [{ scale: scale0.value }] }));
  const style1 = useAnimatedStyle(() => ({ opacity: opacity1.value, transform: [{ scale: scale1.value }] }));
  return (
    <View style={styles.nowLine}>
      <NowLayer line={layers.lines[0]} lit={layers.front === 0 && working} style={style0} />
      <NowLayer line={layers.lines[1]} lit={layers.front === 1 && working} style={style1} />
    </View>
  );
}

const NowLayer = memo(function NowLayer({ line, lit, style }: { line?: LineView; lit: boolean; style: ReturnType<typeof useAnimatedStyle> }) {
  const voice = useContext(VoiceInkContext);
  if (!line) return <Animated.View style={[styles.nowLayer, style]} />;
  const amber = line.kind === "ask" || line.kind === "perm";
  const purple = line.kind === "pew" || line.kind === "note";
  const color =
    line.kind === "tool" ? theme.color.glyph : line.kind === "result" ? theme.color.success : amber ? theme.color.attention : purple ? voice.text : theme.color.textDim;
  return (
    <Animated.View style={[styles.nowLayer, style]}>
      <ShimmerText
        text={line.kind === "tool" ? `› ${line.text}` : line.text}
        color={color}
        size={theme.font.small}
        lineHeight={NOW_LINE_H}
        weight="400"
        duration={SWEEP_MS}
        paused={!(line.kind === "tool" && lit)}
        numberOfLines={1}
        maxFontSizeMultiplier={ROW_FONT_MAX}
      />
    </Animated.View>
  );
});

function FoldChip({ fold, y, brand }: { fold: FoldView; y: number; brand: string }) {
  const voice = useContext(VoiceInkContext);
  const color = toneColor(fold.status.tone, brand, voice.ink);
  return (
    <View style={[styles.fold, { top: y }]} accessible accessibilityLabel={`${fold.count} more: ${fold.folder}, ${fold.status.word}`}>
      <Led color={theme.color.text} size={12} maxFontSizeMultiplier={ROW_FONT_MAX}>{`+${fold.count}`}</Led>
      <Text numberOfLines={1} ellipsizeMode="tail" maxFontSizeMultiplier={ROW_FONT_MAX} style={styles.foldFolder}>
        {fold.folder}
      </Text>
      <View style={[styles.statusDot, { backgroundColor: color, shadowColor: color }]} />
      <Led color={fold.status.tone === "dim" ? undefined : color} tone={fold.status.tone === "dim" ? "dim" : undefined} maxFontSizeMultiplier={ROW_FONT_MAX}>
        {fold.status.word}
      </Led>
    </View>
  );
}

// ── End card ──────────────────────────────────────────────

/**
 * The question or approval Pew is on, as the app's own sheet, in the asking
 * agent's colour, over the board. Pew says it's on screen; the user can tap
 * the answer or say it. A spoken answer is drawn on the card while Pew's tool
 * runs, and the card leaves when the item leaves the inbox, however it was
 * answered. Closing it puts it away for this call; the item stays waiting and
 * Pew still reads it out.
 */
function CallCard({ call, providers, lanes, onAnswer, hidden, onHide }: {
  call: CallState;
  providers: readonly ProviderColor[];
  lanes: readonly LaneView[];
  onAnswer?: (answer: ScreenAnswer) => void;
  /** Put away this call; held by the screen so a lane can bring one back. */
  hidden: ReadonlySet<string>;
  onHide: (id: string) => void;
}) {
  const card = cardFor(call, hidden);
  // Held through its exit, so the sheet leaves with its content instead of emptying mid-travel.
  const held = useRef<CardItem | undefined>(card);
  if (card) held.current = card;
  const shown = held.current;
  const pick = card ? voicePick(call, card) : undefined;
  const lane = shown ? lanes.find((l) => l.sessionId === shown.sessionId) : undefined;
  const voice = useContext(VoiceInkContext);
  const color = (lane ? brandOf(lane, providers) : undefined) ?? voice.ink;
  const from = shown?.folder ?? shown?.agentName ?? "an agent";
  const hide = () => {
    if (card) onHide(card.id);
  };
  return (
    <AgentColorProvider value={color}>
      <AskUserSheet
        ask={card?.kind === "question" ? { requestId: card.requestId, questions: card.questions } : undefined}
        call={{ from, voicePick: pick?.draft, onHide: hide }}
        onAnswer={(requestId, result) => {
          if (!shown || shown.kind !== "question" || requestId !== shown.requestId) return;
          onHide(shown.id);
          onAnswer?.({
            itemId: shown.id,
            message: { t: "session.ask", sessionId: shown.sessionId, requestId, result },
            tell: tappedAnswerText(shown, result),
            tool: "answer_question",
            arguments: result.action === "cancel" ? { item_id: shown.id, cancel: true } : { item_id: shown.id, answers: result.answers },
          });
        }}
      />
      <ApprovalSheet
        permission={card?.kind === "approval" ? { requestId: card.requestId, title: card.detail ?? card.title, options: card.options } : undefined}
        call={{ from, voicePick: pick?.optionId, onHide: hide }}
        onAnswer={(requestId, optionId, deny) => {
          if (!shown || shown.kind !== "approval" || requestId !== shown.requestId) return;
          onHide(shown.id);
          onAnswer?.({
            itemId: shown.id,
            message: { t: "session.permission", sessionId: shown.sessionId, requestId, optionId },
            tell: tappedApprovalText(shown, optionId),
            tool: "answer_permission",
            arguments: { item_id: shown.id, decision: deny ? "deny" : "allow" },
          });
        }}
      />
    </AgentColorProvider>
  );
}

interface EndCardProps {
  visible: boolean;
  call: CallState;
  board: BoardState;
  meta: string;
  onDismiss: () => void;
  onRetry: () => void;
}

/**
 * The call's last word: the app's own sheet (`Sheet`), so it arrives on the
 * same spring, from the same edge, with the same grabber, dotted strip, small
 * Pew and LED label as every other card in the app. Pew's purple stands in
 * for the agent colour (`AgentColorProvider`), as GG Goals does for Ken, so
 * the strip, its Pew and the lit button are Pew's, not the last agent's.
 *
 * Closing it (scrim, grabber, close button, Close) closes the call screen.
 */
function EndCard({ visible, call, board, meta, onDismiss, onRetry }: EndCardProps) {
  const failed = call.phase === "failed";
  const actions = useMemo(() => callActions(call.completed, board.sessions), [call.completed, board.sessions]);
  return (
    <AgentColorProvider value={useContext(VoiceInkContext).ink}>
      <Sheet
        visible={visible}
        label={failed ? "Pew · Couldn't connect" : `Pew · ${meta}`}
        title={failed ? "Call failed" : "Call ended"}
        pewMood={failed ? "oops" : "happy"}
        onClose={onDismiss}
        dismissLabel="Close the call"
      >
        <View style={styles.endBody}>
          {failed ? (
            <Text style={styles.endError}>{call.error ?? "The call couldn't connect."}</Text>
          ) : actions.length > 0 ? (
            <View style={styles.endRows}>
              {actions.slice(-5).map((a, i) => (
                <Dissolve key={`${i}-${a.text}`} kind="row" delay={i * 40}>
                  <View style={styles.endRow}>
                    <DotGlyph name={a.later ? "clock" : "check"} size={16} color={a.later ? theme.color.attention : theme.color.success} />
                    <View style={styles.endRowText}>
                      <Text numberOfLines={1} ellipsizeMode="tail" maxFontSizeMultiplier={ROW_FONT_MAX} style={styles.endRowTitle}>
                        {a.text}
                      </Text>
                      {a.detail ? (
                        <Text numberOfLines={1} ellipsizeMode="tail" maxFontSizeMultiplier={ROW_FONT_MAX} style={styles.endRowDetail}>
                          {a.detail}
                        </Text>
                      ) : null}
                    </View>
                  </View>
                </Dissolve>
              ))}
            </View>
          ) : (
            <Text style={styles.endEmpty}>Nothing needed doing this time.</Text>
          )}
          <View style={styles.endActions}>
            <StageButton style={styles.endButton} kind="secondary" feel="tap" label="Close" onPress={onDismiss} />
            <StageButton style={styles.endButton} kind="primary" feel="sent" label={failed ? "Try again" : "Call again"} onPress={onRetry} />
          </View>
        </View>
      </Sheet>
    </AgentColorProvider>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.color.bg },
  pewStage: { position: "absolute", left: 0, top: 0, width: SOLO_SIZE, height: SOLO_SIZE },
  float: { position: "absolute", width: FLOAT_W, alignItems: "center" },
  // Centred under Pew. Each line's width is fixed by the unseen rest of the
  // page, so centring holds still while words appear.
  soloCaption: { position: "absolute", left: theme.gutter * 2, right: theme.gutter * 2, alignItems: "center", gap: theme.space(2) },
  soloText: { fontSize: theme.font.greeting, lineHeight: theme.line.greeting, fontWeight: "500", textAlign: "center" },
  unrevealed: { color: "transparent" },
  // Left-aligned with the label in the board's caption column, centred under Pew alone.
  waveBox: { alignSelf: "stretch", justifyContent: "center" },
  soloHint: { color: theme.color.textDim, fontSize: theme.font.small, lineHeight: 18 },
  caption: { position: "absolute", left: CAP_LEFT, right: theme.gutter, gap: 4 },
  captionText: { fontSize: theme.font.title, lineHeight: 23, fontWeight: "500" },
  lanes: { position: "absolute", left: LANES_LEFT, right: LANES_RIGHT },
  lane: {
    position: "absolute",
    left: 0,
    right: 0,
    height: LANE_H,
    borderRadius: 18,
    backgroundColor: theme.color.surface,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: theme.stage.dash,
    overflow: "hidden",
  },
  lanePew: { position: "absolute", left: LANE_PEW_LEFT, top: LANE_PEW_TOP, width: LANE_PEW, height: LANE_PEW },
  laneHead: { position: "absolute", left: LANE_TEXT_LEFT, right: 12, top: 14, height: 20, flexDirection: "row", alignItems: "center", gap: theme.space(2) },
  laneName: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "baseline" },
  folder: { flexShrink: 1, color: theme.color.text, fontSize: theme.font.body, lineHeight: 20, fontWeight: "600" },
  agent: { flexShrink: 3, marginLeft: 6, color: theme.color.textDim, fontSize: theme.font.small, lineHeight: 18 },
  status: { flexShrink: 0, flexDirection: "row", alignItems: "center", gap: 6 },
  statusDot: { width: 7, height: 7, borderRadius: 3.5, shadowOpacity: 0.9, shadowRadius: 4, shadowOffset: { width: 0, height: 0 } },
  nowRow: { position: "absolute", left: LANE_TEXT_LEFT, right: 12, top: 42, height: NOW_LINE_H, flexDirection: "row", alignItems: "center", gap: theme.space(2) },
  nowLine: { flex: 1, minWidth: 0, height: NOW_LINE_H },
  // Scaled from its left edge, so the dissolve's hair of scale never nudges the text sideways.
  nowLayer: { position: "absolute", left: 0, right: 0, top: 0, height: NOW_LINE_H, justifyContent: "center", transformOrigin: "0% 50%" },
  steps: { flexShrink: 0 },
  packet: { position: "absolute", left: 0, top: 0, width: 8, height: 8, borderRadius: 4, shadowOpacity: 0.9, shadowRadius: 6, shadowOffset: { width: 0, height: 0 } },
  fold: {
    position: "absolute",
    left: 0,
    maxWidth: "100%",
    height: FOLD_H,
    borderRadius: FOLD_H / 2,
    paddingLeft: 8,
    paddingRight: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: theme.color.surface,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: theme.stage.dash,
  },
  foldFolder: { flexShrink: 1, color: theme.color.glyph, fontSize: theme.font.small, lineHeight: 18 },
  controls: { position: "absolute", left: 0, right: 0, height: CONTROLS_H, paddingHorizontal: 52, flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  /** Holds the third control's place so End stays centred. */
  controlSpacer: { width: 60, height: 60 },
  hangUp: { width: CONTROLS_H, height: CONTROLS_H, borderRadius: CONTROLS_H / 2, backgroundColor: theme.color.danger, alignItems: "center", justifyContent: "center" },
  hangUpPressed: { transform: [{ scale: 0.94 }], opacity: 0.85 },
  endBody: { gap: theme.space(4), paddingBottom: theme.space(2) },
  endRows: { gap: theme.space(2) },
  endRow: { flexDirection: "row", alignItems: "center", gap: theme.space(3), minHeight: 40 },
  endRowText: { flex: 1, minWidth: 0 },
  endRowTitle: { color: theme.color.text, fontSize: theme.font.body, lineHeight: 20 },
  endRowDetail: { color: theme.color.textDim, fontSize: theme.font.small, lineHeight: 17 },
  endEmpty: { color: theme.color.textDim, fontSize: theme.font.body, lineHeight: 20 },
  endError: { color: theme.color.danger, fontSize: theme.font.body, lineHeight: 20 },
  endActions: { flexDirection: "row", gap: theme.space(2) },
  endButton: { flex: 1 },
});
