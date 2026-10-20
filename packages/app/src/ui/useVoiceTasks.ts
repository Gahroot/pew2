/**
 * React side of voice tasks: owns the task controller, the Tasks screen's open
 * state, cursor persistence and catch-up on reconnect, and the screenshot
 * picker. Pew's call is `useVoice.ts`; the two share only the daemon socket.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { loadVoiceCursor, saveVoiceCursor } from "../preferences";
import { emptyStore } from "../voice/voiceStore";
import type { ScreenshotCard } from "../voice/screenshots";
import { pickPhotos } from "./attachmentPicker";
import { createTaskController, type DismissRequest, type TaskController, type TasksView } from "./taskController";

interface Options {
  post: (message: Record<string, unknown>) => boolean;
  online: boolean;
}

export function useVoiceTasks({ post, online }: Options) {
  const [view, setView] = useState<TasksView>({ store: emptyStore, screenshots: [] });
  const [sheetOpen, setSheetOpen] = useState(false);
  const postRef = useRef(post);
  postRef.current = post;
  const controller = useRef<TaskController | null>(null);

  const get = (): TaskController => {
    controller.current ??= createTaskController({ send: (m) => postRef.current(m), onChange: setView });
    return controller.current;
  };

  // Cursor: restore once, persist on change.
  useEffect(() => {
    void loadVoiceCursor().then((c) => get().restore(c.cursor, c.heardEventId));
  }, []);
  useEffect(() => {
    if (view.store.cursor > 0) {
      void saveVoiceCursor({ cursor: view.store.cursor, heardEventId: view.store.heardEventId });
    }
  }, [view.store.cursor, view.store.heardEventId]);

  // Catch up whenever the socket comes back, and when a gap was seen.
  useEffect(() => {
    if (online) get().sync();
  }, [online]);
  useEffect(() => {
    if (online && view.store.needsSync) get().sync();
  }, [online, view.store.needsSync]);

  // Whatever arrives while the Tasks screen is open has been seen.
  useEffect(() => {
    if (sheetOpen) get().heard();
  }, [sheetOpen, view.store.cursor]);

  /**
   * Pick one screenshot and upload it. Uses the chat composer's picker, so it
   * is downscaled to a vision model's working size before its bytes are read.
   * One at a time: each is something to say where it goes.
   */
  const pickingRef = useRef(false);
  const pickScreenshot = useCallback(async () => {
    if (pickingRef.current) return;
    pickingRef.current = true;
    try {
      const outcome = await pickPhotos(1);
      if (outcome.status === "picked") {
        for (const file of outcome.attachments) get().attachScreenshot(file);
      } else if (outcome.status === "denied" || outcome.status === "error") {
        get().screenshotFailed("Screenshot", outcome.message);
      }
    } finally {
      pickingRef.current = false;
    }
  }, []);

  const onFrame = useCallback((message: unknown) => {
    if (message && typeof message === "object") get().handleMessage(message as Record<string, unknown>);
  }, []);

  return {
    view,
    sheetOpen,
    open: useCallback(() => setSheetOpen(true), []),
    close: useCallback(() => setSheetOpen(false), []),
    /** Every decoded frame; only task messages are acted on. */
    onFrame,
    /** Opens the photo picker and uploads what is chosen. Fire-and-forget: failures become a card. */
    pickScreenshot: useCallback(() => void pickScreenshot(), [pickScreenshot]),
    removeScreenshot: useCallback((card: ScreenshotCard) => get().removeScreenshot(card), []),
    sendScreenshot: useCallback((attachmentId: string, taskId: string) => get().sendScreenshot(attachmentId, taskId), []),
    /** Clears finished tasks here and on every other screen; see `taskController.dismiss`. */
    dismiss: useCallback((request: DismissRequest) => get().dismiss(request), []),
    /** On unpair: forget everything tied to that machine. */
    clear: useCallback(() => get().clear(), []),
  };
}
