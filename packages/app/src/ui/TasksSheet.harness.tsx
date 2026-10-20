/**
 * Dev-only harness for the Tasks screen.
 *
 * Opens the real `TasksSheet` over a blank canvas with fixed tasks, so the
 * hero, the task list and the Call/Projects footer can be checked on several
 * phone sizes without a daemon. `EXPO_PUBLIC_VOICE` picks the scene:
 *
 *  - `empty`  (default): no tasks;
 *  - `busy`: one task needing approval, one working, and a few finished;
 *  - `idle`: no tasks, and no call can be placed (no Call Pew button);
 *  - `projects`: the Projects sheet over the `busy` store, the other tall sheet;
 *  - `screenshots`: one active task, and a screenshot in each state: uploading,
 *    waiting to be sent (with its "Send to …" button), sent, and refused;
 *  - `goals`: a goal still setting up (criteria, no milestones), a goal that
 *    needs you (an unmet prerequisite), and a task waiting on a question.
 *    `EXPO_PUBLIC_VOICE_TASK=g1|g2|g3` keeps just that one, because only the
 *    first card fits above the fold on a phone and a simulator can't scroll
 *    from the command line.
 *
 *   EXPO_PUBLIC_HARNESS=TasksSheet EXPO_PUBLIC_VOICE=busy bun run harness
 *
 * A `Sheet`-based harness renders blank on web (see CLAUDE.md); use iOS.
 */
import { useEffect } from "react";
import { View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import * as SplashScreen from "expo-splash-screen";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { theme } from "../theme";
import { TasksSheet } from "./TasksSheet";
import { ProjectDashboard } from "./ProjectDashboard";
import { emptyStore, type VoiceStore } from "../voice/voiceStore";
import type { VoiceTask } from "../voice/types";
import type { ScreenshotCard } from "../voice/screenshots";

const SCENE = process.env.EXPO_PUBLIC_VOICE ?? "empty";
/** Optional: show only this task of the `goals` scene. */
const ONLY_TASK = process.env.EXPO_PUBLIC_VOICE_TASK;
/** Fixture clock: a fixed point so ages read the same on every launch. */
const NOW = Date.now();

function task(id: string, projectName: string, title: string, state: VoiceTask["state"], minutesAgo: number, extra: Partial<VoiceTask> = {}): VoiceTask {
  return {
    taskId: id,
    projectId: projectName,
    projectName,
    title,
    state,
    priority: 0,
    createdAt: NOW - minutesAgo * 60_000,
    updatedAt: NOW - minutesAgo * 30_000,
    ...extra,
  };
}

const BUSY_TASKS: VoiceTask[] = [
  task("t1", "pew2", "Run the daemon tests and fix anything that fails", "blocked", 6, {
    activity: "Wants to run bun test packages/daemon",
    approval: { requestId: "r1", risk: "shell", summary: "Run `bun test packages/daemon` in pew2" },
  }),
  task("t2", "acme-storefront", "Update the checkout copy to the new wording", "running", 3, { activity: "Editing src/checkout/Summary.tsx" }),
  task("t3", "infra", "Bump the Terraform provider", "completed", 40),
  task("t4", "notes", "Summarise yesterday's meeting notes", "verified", 90),
];

const GOAL_TASKS: VoiceTask[] = [
  task("g1", "pew2", "Make voice understand goals", "running", 2, {
    goal: { title: "Voice goals", status: "running", done: 0, total: 0, verified: "none", next: "Write the first milestone" },
  }),
  task("g2", "acme-storefront", "Ship the Stripe checkout", "blocked", 12, {
    goal: {
      title: "Stripe checkout",
      status: "blocked",
      done: 1,
      total: 3,
      verified: "none",
      needsYou: "Add the Stripe test key to the env file",
    },
  }),
  task("g3", "infra", "Move the staging database", "blocked", 5, {
    question: { requestId: "q1", text: "Keep the old database running for a week?", options: ["Yes", "No"] },
  }),
];

const SCENES: Record<string, { store: VoiceStore; callable: boolean }> = {
  empty: { store: emptyStore, callable: true },
  idle: { store: emptyStore, callable: false },
  goals: {
    store: {
      ...emptyStore,
      tasks: Object.fromEntries(GOAL_TASKS.filter((t) => !ONLY_TASK || t.taskId === ONLY_TASK).map((t) => [t.taskId, t])),
    },
    callable: true,
  },
  busy: { store: { ...emptyStore, tasks: Object.fromEntries(BUSY_TASKS.map((t) => [t.taskId, t])) }, callable: true },
};

const SCREENSHOTS: ScreenshotCard[] = [
  { key: "r4", name: "IMG_2041.jpg", status: "uploading", sentTo: [] },
  { key: "r3", attachmentId: "a_3", name: "partner-fix-totals.jpg", status: "held", sentTo: [] },
  { key: "r2", attachmentId: "a_2", name: "IMG_2033.jpg", status: "sent", sentTo: [{ taskId: "t2", title: "Update the checkout copy" }] },
  { key: "r1", name: "Screen Recording.mov", status: "failed", error: "Only pictures can be sent to voice: a PNG, JPEG, HEIC, GIF or WebP screenshot.", sentTo: [] },
];

export default function TasksSheetHarness() {
  useEffect(() => {
    SplashScreen.hideAsync().catch(() => undefined);
  }, []);
  const scene =
    SCENE === "screenshots"
      ? {
          store: { ...emptyStore, tasks: { t2: task("t2", "acme-storefront", "Update the checkout copy", "running", 3, { activity: "Editing src/checkout/Summary.tsx" }) } },
          callable: true,
        }
      : (SCENES[SCENE === "projects" ? "busy" : SCENE] ?? SCENES.empty);
  if (!scene) return null;
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <KeyboardProvider>
        <SafeAreaProvider>
          <StatusBar style="light" />
          <View style={{ flex: 1, backgroundColor: theme.color.bg }}>
            <TasksSheet
              visible={SCENE !== "projects"}
              store={scene.store}
              held={[{ sessionId: "s1", requestId: "r1", options: [] }]}
              onOpenProjects={() => undefined}
              onClose={() => undefined}
              onCall={scene.callable ? () => undefined : undefined}
              onAnswer={() => undefined}
              screenshots={SCENE === "screenshots" ? SCREENSHOTS : []}
              onPickScreenshot={() => undefined}
              onRemoveScreenshot={() => undefined}
              onSendScreenshot={() => undefined}
            />
            <ProjectDashboard visible={SCENE === "projects"} store={scene.store} onClose={() => undefined} />
          </View>
        </SafeAreaProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}
