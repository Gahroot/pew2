# Voice

Talk to your coding agents hands-free. **The agents (EZ Coder, or whichever ACP agent you use) do the work. The pew2 daemon owns tasks, approvals and history. Pew, on OpenAI Realtime, is only the voice.** The phone provides the call, the audio and notifications.

There are two layers on one call:

- **The call** comes from upstream (0.9.24/0.9.25): sign-in, ringing, the inbox of everything waiting on you, per-chat call history, the live board, and Pew's own tools for the chats you have open. Daemon: `voice/controller.ts`, `session.ts`, `tools.ts`, `policy.ts`, `inbox.ts`, `threads.ts`, `board.ts`. Relay: `apns.ts`.
- **Voice tasks** are this fork's: orchestrated tasks in their own worktrees, goal runs, commits, DAVE's backlog, references and the opening check-in. Daemon: `voice/service.ts` (`Daemon.voiceTasks()`) and the modules it wires (`dispatcher.ts`, `store.ts`, `registry.ts`, `taskTools.ts`, `goalRuns.ts`, `goalTools.ts`, `dave.ts`, `focus.ts`, `checkin.ts`, `debrief.ts`, `safety.ts`, `screenshots.ts`).

## How a call runs

1. The app sends `voice.session`. The controller finds a credential and builds the call's own briefing (what is waiting, open sessions, reachable projects, earlier calls about this chat).
2. It mints the call's id first and asks `VoiceService.brief(callId)` for the task half: the task guidance (`TASK_INSTRUCTIONS`), the tasks and projects now, conversations running at the desk, the check-in line and working memory, plus the task tools. A briefing never fails the call: if the task side can't answer, the call is the call it always was.
3. The secret is minted with both sets of instructions and tools, and the phone connects to OpenAI directly over WebRTC.
4. Each function call comes back as `voice.tool`. A task tool (`isTaskTool`) goes to `VoiceService.tool`, the rest to the call's own tools. Both are answered once per function-call id.
5. While the call is in progress, a task that completes, fails, blocks or needs an approval is sent to it as a `voice.note` (`[Update] …`, with the debrief), which Pew says at the next pause.
6. `voice.end` ends both halves. The check-in and every task event the call was told count as heard, so the next call does not repeat them.

## Sign-in

Credentials are the call layer's (`voice/credentials.ts`, `login.ts`). A login an agent on this machine already holds (GG Coder or Codex) is used first and is never refreshed by pew2. Otherwise pew2's own device-code sign-in, started from the phone. `OPENAI_API_KEY` is also accepted. See `COMPLIANCE.md` V2 for the open question about this use of a ChatGPT login.

## Task tools

`list_projects`, `resolve_project`, `start_task`, `follow_up`, `task_status`, `whats_running`, `peek_session`, `list_tasks`, `reprioritize_task`, `pause_task`, `resume_task`, `cancel_task`, `verify_task`, `approve_safe`, `set_approval_policy`, `recent_events`, `get_details`, `remember_decision`, `add_project_alias`, `list_screenshots`, `attach_screenshot`, `create_worktree`, `list_worktrees`, `commit`, the goal tools (`start_goal`, `goal_status`, `list_goals`, `resume_goal`), `resolve_reference`, and DAVE's backlog tools when DAVE is available.

Approvals and questions are not task tools: every voice task runs as an ordinary session, so its approvals and questions are in the call's inbox (`list_waiting`, `answer_permission`, `answer_question`). Hanging up is `end_call`. Results are small JSON; the model never sees paths, source or raw logs, and never chooses a directory.

New work goes to `start_task` (its own worktree and branch, queued and debriefed); `tell_agent` is for a chat that is open, and `start_chat` only when they ask to start a chat.

## Partner behaviour: debriefs and live updates

- **Debrief.** When a task's turn ends, the orchestrator builds a `debrief` (`voice/debrief.ts`) from the ACP tool calls it saw, with no second model call: the outcome (`question`, `checks_failed`, `unchecked_edits`, `checked_edits`, `no_changes`), the agent's closing message, counts of edits and commands, `checks: none | ran | failed` judged by the *last* test/lint/typecheck run, and one `nextStep` plus the `followUp` to send on a yes. `checks: "ran"` means a check ran and the agent reported no failure, never "passed".
- **Live updates** are `voice.note`s from the daemon (`voice/liveUpdates.ts`), sent only to a call still in progress (`VoiceController.callInProgress`), each event once.

## Safety model

- Operations are tiered `read`, `edit`, `shell`, `merge`, `deploy`, `destructive` from the tool kind and command text. Unknown is treated as `shell`.
- Approvals through the call are allow once or deny, never "always"; destructive ones need a read-back and `confirmed: true`.
- Cancelling running work needs a single-use `confirmToken`, then a second call with `userConfirmed: true`.
- Hands-free auto-approval of clearly read-only requests (`set_approval_policy`) applies only to voice tasks, only while a call is in progress, and resets with the first call after none.
- "Completed" means the agent says it finished. Only `verify_task` makes a task `verified`. A task interrupted by a restart is `failed` with `interrupted`.
- Everything given to the model is secret-scrubbed, code blocks and paths removed, and kept short.
- One writing task per project at a time; others queue. `readOnly` tasks and different projects run in parallel (3 at once). `dependsOn` waits for completion.

## State files (in `~/.pew2`, or `$PEW2_HOME`)

Voice tasks: `voice-state.json` (tasks, event log, command journal, decisions, heard cursor, focus, check-in), `voice-aliases.json`, `voice-attachments/` (owner-only). The call: `voice-auth.json`, `voice-prefs.json`, `voice-threads.json` beside the pairing.

## Restart behaviour

Event ids continue without gaps. Task tool calls are journaled before they run, keyed by the function-call id: a retry gets the stored answer, and one caught mid-flight by a crash is reported as "outcome unknown" instead of being re-run. On boot, tasks that were running are marked failed/interrupted and queued ones resume.

## App

See docs/VOICE-APP.md.
