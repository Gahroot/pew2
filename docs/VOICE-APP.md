# Voice: the app (iOS)

The daemon half is documented in `docs/VOICE.md`. Nothing below has been run on a device or simulator.

## The call

Calls with Pew are upstream's: `ui/useVoice.ts`, `voiceCall.ts`, `ui/voiceTransport.ts` (WebRTC), `ui/CallScreen.tsx`, `ui/useCallKit.ts` and the `modules/pew-call` native module (PushKit and CallKit). Talk is in the top bar on every screen, home included (beside Tasks there; `ui/topBarRight.ts`); hold it for call settings. Pew rings through the relay, which holds the Apple key, when a conversation you armed needs you.

Task news arrives during a call as `voice.note` from the daemon, like any other note, so nothing on the phone has to know about tasks to hear them.

## The Tasks screen

`ui/useVoiceTasks.ts` (hook), `ui/taskController.ts` (state and sends), `ui/TasksSheet.tsx` (the sheet) and `ui/ProjectDashboard.tsx` (Projects).

- Opens from home's top bar (Tasks); a red dot means a task needs you.
- Folds `voice.state`, `voice.event` and `voice.dismissed` into `voice/voiceStore.ts`. The cursor is persisted (`preferences.ts`), sent as `voice.sync` on every reconnect and when a gap is seen, and cleared on unpair.
- Cards group by what needs you first. Approve/Deny use the ACP permission the phone already holds; otherwise the card says to decide it on a call or in that conversation. Risky approvals take a second tap.
- **Screenshots:** pick one (`voice.attach`); the computer holds it. "Send to agent" sends `voice.send`, which runs the same `attach_screenshot` tool a call uses. On a call, Pew can send held screenshots too (`list_screenshots`, `attach_screenshot`); it cannot open the picker.
- **Call Pew** places an ordinary call.
- Finished tasks can be cleared (`voice.dismiss`) one at a time, by project, or all at once.

## Activation

| Path | How | Status |
|---|---|---|
| In a conversation | Talk in the top bar | upstream |
| Home | Talk in the top bar, beside Tasks | untested on device |
| Ring | CallKit, when an armed conversation needs you | upstream |
| Tasks screen | Call Pew | untested |
| Deep link | `pew2://voice` (parsed by `voice/deepLink.ts`, handled cold and warm in `Pew2Screen.tsx`): places a call by the same path as a tapped voice push | untested |
| Siri / Shortcuts / Action Button | `plugins/withVoiceIntent.js` adds a "Talk to PEW2" App Intent that opens `pew2://voice` | **untested**, needs iOS 16.4+ |

## Not verified / known gaps

- Everything native, and the Tasks screen on a device.
- Android has no ringing (upstream's call stack is iOS only).
- A call cannot ask for a screenshot; share it from the Tasks screen first.
