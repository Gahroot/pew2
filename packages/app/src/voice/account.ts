import { wire } from "@pew2/protocol";

export interface AccountView {
  availability: "offline" | "checking" | "supported" | "unsupported";
  pending?: "status" | "connect" | "cancel" | "disconnect";
  account?: wire.VoiceAccountStatus;
  message?: string;
}
export type AccountCommand = "status" | "connect" | "cancel" | "disconnect";

/** Display-only account controller. No command is queued or replayed offline. */
export function createVoiceAccount(deps: {
  send: (message: unknown) => boolean;
  id: () => string;
  now: () => number;
  changed: (view: AccountView) => void;
}) {
  let view: AccountView = { availability: "offline" };
  let request: { id: string; command: AccountCommand; deadline: number } | undefined;
  let nextPoll = 0;
  const update = (next: AccountView) => {
    view = next;
    deps.changed(view);
  };
  function command(command: AccountCommand): boolean {
    if (view.availability === "offline" || request) return false;
    if (command !== "status" && view.availability !== "supported") return false;
    const attemptId = view.account?.authorization?.attemptId;
    if (command === "cancel" && !attemptId) return false;
    const id = deps.id();
    request = { id, command, deadline: deps.now() + 10_000 };
    update({ ...view, pending: command, message: undefined });
    if (
      deps.send({
        t: `voice.account.${command}`,
        requestId: id,
        ...((command === "cancel" || command === "status") && attemptId ? { attemptId } : {}),
      })
    )
      return true;
    offline();
    return false;
  }
  function offline() {
    request = undefined;
    update({ availability: "offline" });
  }
  return {
    get view() {
      return view;
    },
    command,
    offline,
    online() {
      request = undefined;
      update({ availability: "checking" });
      command("status");
    },
    receive(message: unknown) {
      const parsed = wire.VoiceAccountStatus.safeParse(message);
      if (!parsed.success || parsed.data.requestId !== request?.id) return;
      request = undefined;
      nextPoll = deps.now() + 2_000;
      update({ availability: "supported", account: parsed.data });
    },
    tick() {
      const now = deps.now();
      if (request && now >= request.deadline) {
        const checking = view.availability === "checking";
        request = undefined;
        update({
          ...view,
          pending: undefined,
          availability: checking ? "unsupported" : view.availability,
          message: checking
            ? "Update Pew2 on your computer to connect a voice account."
            : "The computer did not respond. Retry to check the account.",
        });
        return;
      }
      if (request || view.availability !== "supported") return;
      const authorization = view.account?.authorization;
      if (authorization && now >= authorization.expiresAt) {
        update({
          ...view,
          account: undefined,
          message: "The sign-in code expired. Connect ChatGPT again.",
        });
        return;
      }
      if (view.account?.state === "authorizing" && now >= nextPoll) {
        nextPoll = now + 2_000;
        command("status");
      }
    },
  };
}
export type VoiceAccountController = ReturnType<typeof createVoiceAccount>;

export function accountLabel(view: AccountView): string {
  if (view.availability === "offline") return "Computer offline";
  if (view.availability === "checking") return "Checking account…";
  if (view.availability === "unsupported") return "Update Pew2 on your computer";
  if (view.pending === "connect") return "Starting sign-in…";
  if (view.pending === "disconnect") return "Disconnecting…";
  switch (view.account?.state) {
    case "authorizing":
      return "Waiting for ChatGPT sign-in";
    case "connected":
      return view.account.voiceReady ? "Voice ready" : "Connected; voice not ready";
    case "reconnect-required":
      return "Reconnect ChatGPT";
    case "not-entitled":
      return "Connected; voice not available for this account";
    default:
      return "Not connected";
  }
}
