/**
 * Voice tasks on the phone: the task list the daemon broadcasts, the
 * screenshots held for them, and the sends and dismissals made from the Tasks
 * screen. A plain object rather than a hook so its lifetime is explicit;
 * `useVoiceTasks.ts` wraps it for React.
 *
 * The call itself is not here: that is `useVoice.ts` (Pew's call). The call
 * hears task news from the daemon (`voice.note`), so nothing here talks to it.
 *
 * All decisions are in `../voice/*`; this file only wires them.
 */
import { wire } from "@pew2/protocol";
import { emptyStore, finishedTaskIds, reduce, type StoreAction, type VoiceStore } from "../voice/voiceStore";
import { readHeld, screenshotCards, type HeldScreenshot, type ScreenshotCard, type Upload } from "../voice/screenshots";
import type { PendingAttachment } from "../attachments";

export interface TasksView {
  store: VoiceStore;
  /** Screenshots shared for tasks, newest first. */
  screenshots: ScreenshotCard[];
}

export interface TaskDeps {
  /** Sends one sealed message to the daemon; false when not connected. */
  send(message: Record<string, unknown>): boolean;
  /** Called after every change. */
  onChange(view: TasksView): void;
  /** Request ids, injectable so tests are deterministic. */
  newId?: () => string;
  now?: () => number;
}

type Message = Record<string, unknown>;

/** A `voice.dismiss`, as the Tasks screen or the dashboard asks for it. */
export interface DismissRequest {
  taskIds: string[];
  projectIds?: string[];
  allFinished?: boolean;
}

const stringList = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((v) => typeof v === "string") ? value : undefined;

const UNREACHABLE = "Your computer is not reachable right now. Try again when it is.";

export function createTaskController(deps: TaskDeps) {
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? (() => `${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  let store: VoiceStore = emptyStore;
  /** Screenshots: uploads in flight, what the computer holds, and which phone file became which. */
  let uploads: Upload[] = [];
  let held: HeldScreenshot[] = [];
  let localUris: Record<string, { localUri?: string; key: string }> = {};
  /** Dismissals made while the computer was unreachable, sent once it answers again. */
  let pendingDismissals: DismissRequest[] = [];
  /** Sends from the Tasks screen waiting on their answer: requestId -> what was sent. */
  const sends = new Map<string, { attachmentId: string }>();

  const view = (): TasksView => ({ store, screenshots: screenshotCards(uploads, held, localUris, store.tasks) });
  const publish = () => deps.onChange(view());

  function fold(action: StoreAction): void {
    store = reduce(store, action);
    publish();
  }

  /** A refused upload or send, shown as a card with the reason. */
  function failedCard(key: string, name: string, error: string): void {
    uploads = [{ requestId: key, name, status: "failed", error, at: now() }, ...uploads];
  }

  return {
    view,
    fold,

    /**
     * Upload a picked screenshot. The card shows at once; the daemon's answer
     * turns it into a held screenshot, or a reason it was refused.
     */
    attachScreenshot(file: PendingAttachment): void {
      const requestId = `shot-${newId()}`;
      const sent = deps.send({ t: "voice.attach", requestId, name: file.name, mimeType: file.mimeType, data: file.data });
      uploads = [
        {
          requestId,
          name: file.name,
          ...(file.localUri ? { localUri: file.localUri } : null),
          status: sent ? "uploading" : "failed",
          ...(sent ? null : { error: UNREACHABLE }),
          at: now(),
        },
        ...uploads,
      ];
      publish();
    },
    /** A picker that could not open or read the file, shown as a refused card. */
    screenshotFailed(name: string, error: string): void {
      failedCard(`failed-${newId()}`, name, error);
      publish();
    },
    /** Remove a card: a refused upload here, or a held screenshot on the computer too. */
    removeScreenshot(card: Pick<ScreenshotCard, "key" | "attachmentId">): void {
      uploads = uploads.filter((u) => u.requestId !== card.key);
      if (card.attachmentId) {
        deps.send({ t: "voice.detach", attachmentId: card.attachmentId });
        held = held.filter((h) => h.attachmentId !== card.attachmentId);
      }
      publish();
    },
    /** Send a held screenshot to a task; the daemon runs the same tool a call would. */
    sendScreenshot(attachmentId: string, taskId: string): void {
      const requestId = `send-${newId()}`;
      if (!deps.send({ t: "voice.send", requestId, attachmentId, taskId })) {
        const shot = held.find((h) => h.attachmentId === attachmentId);
        failedCard(requestId, shot?.name ?? "Screenshot", UNREACHABLE);
        publish();
        return;
      }
      sends.set(requestId, { attachmentId });
    },

    /**
     * Clear finished tasks off the screen, and off every other one. Shown gone
     * at once; the daemon persists it and tells every client. Unreachable, it
     * waits and goes with the next catch-up, so a tap is never lost.
     */
    dismiss(request: DismissRequest): void {
      if (!store.canDismiss) return;
      const taskIds = request.allFinished
        ? [...new Set([...request.taskIds, ...finishedTaskIds(store)])].sort()
        : request.taskIds;
      const message = { ...request, t: "voice.dismiss", taskIds };
      // Later, only what was on screen: "all" or a whole project then could
      // take something that finished since, which nobody has read.
      if (!deps.send(message)) pendingDismissals = [...pendingDismissals, { taskIds }];
      fold({ type: "dismissed", taskIds });
    },

    restore(cursor: number, heardEventId: number): void {
      fold({ type: "restore", cursor, heardEventId });
    },
    /** Everything shown has been seen (the Tasks screen is open). */
    heard(): void {
      fold({ type: "heard", eventId: store.cursor });
    },
    /** On unpair: forget everything tied to that machine. */
    clear(): void {
      uploads = [];
      held = [];
      localUris = {};
      pendingDismissals = [];
      sends.clear();
      store = reduce(store, { type: "clear" });
      publish();
    },
    /** Asks the daemon for what this phone missed. */
    sync(): void {
      deps.send({ t: "voice.sync", since: store.cursor });
    },

    /** Every task message from the daemon; anything else is ignored. */
    handleMessage(message: Message): void {
      switch (message.t) {
        case "voice.attached": {
          const upload = uploads.find((u) => u.requestId === message.requestId);
          if (!upload) return;
          const attachment = message.ok === true ? readHeld([message.attachment])?.[0] : undefined;
          if (attachment) {
            uploads = uploads.filter((u) => u.requestId !== message.requestId);
            localUris = { ...localUris, [attachment.attachmentId]: { localUri: upload.localUri, key: upload.requestId } };
            if (!held.some((h) => h.attachmentId === attachment.attachmentId)) held = [...held, ...(readHeld([attachment]) ?? [])];
          } else {
            const error = typeof message.error === "string" ? message.error : "Your computer refused that picture.";
            uploads = uploads.map((u) => (u.requestId === message.requestId ? { ...u, status: "failed", error } : u));
          }
          publish();
          return;
        }
        case "voice.sent": {
          const requestId = typeof message.requestId === "string" ? message.requestId : "";
          const sent = sends.get(requestId);
          if (!sent) return;
          sends.delete(requestId);
          if (message.ok === true) return; // the task's events and the screenshot list say the rest
          const shot = held.find((h) => h.attachmentId === sent.attachmentId);
          failedCard(requestId, shot?.name ?? "Screenshot", typeof message.error === "string" ? message.error : "It could not be sent.");
          publish();
          return;
        }
        case "voice.attachments": {
          const list = readHeld(message.attachments);
          if (!list) return;
          held = list;
          publish();
          return;
        }
        case "voice.event": {
          const parsed = wire.VoiceEventMessage.safeParse(message);
          if (!parsed.success) return;
          fold({ type: "event", event: parsed.data.event, ...(parsed.data.task ? { task: parsed.data.task } : null) });
          return;
        }
        case "voice.state": {
          const parsed = wire.VoiceState.safeParse(message);
          if (!parsed.success) return;
          // Absent from an older daemon, which holds none: leave what is shown alone.
          const list = readHeld(message.attachments);
          if (list) held = list;
          const dismissed = stringList(message.dismissed);
          fold({
            type: "state",
            snapshot: parsed.data.snapshot,
            events: parsed.data.events,
            ...(dismissed ? { dismissed } : null),
          });
          // Taps made offline: the snapshot just brought those tasks back.
          if (pendingDismissals.length > 0 && store.canDismiss) {
            const waiting = pendingDismissals;
            pendingDismissals = waiting.filter((request) => !deps.send({ ...request, t: "voice.dismiss" }));
            fold({ type: "dismissed", taskIds: waiting.flatMap((request) => request.taskIds) });
          }
          return;
        }
        case "voice.dismissed": {
          const taskIds = stringList(message.taskIds);
          if (taskIds) fold({ type: "dismissed", taskIds });
          return;
        }
        case "error": {
          // An older daemon has no `voice.attach`, and its refusal names no
          // request: without this every upload would spin for ever.
          if (message.code !== "unknown_message" || !uploads.some((u) => u.status === "uploading")) return;
          uploads = uploads.map((u) =>
            u.status === "uploading"
              ? { ...u, status: "failed", error: "Your computer's pew2 is too old for screenshots. Update it, then try again." }
              : u,
          );
          publish();
          return;
        }
        default:
          return;
      }
    },
  };
}

export type TaskController = ReturnType<typeof createTaskController>;
