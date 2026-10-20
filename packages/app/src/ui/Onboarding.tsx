/**
 * First-run onboarding, one step per page (order and resume in `onboarding.ts`).
 *
 * One stage for every step, the same Pew in the same place, with a little
 * show per step (`OnboardingScenes`): alerts popping out of Pew, the computer
 * running `pew2 setup` then `pew2 pair`, which shows the code, Pew and the phone's wave taking
 * turns, the two Pews of the handshake. The words sit right under the stage;
 * the footer keeps its buttons in the same place on every page, with Privacy
 * and Terms at the bottom centre.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { codeBlockStyles } from "./codeBlock";
import { welcomeBeat } from "../pew/homeLife";
import { LaunchPad, usePlainLaunch } from "./GoalLaunchPad";
import { LaunchFx, type LaunchFxValues } from "./LaunchFx";
import type { FxScene } from "../launchFx";
import { sounds } from "./sounds";
import { ONBOARDING_SOUNDS, type SoundName } from "../soundsPolicy";
import { Linking, Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Clipboard from "expo-clipboard";
import { theme } from "../theme";
import { text } from "../appStyles";
import { haptics } from "./haptics";
import { Pew } from "../pew/Pew";
import { PEW_BODY_CY, type PewMood } from "../pew/engine";
import { pewInk } from "../pew/palette";
import { DotGrid } from "./stage/DotGrid";
import { Led } from "./stage/Led";
import { StageButton, STAGE_BUTTON_HEIGHT } from "./stage/StageButton";
import { Dissolve } from "./motion/Dissolve";
import { ScreenHeader, HeaderButton } from "./ScreenHeader";
import { PrivacyLink } from "./PrivacyLink";
import { TermsLink } from "./TermsLink";
import { useAlerts } from "./useAlerts";
import { ensureNotificationPermission } from "./notifier";
import { writeToClipboard } from "./clipboard";
import { ALERTS_LINE, ALERTS_TITLE } from "../notificationAsk";
import { saveAlertsDismissedAt, saveVoiceConsent } from "../preferences";
import { INSTALL_COMMAND, INSTALL_SHOWN, PAIR_COMMAND, SETUP_COMMAND, STEPS, previousStep, stepIndex, type Step } from "../onboarding";
import { DUR, EASE } from "../motion";
import { ALERT_EVERY_MS, PEW_SHIFT, alertsMood, installAt, voiceAt } from "../onboardingScenes";
import { AlertsScene, InstallScene, VoiceScene, useSceneClock } from "./OnboardingScenes";
import { CallingFx } from "./LaunchFx";
import { Handshake } from "./Handshake";
import { QrScanner } from "./QrScanner";
import { usePairing } from "./usePairing";
import type { Pairing } from "../pairingLink";

const CORAL = pewInk();


interface Props {
  step: Step;
  /** Only the Pair page (after a forget): no dots, no back. */
  repair: boolean;
  onNext: () => void;
  onBack: (step: Step) => void;
  onPaired: (pairing: Pairing) => void;
  /** DEVELOPMENT ONLY: jump to any step without saving progress. */
  onDevGo?: (step: Step) => void;
}

/** Push registration waits for a pairing: Pew2Screen hands the token over on connect. */
const NO_PUSH = (): void => {};
const NOT_REGISTERED = { current: true } as const;

export function Onboarding({ step, repair, onNext, onBack, onPaired, onDevGo }: Props) {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const [poked, setPoked] = useState(false);
  const [holding, setHolding] = useState(false);
  const back = previousStep(step, repair);
  const pairing = usePairing(onPaired);
  // Development only: `EXPO_PUBLIC_DEV_SCAN=1` opens the scanner on the Pair step.
  const devScan = __DEV__ && process.env.EXPO_PUBLIC_DEV_SCAN === "1" && step === "pair";
  const openScan = pairing.openScanner;
  useEffect(() => {
    if (devScan) openScan();
    // Once, on the dev flag.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [devScan]);

  // The last step: hold Pew to start, the goal launch's charge and blast.
  const plain = usePlainLaunch();
  const fx: LaunchFxValues = {
    clock: useSharedValue(0),
    charge: useSharedValue(0),
    burst: useSharedValue(-1),
    reveal: useSharedValue(0),
    fade: useSharedValue(1),
  };
  const [scene, setScene] = useState<FxScene>();
  const [launching, setLaunching] = useState(false);
  const fire = () => {
    // The burst is the sound; the pulses are felt under it.
    sounds.play("burst");
    haptics.attention(null);
    setTimeout(() => haptics.sent(null), 90);
    setLaunching(true);
    // Into the app under the blast's cover.
    setTimeout(onNext, BLAST_TO_APP_MS);
  };

  useEffect(() => {
    if (!poked) return;
    const t = setTimeout(() => setPoked(false), 1800);
    return () => clearTimeout(t);
  }, [poked]);

  // The first screen ever: Pew puts on a little show (WELCOME_SHOW).
  const [showAt, setShowAt] = useState(0);
  useEffect(() => {
    if (step !== "welcome") return;
    const t = setTimeout(() => setShowAt((i) => i + 1), welcomeBeat(showAt).ms);
    return () => clearTimeout(t);
  }, [step, showAt]);

  // Each step's little show runs on its own clock, from when the step opened.
  const animated = step === "alerts" || step === "install" || step === "voice";
  const ms = useSceneClock(step, animated);
  const voice = voiceAt(ms);

  // Sounds: every sound onboarding uses, loaded before the first page (the
  // app's own preload only runs once paired), then the scenes' cues, each the
  // moment it happens on screen.
  useEffect(() => {
    sounds.preload(ONBOARDING_SOUNDS);
  }, []);
  // A page arriving: the sheet's breath of air, as the words dissolve in.
  const firstStep = useRef(true);
  useEffect(() => {
    if (firstStep.current) {
      firstStep.current = false;
      return;
    }
    sounds.play("swish-up");
  }, [step]);
  // Notifications: a chime as each banner lands.
  const bannerIndex = step === "alerts" ? Math.floor(ms / ALERT_EVERY_MS) : -1;
  useEffect(() => {
    if (bannerIndex < 0) return;
    sounds.play("banner");
    haptics.poke(null);
  }, [bannerIndex]);
  // Install: a soft key per typed letter, then the code's arrival.
  const typing = step === "install" ? installAt(ms) : undefined;
  const keys = typing ? typing.typed + typing.pairTyped : -1;
  useEffect(() => {
    if (keys <= 0) return;
    sounds.play(`key-${keys % 4}` as SoundName);
  }, [keys]);
  const showsCode = typing?.qr === true;
  useEffect(() => {
    if (showsCode) sounds.play("select");
  }, [showsCode]);
  const linked = typing?.linking === true;
  useEffect(() => {
    if (linked) sounds.play("pairing");
  }, [linked]);
  // Pair: the two Pews linking.
  const pairedNow = pairing.phase === "paired";
  useEffect(() => {
    if (pairedNow) sounds.play("pairing");
  }, [pairedNow]);
  const sceneMood: PewMood =
    step === "welcome"
      ? welcomeBeat(showAt).mood
      : step === "alerts"
        ? alertsMood(ms)
        : step === "install"
          ? installAt(ms).mood
          : step === "voice"
            ? voice.mood
            : step === "done"
              ? "celebrate"
              : "idle";
  const mood: PewMood = holding ? "listening" : poked ? "celebrate" : sceneMood;

  // One stage for every step: the same height, Pew the same size, so moving
  // on never re-seats the screen. Pew glides to make room for each scene.
  // One stage for every step, Pew the same size and dead centre in it.
  // Install carries three commands under its words, so its stage gives up the
  // room they need; the stage height animates with Pew, so nothing jumps.
  const stageH = Math.round(step === "install" ? Math.min(330, Math.max(260, height * 0.34)) : Math.min(380, Math.max(300, height * 0.4)));
  const pewFull = Math.round(Math.min(200, Math.max(160, height * 0.22)));
  // Install's terminal fills the top of the stage: Pew draws smaller there,
  // still dead centre, so its wire has room. The change animates (Pew scales).
  const pew = pewFull;
  const pewScale = step === "install" ? 0.8 : 1;
  const shift = useSharedValue(PEW_SHIFT[step]);
  const ownPew = step === "pair" || step === "done";
  const pewOn = useSharedValue(ownPew ? 0 : 1);
  const size = useSharedValue(pewScale);
  useEffect(() => {
    const [a, b, c, d] = EASE.out;
    shift.value = withTiming(PEW_SHIFT[step], { duration: DUR.dissolve, easing: Easing.bezier(a, b, c, d) });
    pewOn.value = withTiming(ownPew ? 0 : 1, { duration: DUR.dissolve });
    size.value = withTiming(pewScale, { duration: DUR.dissolve, easing: Easing.bezier(a, b, c, d) });
  }, [step, ownPew, pewScale, shift, pewOn, size]);
  // Pew sits low in the stage, just above the words; scenes use the room above.
  const drop = Math.round(stageH * 0.12);
  const pewStyle = useAnimatedStyle(() => ({
    opacity: pewOn.value,
    transform: [{ translateY: shift.value + drop }, { scale: (0.92 + pewOn.value * 0.08) * size.value }],
  }));
  const ink = CORAL;
  const glowCY = stageH / 2 + drop + PEW_SHIFT[step] + (PEW_BODY_CY - 0.5) * pew;

  return (
    <View style={styles.root}>
      <DotGrid />
      <ScreenHeader leading={back ? <HeaderButton glyph="back" label="Back" onPress={() => onBack(back)} /> : null} />
      {repair ? <View style={styles.dotsSpace} /> : <Dots step={step} />}

      <View style={[styles.stage, { height: stageH }]}>
        <CallingFx scene={{ w: width, h: stageH, cx: width / 2, cy: glowCY, kenR: pew * 0.29 }} color={ink} on={step === "welcome"} />
        {step === "alerts" ? <AlertsScene ms={ms} /> : null}
        {step === "install" ? <InstallScene ms={ms} color={ink} /> : null}
        <Animated.View style={[styles.pewSpot, pewStyle]} pointerEvents={ownPew ? "none" : "auto"}>
          <Pew
            size={pew}
            mood={mood}
            color={ink}
            interactive
            onPress={() => setPoked(true)}
            onHold={(phase) => {
              setHolding(phase === "start");
              if (phase === "end") setPoked(true);
            }}
            accessibilityLabel="Pew"
          />
        </Animated.View>
        {step === "voice" ? <VoiceScene userSpeaking={voice.userSpeaking} color={ink} /> : null}
        {step === "pair" ? (
          <Dissolve kind="in" style={styles.handshake}>
            <Handshake phase={pairing.phase} size={Math.round(pew * 0.62)} color={ink} />
          </Dissolve>
        ) : null}
      </View>

      <View style={styles.words}>
        <Dissolve kind="swap" dissolveKey={step} style={styles.page}>
          <Page step={step} onNext={onNext} part="words" pairing={pairing} />
        </Dissolve>
      </View>

      {/* The footer: the same height on every page (two button slots, then
          the legal line's space), so no button sits higher on one step than
          on the next. */}
      <View style={[styles.footer, { paddingBottom: insets.bottom + theme.space(2) }]}>
        <Dissolve kind="swap" dissolveKey={step} style={styles.footerInner}>
          <Page step={step} onNext={onNext} part="actions" pairing={pairing} />
        </Dissolve>
        <Legal />
      </View>

        {step === "done" ? (
          // The last step: the whole screen is the hold area, Pew in its middle
          // where a thumb rests (the goal launch's hold).
          <Dissolve kind="in" style={[styles.launch, { paddingBottom: insets.bottom + theme.space(6) }]}>
            <LaunchPad
              size={Math.round(Math.min(200, width * 0.48))}
              captionBelow
              ready
              pending={launching}
              plain={plain}
              fx={fx}
              color={ink}
              idleMood="celebrate"
              labels={{ idle: "Hold Pew to start", holding: "Keep holding", pending: "Starting", notReady: "" }}
              plainLabel="Open pew2"
              a11yLabel="Hold to open pew2"
              onScene={setScene}
              onFire={fire}
              onLaunch={onNext}
            />
          </Dissolve>
        ) : null}
      {step === "done" && scene && !plain ? <LaunchFx scene={scene} color={ink} values={fx} /> : null}
      {/* DEVELOPMENT ONLY (never in a release build): step through every page,
          the Pair step included, without scanning anything. */}
      {__DEV__ ? (
        <View style={[styles.devNav, { top: insets.top + theme.space(14) }]} pointerEvents="box-none">
          {(["prev", "next"] as const).map((dir) => {
            const i = STEPS.indexOf(step) + (dir === "next" ? 1 : -1);
            const to = STEPS[i];
            return (
              <Pressable
                key={dir}
                disabled={!to}
                onPress={() => to && onDevGo?.(to)}
                style={[styles.devButton, !to && { opacity: 0.3 }]}
                accessibilityLabel={`Dev: ${dir === "next" ? "next" : "previous"} step`}
              >
                <Text style={styles.devText}>{dir === "next" ? "DEV ›" : "‹ DEV"}</Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
      <QrScanner
        visible={pairing.scanning}
        error={pairing.scanError}
        busy={pairing.busy}
        onScan={(value) => void pairing.scanned(value)}
        onClose={pairing.closeScanner}
      />
    </View>
  );
}

function Dots({ step }: { step: Step }) {
  const at = stepIndex(step);
  return (
    <View style={styles.dots} accessibilityRole="progressbar" accessibilityLabel={`Step ${at + 1} of ${STEPS.length}`}>
      {STEPS.map((s, i) => (
        <Dot key={s} on={i === at} done={i < at} />
      ))}
    </View>
  );
}

function Dot({ on, done }: { on: boolean; done: boolean }) {
  const style = useAnimatedStyle(() => ({
    width: withTiming(on ? 18 : 6, { duration: DUR.row }),
    opacity: withTiming(on ? 1 : done ? 0.7 : 0.25, { duration: DUR.row }),
  }));
  return <Animated.View style={[styles.dot, style]} />;
}

/**
 * A page in two parts: its `words` (title and line, right under Pew) and its
 * `actions` (the footer). The footer's buttons fill from the bottom slot up,
 * so the main button is always in the same place.
 */
type PairingFlow = ReturnType<typeof usePairing>;

function Page({ step, onNext, part, pairing }: { step: Step; onNext: () => void; part: "words" | "actions"; pairing: PairingFlow }) {
  switch (step) {
    case "welcome":
      return part === "words" ? (
        <Copy title="pew2" line="Your coding agents, in your pocket." />
      ) : (
        <Actions>
          <StageButton color={CORAL} feel="chosen" label="Get started" onPress={onNext} />
        </Actions>
      );
    case "alerts":
      return <AlertsPage onNext={onNext} part={part} />;
    case "install":
      return <InstallPage onNext={onNext} part={part} />;
    case "voice":
      return part === "words" ? (
        <View style={styles.copy}>
          <Copy title="Voice calls" line="Talk to Pew hands-free about your agents." />
          <Text style={text.subline}>Pew is an AI. Your voice goes to OpenAI.</Text>
        </View>
      ) : (
        <Actions>
          <StageButton kind="secondary" color={CORAL} label="Maybe later" onPress={onNext} />
          <StageButton
            color={CORAL}
            feel="toggleOn"
            label="Turn on"
            onPress={() => {
              void saveVoiceConsent().then(onNext);
            }}
          />
        </Actions>
      );
    case "done":
      // No button: hold Pew (the goal launch's hold, `LaunchPad`).
      return part === "words" ? null : <Actions>{null}</Actions>;
    case "pair":
      return part === "words" ? (
        <View style={styles.copy}>
          <Copy title="Scan your computer" line="Run pew2 pair there, then scan its code." />
          {pairing.phase === "failed" && pairing.error ? (
            <Text style={[text.subline, styles.failed]} numberOfLines={2}>
              {pairing.error}
            </Text>
          ) : null}
        </View>
      ) : (
        <Actions>
          <StageButton
            color={CORAL}
            label={pairing.phase === "paired" ? "Paired" : "Scan QR code"}
            disabled={pairing.busy}
            icon={<Ionicons name="qr-code-outline" size={18} color={CORAL} />}
            onPress={pairing.openScanner}
          />
        </Actions>
      );
  }
}

/**
 * The footer's content. Fixed height: two button slots stacked from the
 * bottom (a lone button takes the lower one), then the legal line, whose
 * space is held on every page so nothing above it moves.
 */
function Actions({ children }: { children: ReactNode }) {
  return <View style={styles.buttons}>{children}</View>;
}

function Copy({ title, line }: { title: string; line?: string }) {
  return (
    <View style={styles.copy}>
      <Text style={text.headline} numberOfLines={1} adjustsFontSizeToFit accessibilityRole="header">
        {title}
      </Text>
      {line ? (
        <Text style={text.subline} numberOfLines={2}>
          {line}
        </Text>
      ) : null}
    </View>
  );
}

/** Privacy · Terms, at the bottom centre of every page. */
function Legal() {
  return (
    <View style={styles.legal}>
      <PrivacyLink />
      <TermsLink />
    </View>
  );
}

function AlertsPage({ onNext, part }: { onNext: () => void; part: "words" | "actions" }) {
  const alerts = useAlerts(NO_PUSH, NOT_REGISTERED);
  const { status, refresh } = alerts;
  if (part === "words") {
    return (
      <View style={styles.copy}>
        <Copy title={ALERTS_TITLE} line={ALERTS_LINE} />
        {status === "granted" ? <Led tone="plus">Alerts on</Led> : null}
      </View>
    );
  }
  return (
    <>
      <Actions>
        {status === "granted" ? (
          <StageButton color={CORAL} label="Next" onPress={onNext} />
        ) : status === "denied" ? (
          <>
            <StageButton kind="secondary" color={CORAL} label="Next" onPress={onNext} />
            <StageButton color={CORAL} label="Open Settings" onPress={() => void Linking.openSettings().catch(() => {})} />
          </>
        ) : (
          <>
            <StageButton
              kind="secondary"
              color={CORAL}
              label="Not now"
              onPress={() => {
                void saveAlertsDismissedAt(Date.now());
                onNext();
              }}
            />
            <StageButton
              color={CORAL}
              disabled={status === undefined}
              label="Allow"
              onPress={() => {
                void ensureNotificationPermission().then((allowed) => {
                  refresh();
                  if (allowed) {
                    haptics.finished();
                    onNext();
                  }
                });
              }}
            />
          </>
        )}
      </Actions>
    </>
  );
}

function InstallPage({ onNext, part }: { onNext: () => void; part: "words" | "actions" }) {
  if (part === "words") {
    return (
      <>
        <Copy title="Install on your computer" line="Run these in a terminal, in order." />
        {/* One code block, a row per command, each with its own Copy. */}
        <View style={[CODE.container, styles.commands]}>
          <Command text={INSTALL_COMMAND} shown={INSTALL_SHOWN} />
          <View style={styles.commandRule} />
          <Command text={SETUP_COMMAND} />
          <View style={styles.commandRule} />
          <Command text={PAIR_COMMAND} />
        </View>
      </>
    );
  }
  return (
    <Actions>
      <StageButton color={CORAL} label="Next" onPress={onNext} />
    </Actions>
  );
}

function Command({ text, shown = text }: { text: string; shown?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <View style={styles.command}>
      <Text style={[CODE.text, styles.commandText]} numberOfLines={1}>
        {shown}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Copy ${text}`}
        hitSlop={8}
        onPress={() => {
          void writeToClipboard(text, Clipboard.setStringAsync).then((ok) => {
            if (!ok) return haptics.failed();
            haptics.select();
            setCopied(true);
            clearTimeout(timer.current);
            timer.current = setTimeout(() => setCopied(false), 1500);
          });
        }}
        style={styles.copyButton}
      >
        <Dissolve kind="swap" dissolveKey={copied ? "y" : "n"}>
          <Led tone={copied ? "plus" : "agent"} color={copied ? undefined : CORAL}>
            {copied ? "Copied" : "Copy"}
          </Led>
        </Dissolve>
      </Pressable>
    </View>
  );
}

/** The chat's code block look, at body size. */
const CODE = codeBlockStyles(theme.font.body, theme.line.body);


/** From the blast to the app: long enough for the cover to fill the screen. */
const BLAST_TO_APP_MS = 650;

const styles = StyleSheet.create({
  // DEVELOPMENT ONLY: the step-through buttons.
  devNav: { position: "absolute", left: theme.space(2), right: theme.space(2), flexDirection: "row", justifyContent: "space-between", zIndex: 10 },
  devButton: { paddingHorizontal: theme.space(3), paddingVertical: theme.space(2), borderRadius: 8, backgroundColor: "rgba(255, 0, 140, 0.85)" },
  devText: { color: "#fff", fontSize: theme.font.small, fontWeight: "700" },
  root: { flex: 1, backgroundColor: theme.color.bg },
  // Above the stage and footer (which are empty on this step), full screen.
  launch: { ...StyleSheet.absoluteFillObject, zIndex: 2 },
  dots: { flexDirection: "row", justifyContent: "center", gap: theme.space(1.5), paddingTop: theme.space(2), height: 6 + theme.space(2) },
  dotsSpace: { height: 6 + theme.space(2) },
  dot: { height: 6, borderRadius: 3, backgroundColor: CORAL },
  // One stage for every step; scenes draw inside it.
  stage: { alignSelf: "stretch", alignItems: "center", justifyContent: "center", marginTop: theme.space(4) },
  pewSpot: { alignItems: "center", justifyContent: "center" },
  handshake: { position: "absolute", left: theme.gutter, right: theme.gutter, top: 0, bottom: 0, justifyContent: "center" },
  // The words sit right under the stage.
  // The words fill the space between stage and footer and never spill into it.
  // Always at least this much air between the words and the buttons.
  words: { flex: 1, minHeight: 0, paddingHorizontal: theme.gutter, paddingTop: theme.space(4), paddingBottom: theme.space(6) },
  page: { alignSelf: "stretch", alignItems: "center" },
  copy: { alignSelf: "stretch", alignItems: "center", gap: theme.space(2) },
  footer: { paddingHorizontal: theme.gutter, gap: theme.space(3) },
  footerInner: { alignSelf: "stretch" },
  // Two button slots, filled from the bottom: the main button never moves.
  buttons: { height: STAGE_BUTTON_HEIGHT * 2 + theme.space(3), justifyContent: "flex-end", gap: theme.space(3) },
  legal: { flexDirection: "row", justifyContent: "center", gap: theme.space(5), minHeight: theme.size.touch, alignItems: "center" },
  commands: { alignSelf: "stretch", marginTop: theme.space(4) },
  commandRule: { height: StyleSheet.hairlineWidth, backgroundColor: theme.color.border, marginHorizontal: theme.space(3) },
  // Compact rows: three commands fit above the footer on every phone.
  command: { flexDirection: "row", alignItems: "center", gap: theme.space(3), minHeight: theme.size.touch, paddingLeft: theme.space(3), paddingRight: theme.space(1) },
  commandText: { flex: 1 },
  copyButton: { minHeight: theme.size.touch, minWidth: theme.size.touch, alignItems: "center", justifyContent: "center" },
  failed: { color: theme.color.danger },
});
