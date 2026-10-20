/**
 * The main screen's nav: menu, title, the goal controls or new-conversation
 * button, the ticker and a goal's crew, over the frosted cover for its zone.
 */
import { useState, type Dispatch, type SetStateAction } from "react";
import { Text, View } from "react-native";
import type { EdgeInsets } from "react-native-safe-area-context";
import { theme } from "../theme";
import { styles } from "../appStyles";
import type { Provider, useDaemon } from "../useDaemon";
import type { useGoalControls } from "../useGoalControls";
import { CircleButton } from "./controls";
import { DotGlyph } from "./stage/DotGlyph";
import { Ticker } from "./Ticker";
import { Dissolve } from "./motion/Dissolve";
import { CrewRow } from "./CrewRow";
import { CanvasCover } from "./CanvasCover";
import { topBarRight } from "./topBarRight";
import { PEW_VOICE_COLOR } from "../pew/palette";

export function ScreenTopBar({
  daemon,
  goals,
  insets,
  navHeight,
  setNavHeight,
  setMenuOpen,
  onNewChat,
  onHome,
  sessionTitle,
  inThread,
  holdingRestore,
  active,
  onTalk,
  onTalkHold,
  talkArmed = false,
  onTasks,
  tasksNeedYou = false,
}: {
  daemon: ReturnType<typeof useDaemon>;
  goals: ReturnType<typeof useGoalControls>;
  insets: EdgeInsets;
  navHeight: number;
  setNavHeight: Dispatch<SetStateAction<number>>;
  setMenuOpen: Dispatch<SetStateAction<boolean>>;
  onNewChat: () => void;
  /** Back to the home dashboard, from a conversation not yet started. Absent hides it. */
  onHome?: () => void;
  sessionTitle: string;
  inThread: boolean;
  holdingRestore: boolean;
  active: Provider | undefined;
  /** Start a call with Pew; absent hides the button (no voice on this daemon). */
  onTalk?: () => void;
  /** Hold Talk: the voice settings, where this conversation can be armed to ring. */
  onTalkHold?: () => void;
  /** This conversation may ring the phone: a dot in Pew's colour on Talk. */
  talkArmed?: boolean;
  /** Open the Tasks screen. Pass it on home only; it sits beside Talk there. */
  onTasks?: () => void;
  /** A task is waiting on them: a dot on Tasks. */
  tasksNeedYou?: boolean;
}) {
  const { inGoal, goalPaused, goalId, resumeGoal, pauseGoal, openGoalSettings, askHere, kenSays, goalState } = goals;
  // The ticker's step list drops over the crew row, which is drawn after it
  // and so on top: the row fades out while the list is open.
  const [stepsOpen, setStepsOpen] = useState(false);
  // What sits right of the title (`topBarRight.ts`): a goal's two, or Talk
  // beside compose, the way home or Tasks.
  const right = topBarRight({ inGoal, inThread, talk: onTalk !== undefined, backHome: onHome !== undefined, tasks: onTasks !== undefined });
  const twoRight = inGoal || right.length > 1;
  return (
    <>
      {/* Absolute over the thread: messages scroll beneath the nav and fade
          out under the CanvasCover instead of hitting a panel edge, so the
          conversation keeps the full screen height. */}
      <View
        style={[styles.topBarOverlay, { top: insets.top }]}
        onLayout={(e) => setNavHeight(e.nativeEvent.layout.height)}
      >
      <View style={styles.topBar}>
        {/* Both sides the same fixed width, sized for the wider one, so the
            title is centred on the screen and is what gives way: it truncates
            instead of pushing a button off the edge. Two controls on the right
            in a goal, and in a thread when voice adds Talk beside compose. */}
        <View style={twoRight ? [styles.navActionsGoal, styles.navLeadGoal] : styles.navAction}>
          {/* The dot below is pinned to this box, so it stays on the menu
              button however wide the side it sits in is. */}
          <View>
          <CircleButton
            label={`Open menu. Daemon ${daemon.status}.`}
            onPress={() => setMenuOpen(true)}
          >
            <DotGlyph name="menu" size={16} />
          </CircleButton>
          {/* Connection state as a dot on the menu button: always visible, but
              it never competes with the model name for space. */}
          {daemon.status !== "online" && (
            <View
              style={[
                styles.statusDot,
                {
                  backgroundColor:
                    daemon.status === "connecting"
                      ? theme.color.accent
                      : theme.color.danger,
                },
              ]}
            />
          )}
          </View>
        </View>

        {/* Re-keyed per title: opening a chat swaps the name in rather than cutting. */}
        <Dissolve kind="swap" dissolveKey={sessionTitle} style={titleBox}>
        <Text
          // The wrapper takes the row's `flex: 1`; inside its column the title's
          // own `flex: 1` would size it from zero height and pin it to the top.
          style={[styles.sessionTitle, titleText]}
          numberOfLines={1}
          ellipsizeMode="tail"
          accessibilityRole="header"
          accessibilityLabel={sessionTitle}
        >
          {sessionTitle}
        </Text>
        </Dissolve>

        <View style={twoRight ? styles.navActionsGoal : styles.navAction}>
        {inGoal ? (
          // A goal is one long conversation, so there is no "new conversation"
          // here: its two controls take the spot instead of a card over the thread.
          <>
            <CircleButton
              label={goalPaused ? "Resume goal" : "Pause goal"}
              disabled={!goalId}
              onPress={goalPaused ? resumeGoal : pauseGoal}
            >
              <DotGlyph name={goalPaused ? "play" : "pause"} size={14} />
            </CircleButton>
            <CircleButton label="Goal settings" disabled={!goalId} onPress={openGoalSettings}>
              <DotGlyph name="gear" size={16} />
            </CircleButton>
          </>
        ) : (
          <>
          {onTalk && right.includes("talk") && (
            <View>
              <CircleButton
                label={talkArmed ? "Talk to Pew. This conversation rings you when it needs you." : "Talk to Pew"}
                onPress={onTalk}
                onLongPress={onTalkHold}
              >
                <DotGlyph name="call" size={16} />
              </CircleButton>
              {talkArmed && <View pointerEvents="none" style={[styles.statusDot, { backgroundColor: PEW_VOICE_COLOR }]} />}
            </View>
          )}
          {right.includes("compose") && (
          // Asks where, rather than starting one immediately: the old behaviour
          // always landed wherever the agent happened to be, which is the wrong
          // project as often as the right one and was unfixable from the phone.
          <CircleButton label="New conversation" onPress={onNewChat}>
            <DotGlyph name="compose" size={16} />
          </CircleButton>
          )}
          {onHome && right.includes("home") && (
          <CircleButton label="Back to home" onPress={onHome}>
            <DotGlyph name="close" size={14} />
          </CircleButton>
          )}
          {onTasks && right.includes("tasks") && (
            <View>
              <CircleButton label={tasksNeedYou ? "Tasks. One needs you." : "Tasks"} onPress={onTasks}>
                <DotGlyph name="tasks" size={16} />
              </CircleButton>
              {tasksNeedYou && <View pointerEvents="none" style={[styles.statusDot, { backgroundColor: theme.color.danger }]} />}
            </View>
          )}
          </>
        )}
        </View>
      </View>
      {/* Not while a chat is reopening: that screen is Pew alone, centred,
          and the ticker fades in with the messages once they've loaded. */}
      {(inThread || daemon.restoreTarget) && !(daemon.restoreTarget && daemon.loadingSession && (daemon.turns.length === 0 || holdingRestore)) && (
        // Mounts with the transcript, so it dissolves in on the same beat.
        <Dissolve>
        <Ticker
          color={active?.color}
          working={daemon.busy && !daemon.loadingSession}
          activity={daemon.activity}
          needs={daemon.permission ? daemon.permission.title : askHere ? "Question" : undefined}
          offline={daemon.status !== "online" || Boolean(daemon.unreachable)}
          project={daemon.workspace?.folder}
          changes={daemon.workspace?.uncommitted}
          say={kenSays?.text}
          onOpenChange={setStepsOpen}
        />
        </Dissolve>
      )}
      {/* A goal's crew: one slidable row of its workers under the ticker, each
          its own Pew in its role colour. Inside the measured overlay, so the
          thread starts below it. */}
      {inGoal && goalState && !daemon.restoreTarget && <CrewRow workers={goalState.workers} hidden={stepsOpen} />}
      </View>

      {/* Frosted cover for the nav zone only — it ends exactly at the nav's
          bottom edge and touches nothing below it. pointerEvents-none, so it
          never swallows a tap on a message or a pill. */}
      {navHeight > 0 && (
        <CanvasCover
          // From the very top edge to the nav's bottom edge. No tail.
          height={insets.top + navHeight}
          style={styles.navFade}
        />
      )}
    </>
  );
}

const titleBox = { flex: 1, minWidth: 0, justifyContent: "center" } as const;
const titleText = { flex: 0, alignSelf: "stretch" } as const;
