# Voice: the app (iOS)

The daemon half is documented in `docs/VOICE.md`. Nothing below has been run on a device or simulator; every native piece is marked **UNTESTED**.

## How a conversation runs
`voice.open` -> `voice.ready` (ephemeral secret + session config + snapshot) -> the app does the SDP exchange with `https://api.openai.com/v1/realtime/calls?model=...` (WebRTC, `react-native-webrtc`), applies `realtime.session` with `session.update` on the `oai-events` channel, and forwards every function call verbatim as `voice.tool`. `voice.tool.result` goes back as `function_call_output` + `response.create`. `endSession` ends the call after the model stops speaking. The OpenAI API key never reaches the phone.

Code: `src/voice/*` (pure, tested) and `src/ui/{useVoice,voiceController,VoiceSheet,voiceNotifier,audioSession,realtimeTransport}`.

## Activation
| Path | How | Status |
|---|---|---|
| In app | mic button in the top bar opens the Voice sheet, then Talk | untested |
| Deep link | `pew2://voice?source=action_button` (also `airpods`, `siri_shortcut`, `lock_screen`; optional `focusEventId`, `focusTaskId`). Handled cold and warm; waits for the daemon socket | parser unit-tested; flow untested |
| Siri / Shortcuts / Action Button / Back Tap | `plugins/withVoiceIntent.js` adds a "Talk to PEW2" App Intent (opens the app, then the deep link). Shows in Shortcuts; assign it to the Action Button or Back Tap in Settings | **UNTESTED**, needs iOS 16.4+ |
| Notification | tap, or the **Talk** button, opens voice with `source: notification` + focus. **Review** opens the on-screen sheet | untested |

Approvals are never decided from the Lock Screen: every notification action opens the app. High-risk approvals (shell, merge, deploy, destructive) need a second tap in the sheet.

## AirPods, honestly
- iOS gives third parties no hook to start a mic from a headset gesture. What works: "Hey Siri, talk to PEW2" (through the shortcut), or AirPods press-and-hold assigned to Siri.
- While a conversation is live, the module registers the media remote commands, so a play/pause press ends it (**UNTESTED**). It cannot start one.
- A background notification cannot open the mic; the user taps.

## Audio behaviour (`modules/pew2-voice`, Swift) - UNTESTED
Category `playAndRecord`, mode `voiceChat` (echo cancellation), options: Bluetooth (AirPods mic), speaker only when no headset, and interrupt-spoken-audio so music ducks and podcasts pause. Ending deactivates with `notifyOthersOnDeactivation` so they resume. A phone call or alarm tears the conversation down and, if short, reopens it with a fresh `voice.open`; a headset being removed ends it. `UIBackgroundModes` has `audio` and `remote-notification`.

## State
`voice.event` / `voice.state` fold into one task list (dedupe by `eventId`). The cursor is persisted (SecureStore `pew2.voiceCursor`), sent as `voice.sync` on every reconnect and when a gap is seen, and cleared on unpair. Reconnects are bounded (3, exponential), each with a fresh open; transcripts are never replayed.

## Older daemon
`unknown_message` in reply to `voice.open` shows "Voice needs a newer pew2 on your computer."

## Building a dev client
Expo Go cannot run this. From `packages/app`:
```
bun install            # repo root
npx expo prebuild --platform ios --clean
cd ios && pod install
npx expo run:ios --device
```
Prebuild picks up `modules/pew2-voice` (autolinking) and runs `plugins/withVoiceIntent.js`. Check that `Pew2VoiceIntents.swift` is in the app target's Compile Sources. The microphone string is shared by `expo-speech-recognition` and the WebRTC plugin (same text in both).

## Not verified / known gaps
- Everything native: Swift module, App Intent, WebRTC connect, routing, resume of Music, interruptions, notification actions.
- The intent plugin's Xcode edit and the Swift compile have never run.
- Local notifications for voice events (`voiceNotifications.offerEvent`) are written and tested but not yet fed from `useVoice`; only push suppression is live.
- Card Approve/Deny use the ACP permission the phone already holds; otherwise the card asks the user to decide by voice.
- `src/ui/statusRow.test.ts` fails on Windows (path handling in the test); unrelated to voice.

## Notifications, audio and connectivity (hardening pass)

- **Quiet hours** (`voice/quietHours.ts`, persisted by `preferences.ts` `loadQuietHours`/`saveQuietHours`, additive: absent = off). Completions are held; decisions/blockers still show a banner unless `strict`. There is **no settings UI yet** (VoiceSheet/App are owned elsewhere); call `saveQuietHours` + `setQuietHours` (`ui/voiceAlerts.ts`).
- **Tiers:** approval/blocked interrupt; completed batches into one digest (20s quiet / 90s max); informational is silent. Live events go through `ui/voiceAlerts.ts` (called from `voiceController` on `voice.event`). Never notified: already heard, voice live, sheet open, just-ended (30s).
- **Cues, not audio:** `audioPolicy.cueFor` — with no live conversation a low-priority event is a haptic at most; it never starts or ducks audio.
- **Lock screen:** Talk/Review open the app and now require device unlock. Approve/Deny buttons were deliberately **not** added: a decision from a locked phone breaks the safety rule above; tap-through starts a fresh voice session focused on the event.
- **Audio session:** adds `duckOthers` (music ducks, podcasts pause), deactivate retries once if I/O is still running, `mediaServicesWereReset` rebuilds, `appWasSuspended` is not treated as an interruption.
- **Connectivity:** `voice/connectivity.ts` + `voiceController.setOnline`. Offline holds the conversation up to 45s (no retry budget spent), says "I lost connection" only if audio is live, and on return reconnects, re-opens and syncs from the cursor.
- Swift changes are uncompiled; tests for the new pure modules are written but not run.
