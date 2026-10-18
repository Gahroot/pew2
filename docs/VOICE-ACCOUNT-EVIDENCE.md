# Voice-account implementation evidence

Checked 18 October 2026. The approved plan remains unchanged at
`.ezcoder/plans/voice-account-oauth.md`.

## Step 1 — tester distribution

- `git remote -v`: origin is `https://github.com/Gahroot/pew2.git`;
  upstream is KenKaiii/pew2.
- `gh release view --repo Gahroot/pew2 --json tagName,assets`: latest release
  is v0.9.21, with macOS arm64/x64, Linux arm64/x64 and Windows x64 binaries,
  each accompanied by a SHA-256 file. Source daemon version is v0.9.23.
- Installer, daemon updater and app install instructions now target origin.
  README explains per-tester installation and the separate release/TestFlight work.
- Executed `bun test ./packages/daemon/src/update/check.test.ts ./packages/daemon/src/update/apply.test.ts`:
  50 passed, 0 failed, 146 assertions. No binary was installed or published.

## Step 2 — source review and unresolved provider support

Reviewed local DAVE `src/providers/openai-auth.ts`, `openai-storage.ts`,
`openai-auth.LICENSE`, `test/provider-auth.test.ts` (login, refresh, cancellation,
response validation tests), and `src/voice/mint.ts`.

- OAuth reference attribution is MIT, copyright 2025 KenKai. No reference code
  was copied. Its keyring package is a DAVE dependency, not an approved new Pew2
  dependency. DAVE's session/keychain storage is not a portable Pew2 file store.
- DAVE uses Codex client ID `app_EMoamEEZ73f0CkXaXp7hrann`, a loopback callback,
  and a Realtime client-secret request. Reading that code or its mocked tests
  does not establish provider approval or real Realtime entitlement.
- Official Codex device implementation was read at:
  https://raw.githubusercontent.com/openai/codex/main/codex-rs/login/src/device_code_auth.rs
  It requests `/api/accounts/deviceauth/usercode`, polls
  `/api/accounts/deviceauth/token`, treats 403/404 as pending, waits up to 15
  minutes at the supplied interval, and exchanges the returned authorization
  code/verifier with redirect URI `https://auth.openai.com/deviceauth/callback`.
  The displayed verification URL is `https://auth.openai.com/codex/device`.
  This proves Codex's implementation, not permission to reuse its client for
  Pew2 Realtime.

Authoritative current documentation:

- https://developers.openai.com/siwc/quickstart.md
  Distinguishes identity from inference scopes; says the open-source flow
  issues credentials for eligible Responses API requests. Identity scopes
  do not grant OpenAI API resource access.
- https://developers.openai.com/siwc/token-sharing-open-source/sign-in.md
  Requires first registration with `dynamic_agent_client`, a stable host ID,
  Pew2's actual app name, and an issued account-specific client ID thereafter.
  The documented redirect is HTTP loopback on `127.0.0.1` with a local listener.
  This is not the proposed Codex device-authorization contract.
- https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference.md
  Names the supported inference endpoint as public `/v1/responses`.
- https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations.md
  Explicitly says audio/video input and the transcription API are unsupported
  by this flow. It does not document authorization for Realtime client secrets.

### Provider blocker remains open

The proposed ChatGPT OAuth-to-Realtime integration is **not established as
supported** by these sources. This is not evidence of a particular account's
403, nor proof that every partner integration is forbidden. The fixed Codex
client ID is not an approved Pew2 client registration.

Implementation initially paused at the protocol/storage boundary. The user then
directed review of the working local references and implementation continued.
The account service is now integrated with daemon voice and mobile account
controls; the previous implicit Codex/API-key fallback has been removed. That
code-level integration does not resolve provider permission or entitlement.
Do not substitute another person's account or a silent API-key fallback.

Before shipping this as a supported service, obtain the provider-supported Pew2
OAuth/device-authorization contract and Realtime authorization, or agree on a
revised architecture. No real OAuth login, Realtime mint, microphone call,
native account UI interaction or two-computer isolation check is verified.

## Implementation verification

Focused tests cover strict account frames, per-device attempt ownership, pending
and slow-down responses, refresh serialization, isolated POSIX storage, and late
completion fencing. A cancellation race during persistence was fixed by rolling
back the just-written credentials inside the mutation queue; disconnect's queued
delete still runs afterward. New regression coverage pauses the storage write
and exercises cancel, disconnect and shutdown before releasing it.

Executed `bun test ./packages/protocol/src/wire.test.ts ./packages/daemon/src/voice/accountAuth.test.ts ./packages/daemon/src/voice/accountStorage.test.ts` after the race fix:
31 passed, 0 failed, 150 assertions in that earlier run.

Subsequent focused regression run: **137 passed, 0 failed, 466 assertions**.
`./node_modules/.bin/tsc --noEmit -p packages/app/tsconfig.json` exited 0.
These are mocked/pure-code checks, not real provider or native-device evidence.
Full project tests, root/relay typechecks, lint and format checks have not been
run for final acceptance; those remain for a separately requested commit check.

The integration includes authenticated transport ownership, no API-key/Codex
fallback, disconnect fencing of pending mints and active voice legs, reconnect
status refresh, stale-reply rejection, pairing-identity reset, and offline
commands that are not queued. The native sheet exposes connect, open/copy code,
cancel, retry, reconnect and confirmed disconnect without opening a microphone
merely to log in.

## Native and live acceptance — blocked, not passed

- Native attempt: `xcrun simctl list devices available -j` produced no output
  despite an installed Xcode/CoreSimulator service. The stalled command was
  stopped; its recorded exit code was 1. No simulator app build, rendered-state
  screenshots, small/standard-phone comparison, browser/copy interaction or
  VoiceOver order has been verified.
- Native fixture: `packages/app/src/ui/VoiceAccountSheet.harness.tsx` provides
  offline, checking, unsupported, empty, authorizing, connected, reconnect,
  notEntitled, retry and expired scenes. Fixture transitions do not call OAuth;
  they cannot prove daemon or provider behavior. Run instructions are in
  `docs/VOICE-APP.md`.
- Two independent computers/accounts and phone access were not available for
  acceptance. No real account login, Realtime mint success, voice call, cellular
  pairing, restart/expiry recovery or cross-computer credential isolation has
  been demonstrated. Use each tester's own login; never collect credentials.
- Provider-supported Pew2 client registration and Realtime entitlement remain
  unresolved as detailed above. Mocked tests are not permission or coverage.
- The maintained published release checked was v0.9.21, not this source build.
  A daemon binary release and matching TestFlight upload require separate
  authorization and remain undone. No binaries, releases or TestFlight builds
  have been published by this work. Windows credential storage fails closed.

### Remaining acceptance procedure

After resolving provider support and obtaining suitable native access:

1. Render every fixture on a small and standard iPhone. Capture screenshots;
   check wrapping, touch targets, reduced motion, VoiceOver focus/announcements,
   open/copy/cancel/retry and disconnect confirmation. Verify real commands
   separately—the fixture only changes display state.
2. On two computers, install the maintained feature-containing daemon build,
   authenticate each tester's own EZ Coder and pair separate app installations.
   Complete independent ChatGPT logins, confirm real mint success and make one
   voice call per account. Confirm no shared credentials or sessions.
3. Repeat over cellular, after daemon/app restart and token expiry. Disconnect
   during authorization, mint and active audio; confirm local credentials stay
   deleted, audio ends, coding tasks continue and Codex login is unchanged.
   Record only sanitized results; never retain tokens or real user codes.

## Documentation/privacy scope

README and voice docs distinguish source changes from published availability,
account connection from voice readiness, and local credential removal from
provider revocation. PRIVACY.md now describes optional account storage, browser
and clipboard actions, and direct OpenAI voice processing. This is a source-based
engineering disclosure update, not a legal review or a compliance certification.
Provider terms/client authorization and accurate store disclosures must be
reviewed before shipping.
