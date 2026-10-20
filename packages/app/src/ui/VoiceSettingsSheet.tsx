/**
 * Voice: whose OpenAI login calls use, the sign-in when there is none, and
 * when Pew may ring (Off / Notify / On the go).
 *
 * The login is found, not asked for. The daemon uses one an agent on the
 * computer already has (GG Coder, then Codex) and only falls back to pew2's
 * own sign-in when none does: a Claude Code-only machine, say. The status
 * line names whose login is in use; text here is kept to a line at most.
 *
 * The sign-in never asks for anything to be typed on the computer: the daemon
 * starts it, this shows the code big, and the `voice.status` broadcast that
 * follows a redeemed code flips the sheet to signed in on its own.
 *
 * Opened from Talk (`forCall`), it is the step before the call: it starts the
 * sign-in by itself, and once a login exists it offers the call, behind a
 * one-time consent that names OpenAI and says Pew is an AI.
 *
 * Ringing: one switch with a duration (it turns itself off), then the
 * conversations allowed to ring (armed), quiet hours, and arming every new
 * conversation. The rules themselves run on the computer (`voiceRing.ts`).
 */
import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import * as WebBrowser from "expo-web-browser";
import * as Clipboard from "expo-clipboard";
import { theme } from "../theme";
import { withAlpha } from "../motion";
import { PEW_VOICE_COLOR } from "../pew/palette";
import type { wire } from "@pew2/protocol";
import { DEVICE_CODE_NOTE, voiceStatusLine, type VoiceKnowledge } from "../voiceCall";
import {
  RING_CHOICES,
  RING_SCOPES,
  VOICE_CONSENT_LINE,
  armedCount,
  armingSupported,
  isArmed,
  ringPatch,
  ringScope,
  ringing,
  scopeSupported,
  selectedRing,
  type RingScope,
} from "../voiceRing";
import { RING_NEEDS_ALERTS } from "../notificationAsk";
import { Sheet } from "./Sheet";
import { StageScroll } from "./stage/StageScroll";
import { StageButton } from "./stage/StageButton";
import { DashedRule } from "./stage/DashedRule";
import { Led } from "./stage/Led";
import { DotGlyph } from "./stage/DotGlyph";
import { AgentColorProvider } from "./stage/agentColor";
import { Dissolve } from "./motion/Dissolve";
import { haptics } from "./haptics";

interface Props {
  visible: boolean;
  knowledge: VoiceKnowledge;
  onClose: () => void;
  onLogin: (action: "start" | "cancel" | "logout") => void;
  onPrefs: (prefs: Partial<wire.VoicePrefsValues>) => void;
  onArm: (sessionId: string, on: boolean) => void;
  /** Forget what was said on earlier calls (kept per chat on the computer). Absent: no button. */
  onForget?: () => void;
  /** The open conversation, which gets its own "ring me" row. */
  sessionId?: string;
  /** Opened from Talk: the sign-in starts by itself, and a ready login offers the call. */
  forCall?: boolean;
  /** Start the call (shown once a login exists, when opened from Talk). */
  onCall?: () => void;
  /** The user already agreed to the consent line; false shows it before "Call Pew". */
  consented: boolean;
  /** Choosing to be rung is agreeing too (the line shows under the choices until then). */
  onAgree?: () => void;
  /** Notifications allowed; without them a ring has nothing to arrive by. */
  alertsGranted?: boolean;
  /** Run the alerts card; resolves whether they ended up allowed. */
  onNeedAlerts?: () => Promise<boolean>;
}

/** One of a radio pair, in the Ring me choices' style. */
function ScopeChoice({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected: on }}
      accessibilityLabel={`Ring for: ${label}`}
      onPress={() => {
        if (on) return;
        haptics.select();
        onPress();
      }}
      style={[styles.mode, styles.choice, on && styles.modeOn]}
    >
      <Text style={[styles.modeLabel, styles.choiceLabel, on && { color: theme.color.text }]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

/** A dashed row that turns solid in Pew's colour when on: a toggle in the stage style. */
function ToggleRow({ label, a11y, on, onPress }: { label: string; a11y: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: on }}
      accessibilityLabel={a11y}
      onPress={() => {
        if (on) haptics.toggleOff();
        else haptics.toggleOn();
        onPress();
      }}
      style={[styles.mode, styles.toggle, on && styles.modeOn]}
    >
      <Text style={[styles.modeLabel, styles.toggleText, on && { color: theme.color.text }]} numberOfLines={1}>
        {label}
      </Text>
      <View style={[styles.knob, on && styles.knobOn]}>{on ? <DotGlyph name="check" size={12} color={theme.color.bg} /> : null}</View>
    </Pressable>
  );
}

export function VoiceSettingsSheet({
  visible,
  knowledge,
  onClose,
  onLogin,
  onPrefs,
  onArm,
  onForget,
  sessionId,
  forCall = false,
  onCall,
  consented,
  onAgree,
  alertsGranted = true,
  onNeedAlerts,
}: Props) {
  // A ring was refused for want of alerts: say so under the choices.
  const [ringBlocked, setRingBlocked] = useState(false);
  // Forgotten this time the sheet is open: the button says so, once.
  const [forgotten, setForgotten] = useState(false);
  useEffect(() => {
    if (visible) setForgotten(false);
  }, [visible]);
  const status = knowledge.kind === "known" ? knowledge.status : undefined;
  const login = status?.login;
  const prefs = status?.prefs;
  const ready = status?.available === true;
  // The clock for "time left": re-read with each status and twice a minute while open.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!visible) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [visible, status]);
  const selected = selectedRing(prefs, now);
  const scope = ringScope(prefs);
  const ringsNow = ringing(prefs, now);
  const arming = armingSupported(status);
  const thisArmed = isArmed(status, sessionId, now);
  const armed = armedCount(status, now);
  const needsSignIn = status !== undefined && !ready && status.canLogin === true;

  // From Talk with no login anywhere: the code is what the user came for, so
  // ask for it straight away rather than behind one more button. Once per open.
  const started = useRef(false);
  useEffect(() => {
    if (!visible) {
      started.current = false;
      return;
    }
    if (forCall && needsSignIn && !login && !started.current) {
      started.current = true;
      onLogin("start");
    }
  }, [visible, forCall, needsSignIn, login, onLogin]);

  // The moment a sign-in lands while it is open, say so.
  const wasReady = useRef(ready);
  useEffect(() => {
    if (visible && ready && !wasReady.current) haptics.finished();
    wasReady.current = ready;
  }, [visible, ready]);

  return (
    <AgentColorProvider value={PEW_VOICE_COLOR}>
      <Sheet
        visible={visible}
        label={forCall ? "Pew · Voice" : "Voice"}
        pewMood={ready ? "happy" : login ? "thinking" : "idle"}
        title={forCall && !ready ? "Sign in to talk to Pew" : "Calls with Pew"}
        titleAccessory={
          ready ? (
            <View style={styles.pill} accessible accessibilityLabel="Connected with OpenAI">
              <DotGlyph name="check" size={10} color={theme.color.success} />
              <Led tone="dim" size={10} numberOfLines={1}>
                Connected with OpenAI
              </Led>
            </View>
          ) : undefined
        }
        onClose={onClose}
        dismissLabel="Close voice"
      >
        <StageScroll style={styles.scroll} contentContainerStyle={styles.content}>
          {ready ? null : (
            <Text style={styles.status}>{status ? voiceStatusLine(status) : "Asking your computer…"}</Text>
          )}

          {ready && forCall && onCall ? (
            <Dissolve kind="swap" style={styles.consent}>
              <StageButton label={consented ? "Call Pew" : "Agree and call"} feel="sent" onPress={onCall} />
              {consented ? null : <Text style={[styles.note, styles.consentLine]}>{VOICE_CONSENT_LINE}</Text>}
            </Dissolve>
          ) : null}

          {login ? (
            <Dissolve kind="swap" style={styles.login}>
              <Led tone="dim">Your code</Led>
              <Text selectable style={styles.code} numberOfLines={1} adjustsFontSizeToFit accessibilityLabel={`Sign-in code ${login.userCode.split("").join(" ")}`}>
                {login.userCode}
              </Text>
              <StageButton
                label="Open sign-in page"
                onPress={() => void WebBrowser.openBrowserAsync(login.verificationUrl).catch(() => {})}
              />
              <View style={styles.row}>
                <StageButton
                  compact
                  kind="secondary"
                  style={styles.rowButton}
                  label="Copy code"
                  onPress={() => {
                    haptics.select();
                    void Clipboard.setStringAsync(login.userCode);
                  }}
                />
                <StageButton compact kind="secondary" style={styles.rowButton} label="Cancel" onPress={() => onLogin("cancel")} />
              </View>
              <Text style={styles.note}>{DEVICE_CODE_NOTE}</Text>
            </Dissolve>
          ) : needsSignIn ? (
            <View style={styles.buttons}>
              <StageButton label="Sign in to OpenAI" onPress={() => onLogin("start")} />
              <Text style={styles.note}>{DEVICE_CODE_NOTE}</Text>
            </View>
          ) : status?.source === "pew2" ? (
            <StageButton compact kind="secondary" label="Sign out" onPress={() => onLogin("logout")} />
          ) : null}


          {prefs && !(forCall && !ready) ? (
            <>
              <DashedRule />
              <Led tone="dim">Ring me</Led>
              <View style={styles.choices} accessibilityRole="radiogroup">
                {RING_CHOICES.map((option) => {
                  const on = option.choice === selected;
                  return (
                    <Pressable
                      key={option.choice}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: on }}
                      accessibilityLabel={`Ring me: ${option.label}`}
                      onPress={() => {
                        haptics.select();
                        const pick = () => {
                          if (option.choice !== "off") onAgree?.();
                          onPrefs(ringPatch(option.choice, Date.now()));
                        };
                        if (option.choice === "off" || alertsGranted || !onNeedAlerts) {
                          pick();
                          return;
                        }
                        void onNeedAlerts().then((allowed) => {
                          setRingBlocked(!allowed);
                          if (allowed) pick();
                        });
                      }}
                      style={[styles.mode, styles.choice, on && styles.modeOn]}
                    >
                      <Text style={[styles.modeLabel, styles.choiceLabel, on && { color: theme.color.text }]} numberOfLines={1}>
                        {option.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              {ringBlocked && !alertsGranted && onNeedAlerts ? (
                <Pressable accessibilityRole="button" hitSlop={8} onPress={() => { haptics.tap(); void onNeedAlerts().then((allowed) => setRingBlocked(!allowed)); }}>
                  <Text style={[styles.note, styles.consentLine, styles.alertsLink]}>{RING_NEEDS_ALERTS}</Text>
                </Pressable>
              ) : null}
              {consented || (forCall && ready) ? null : (
                <Text style={[styles.note, styles.consentLine]}>{VOICE_CONSENT_LINE}</Text>
              )}
              {ringsNow && scopeSupported(prefs) ? (
                <>
                  <Led tone="dim">Ring for</Led>
                  <View style={styles.choices} accessibilityRole="radiogroup">
                    {RING_SCOPES.map((option) => (
                      <ScopeChoice key={option.scope} label={option.label} on={option.scope === scope} onPress={() => onPrefs({ ringScope: option.scope as RingScope })} />
                    ))}
                  </View>
                </>
              ) : null}
              {arming && sessionId && (scope === "chosen" || !scopeSupported(prefs)) ? (
                <ToggleRow
                  label="This chat rings me"
                  a11y="This conversation rings me when it needs me"
                  on={thisArmed}
                  onPress={() => onArm(sessionId, !thisArmed)}
                />
              ) : null}
              {armed > 0 && status?.armed && (scope === "chosen" || !scopeSupported(prefs)) ? (
                <StageButton
                  compact
                  kind="secondary"
                  label={armed === 1 ? "Stop 1 chat ringing" : `Stop ${armed} chats ringing`}
                  onPress={() => {
                    for (const entry of status.armed ?? []) onArm(entry.sessionId, false);
                  }}
                />
              ) : null}
            </>
          ) : null}

          {onForget && ready && !forCall ? (
            <StageButton
              compact
              kind="secondary"
              label={forgotten ? "Call history forgotten" : "Forget call history"}
              disabled={forgotten}
              onPress={() => {
                haptics.select();
                onForget();
                setForgotten(true);
              }}
            />
          ) : null}

        </StageScroll>
      </Sheet>
    </AgentColorProvider>
  );
}

const styles = StyleSheet.create({
  scroll: { flexGrow: 0, maxHeight: 560 },
  content: { gap: theme.space(3), paddingBottom: theme.sectionGap },
  status: { color: theme.color.text, fontSize: theme.font.body, lineHeight: 20 },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(1.5),
    height: 24,
    paddingHorizontal: theme.space(2.5),
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: withAlpha(theme.color.success, 0.45),
    backgroundColor: withAlpha(theme.color.success, 0.08),
    flexShrink: 0,
    marginLeft: theme.space(2),
  },
  login: { gap: theme.space(3), alignItems: "stretch" },
  code: {
    color: theme.color.text,
    fontSize: 40,
    lineHeight: 48,
    letterSpacing: 4,
    fontVariant: ["tabular-nums"],
    textAlign: "center",
    fontWeight: "600",
  },
  buttons: { gap: theme.space(2) },
  row: { flexDirection: "row", gap: theme.space(2) },
  rowButton: { flex: 1 },
  note: { color: theme.color.textDim, fontSize: theme.font.small, lineHeight: 18 },
  consent: { gap: theme.space(2) },
  consentLine: { textAlign: "center" },
  alertsLink: { color: theme.color.accent },
  choices: { flexDirection: "row", flexWrap: "wrap", gap: theme.space(2) },
  choice: { flexBasis: "47%", flexGrow: 1, alignItems: "center", paddingVertical: theme.space(2) },
  choiceLabel: { textAlign: "center" },
  toggle: { flexDirection: "row", alignItems: "center", gap: theme.space(3) },
  toggleText: { flex: 1, gap: 2 },
  knob: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: theme.stage.dash,
    alignItems: "center",
    justifyContent: "center",
  },
  knobOn: { borderStyle: "solid", borderColor: PEW_VOICE_COLOR, backgroundColor: PEW_VOICE_COLOR },
  mode: {
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: theme.stage.dash,
    borderRadius: theme.radius.md,
    padding: theme.space(3),
    gap: 2,
  },
  modeOn: { borderStyle: "solid", borderColor: PEW_VOICE_COLOR, backgroundColor: withAlpha(PEW_VOICE_COLOR, 0.1) },
  modeLabel: { color: theme.color.textDim, fontSize: theme.font.body, lineHeight: 20 },
});
