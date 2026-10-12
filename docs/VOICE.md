# Voice orchestration

Talk to your coding agents hands-free. **The agents (EZ Coder, or whichever ACP agent you use) do the work. The pew2 daemon owns tasks, approvals and history. OpenAI Realtime is only a temporary voice controller.** The phone provides audio and notifications.

## Daemon

### Setup

**Default: your ChatGPT/Codex subscription.** Run `codex login` on the computer where the daemon runs; the daemon reads `~/.codex/auth.json` (or `$CODEX_HOME`), refreshes the token itself, and mints Realtime secrets with it. **Fallback:** if there is no login or OpenAI refuses it, the API key is used. To use the key, set `OPENAI_API_KEY` in the environment where the daemon runs, then restart it. Alternatively put `{"openaiApiKey": "..."}` in `voice-prefs.json` (see below). The environment wins. Without a key, `pew2 doctor` shows a **warning** (`voice-no-api-key`, never an error), and the app is told `voice.unavailable` with code `no_api_key`.

The key never leaves the daemon. The phone receives only a short-lived client secret (`POST /v1/realtime/client_secrets`).

`voice-prefs.json` also accepts `model` (default `gpt-realtime`), `voice` (default `marin`) and `enabled: false`.

### Flow

1. App sends `voice.open`. The daemon builds a compact snapshot (projects, active tasks, unheard events), mints the secret, and replies `voice.ready` with the full Realtime `session` object (instructions, tools, server VAD with interruption).
2. The app connects to OpenAI directly and forwards each function call as `voice.tool`. The daemon runs it and replies `voice.tool.result`.
3. Task changes are broadcast as `voice.event` to every client. The same stream feeds the screen, the voice and push.
4. App sends `voice.close` with `heardEventId`; the daemon stores the cursor so unheard events are offered next time. `voice.sync` and the `voice.state` sent after `hello` catch a client up.

Tasks run as ordinary daemon sessions (in the project's directory, with the `ezcoder` agent if installed, otherwise the first usable agent), so they appear in the normal conversation list and keep running when the phone disconnects.

### Tools

`list_projects`, `resolve_project{query}`, `start_task{project, instruction, title?, priority?, dependsOn?, readOnly?}`, `follow_up{taskId, instruction}`, `task_status{taskId?}`, `list_tasks`, `reprioritize_task`, `pause_task`, `resume_task`, `cancel_task`, `verify_task`, `pending_approvals`, `answer_approval{taskId, requestId, decision, confirmToken?, userConfirmed?}`, `recent_events`, `get_details`, `remember_decision`, `add_project_alias`, `end_session`. Results are small JSON; the model never sees paths, source or raw logs, and never chooses a directory.

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

### Restart behaviour

Event ids continue without gaps. Commands are journaled before they run, keyed by the Realtime `call_id`: a retry gets the stored answer, and a call that was mid-flight at a crash is reported as "outcome unknown" instead of being re-run. On boot, tasks that were running are marked failed/interrupted and queued ones resume.

### Push

Approval, blocked/failed and completed events send an Expo push whose data is `VoiceCallbackPush` (`type: "voice.callback"`). Informational events never push. No push is sent while a voice session is open. The banner text is visible to Expo/Apple/Google, so it is short and scrubbed.

## App

See docs/VOICE-APP.md.

### Spoken responses and hands-free approvals

The instructions ask for one-sentence confirmations ("Sent to billing."), no ids or paths aloud, and one short "Did you mean A or B?" only when project matching is ambiguous (`resolve_project` and `start_task` return a `question`). A clear best match proceeds without asking.

Every permission request is assessed (`assessApproval` in `safety.ts`): a plain-words sentence, the risk tier, and `safe` (read-only and inside the project; no network, install, git push, secrets file, delete or write). `pending_approvals` returns `say`, `safe` and `concerns`. New tools: `approve_safe` (approve every pending safe request, leave risky ones) and `set_approval_policy{autoApproveSafe}` (per voice session, default on: safe requests are auto-approved while a session is open; risky ones are always asked). `answer_approval` may omit ids when exactly one approval is pending. All answers go through `Orchestrator.answerApproval`, after the resolver is registered. The voice wire protocol is unchanged.
