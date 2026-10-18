import { useEffect, useMemo, useRef, useState } from "react";
import { createVoiceAccount, type AccountView } from "./account";

/** Identity changes create a fresh controller: old pairing replies cannot populate it. */
export function useVoiceAccount(
  identity: string,
  online: boolean,
  send: (message: unknown) => boolean,
) {
  const [snapshot, setSnapshot] = useState<{ owner: object; view: AccountView }>();
  const sequence = useRef(0);
  const controller = useMemo(() => {
    const owner = {};
    return {
      owner,
      account: createVoiceAccount({
        send,
        now: Date.now,
        id: () => `account-${++sequence.current}`,
        changed: (view) => setSnapshot({ owner, view }),
      }),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a new identity must start a fresh controller
  }, [identity, send]);
  useEffect(() => {
    if (online) controller.account.online();
    else controller.account.offline();
    const timer = setInterval(() => controller.account.tick(), 1_000);
    return () => {
      clearInterval(timer);
      controller.account.offline();
    };
  }, [controller, online]);
  return {
    view: snapshot?.owner === controller.owner ? snapshot.view : controller.account.view,
    command: (name: Parameters<typeof controller.account.command>[0]) =>
      controller.account.command(name),
    receive: (message: Parameters<typeof controller.account.receive>[0]) =>
      controller.account.receive(message),
  };
}
