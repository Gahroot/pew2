# Voice orchestration

Talk to your coding agents hands-free. **The agents (EZ Coder, or whichever ACP agent you use) do the work. The pew2 daemon owns tasks, approvals and history. OpenAI Realtime is only a temporary voice controller.** The phone provides audio and notifications.

## Daemon

### Setup

**Voice now requires an explicitly connected Pew2 voice account.** With the paired computer online, open **Connection → Voice account → Connect ChatGPT** in the app. Open the official ChatGPT page, enter the displayed code and finish sign-in. The computer polls for completion; no microphone is opened during login. Each tester signs into their own account on their own paired computer.

**Provider support is not established.** This implementation follows the local references and the public Codex device protocol, including its client ID. That is not a registered Pew2 client or proof that OpenAI permits this Realtime use. Do not treat this source build as a supported subscription-backed voice service. Real login, a successful Realtime mint and two-user acceptance remain unverified; see `docs/VOICE-ACCOUNT-EVIDENCE.md`.

Login and voice readiness are separate. After login the daemon probes `POST /v1/realtime/client_secrets`, discards the probe secret and reports readiness separately. A 401 requires reconnecting; a 403 means voice is unavailable for the account; rate limits and network failures can be retried. A successful login alone does not establish subscription coverage or Realtime entitlement.

**No automatic API-key billing fallback.** Voice no longer uses Codex CLI credentials, `OPENAI_API_KEY`, or the legacy `openaiApiKey` preference to authorize requests. Existing keys are not deleted. Existing API-key voice users must connect a voice account; coding-agent authentication is unchanged. `pew2 doctor` reports the separate account requirement without initiating login or refreshing credentials.

OAuth access and refresh tokens stay on the computer, not the phone or model tools. The phone receives only a user code, fixed verification URL, sanitized status, and (when voice starts) a short-lived Realtime secret. **Disconnect** removes Pew2's voice credentials and ends active voice legs without cancelling coding tasks or signing out EZ Coder/Codex.

`voice-prefs.json` also accepts `model` (default `gpt-realtime-2.1`), `voice` (default `marin`) and `enabled: false`.

### Flow

1. App sends `voice.open`. The daemon builds a compact snapshot (projects, active tasks, unheard events), mints the secret, and replies `voice.ready` with the full Realtime `session` object (instructions, tools, server VAD with interruption).
2. The app connects to OpenAI directly and forwards each function call as `voice.tool`. The daemon runs it and replies `voice.tool.result`.
3. Task changes are broadcast as `voice.event` to every client. The same stream feeds the screen, the voice and push.
4. App sends `voice.close` with `heardEventId`; the daemon stores the cursor so unheard events are offered next time. `voice.sync` and the `voice.state` sent after `hello` catch a client up.

Tasks run as ordinary daemon sessions (in the project's directory, with the `ezcoder` agent if installed, otherwise the first usable agent), so they appear in the normal conversation list and keep running when the phone disconnects.

### Tools

`list_projects`, `resolve_project{query}`, `start_task{project, instruction, title?, priority?, dependsOn?, readOnly?}`, `follow_up{taskId, instruction}`, `task_status{taskId?}`, `list_tasks`, `reprioritize_task`, `pause_task`, `resume_task`, `cancel_task`, `verify_task`, `pending_approvals`, `answer_approval{taskId, requestId, decision, confirmToken?, userConfirmed?}`, `recent_events`, `get_details`, `remember_decision`, `add_project_alias`, `end_session`. Results are small JSON; the model never sees paths, source or raw logs, and never chooses a directory.

### Partner behaviour: debriefs and live updates

- **Debrief.** When a task's turn ends, the orchestrator builds a `debrief` on the task (`voice/debrief.ts`) from the ACP tool calls it saw during that run, with no second model call. It has the outcome (`question`, `checks_failed`, `unchecked_edits`, `checked_edits`, `no_changes`), the agent's closing message, counts of edits and commands, and `checks: none | ran | failed`, judged by the *last* test/lint/typecheck run. It also has one `nextStep` to offer plus the `followUp` instruction to send if the user says yes. If the agent ends on a question, that beats everything and no next step is invented. `checks: "ran"` means a check ran and the agent reported no failure, never "passed". The debrief rides on `VoiceTask` (optional on the wire), `task_status`/`get_details` and the opening context, and is cleared when the task runs again.
- **Live updates.** The daemon cannot reach the Realtime conversation (that is phone ↔ OpenAI), so the app injects them. Completed, failed/blocked and approval `voice.event`s newer than the opening snapshot become one `[Update]` system message each (`voice/liveUpdates.ts`), with the debrief attached. `realtime.notify()` holds them until nobody is talking: not while the user speaks, not while model audio plays, not while a response or tool call is open. Then it sends them together with one `response.create`. The instructions tell the model to say nothing if it already told the user.

### Safety model

- Operations are tiered `read`, `edit`, `shell`, `merge`, `deploy`, `destructive` from the tool kind and command text. Unknown is treated as `shell`.
- Shell needs an explicit spoken yes. Merge, deploy, destructive (and cancelling running work) also need a confirmation round trip: the first call returns a single-use `confirmToken`; only a second call with that token and `userConfirmed: true` proceeds.
- An approval is checked against the task as it is now and its exact `requestId`. A stale answer is refused. An "always allow" option is never chosen.
- "Completed" means the agent says it finished. Only `verify_task` (after a check or the user's word) makes a task `verified`. A task interrupted by a restart is `failed` with `interrupted`, never completed.
- Anything given to the model is secret-scrubbed, code blocks and paths removed, and kept short.
- Only one writing task per project runs at a time; others queue. `readOnly` tasks and different projects run in parallel (3 at once). `dependsOn` waits for completion; a failed dependency fails the dependent task.
- Start failures retry once; a failed turn is never re-run automatically (it may have edited files). A task silent for 30 minutes is stopped and failed.

### State files (in `~/.pew2`, or `$PEW2_HOME`)

`voice-state.json` (tasks, event log, command journal, decisions, heard cursor), `voice-aliases.json`, `voice-prefs.json`. Written atomically.

`voice-account/oauth.json` holds Pew2-owned access/refresh tokens and expiry. It is written atomically with owner-only POSIX permissions (directory 0700, file 0600); this is not OS-keychain storage or encryption at rest. Unsafe permissions and Windows storage fail closed. Protect the computer and its backups. Do not copy this file between testers or include it in diagnostics.

### Account troubleshooting

- **Account required:** connect in the app; existing API keys and Codex login are not adopted.
- **Reconnect required (401):** start a fresh sign-in. Coding-agent login is unchanged.
- **Not entitled (403):** OpenAI refused voice for this account. Login success does not override that refusal; there is no billing fallback.
- **Rate limited/network failure:** retry later with the computer online. App **Retry** refreshes status; a later voice start retries minting.
- **Storage error:** use an owner-only `voice-account` directory and credential file on macOS/Linux. Windows is not supported for this account flow yet.
- **Update Pew2 on your computer:** the app could not get an account-status reply. Verify the connection and install a daemon build containing this feature; the currently documented published release is not proof of availability.
- **Remove account:** disconnect while the computer is online before forgetting the phone pairing. This removes local Pew2 credentials; it does not revoke provider browser sessions or delete provider-held data.

### Restart behaviour

Event ids continue without gaps. Commands are journaled before they run, keyed by the Realtime `call_id`: a retry gets the stored answer, and a call that was mid-flight at a crash is reported as "outcome unknown" instead of being re-run. On boot, tasks that were running are marked failed/interrupted and queued ones resume.

### Push

Approval, blocked/failed and completed events send an Expo push whose data is `VoiceCallbackPush` (`type: "voice.callback"`). Informational events never push. No push is sent while a voice session is open. The banner text is visible to Expo/Apple/Google, so it is short and scrubbed.

## App

See docs/VOICE-APP.md.

### Spoken responses and hands-free approvals

The instructions ask for one-sentence confirmations ("Sent to billing."), no ids or paths aloud, and one short "Did you mean A or B?" only when project matching is ambiguous (`resolve_project` and `start_task` return a `question`). A clear best match proceeds without asking.

Every permission request is assessed (`assessApproval` in `safety.ts`): a plain-words sentence, the risk tier, and `safe` (read-only and inside the project; no network, install, git push, secrets file, delete or write). `pending_approvals` returns `say`, `safe` and `concerns`. New tools: `approve_safe` (approve every pending safe request, leave risky ones) and `set_approval_policy{autoApproveSafe}` (per voice session, default on: safe requests are auto-approved while a session is open; risky ones are always asked). `answer_approval` may omit ids when exactly one approval is pending. All answers go through `Orchestrator.answerApproval`, after the resolver is registered. The voice wire protocol is unchanged.
