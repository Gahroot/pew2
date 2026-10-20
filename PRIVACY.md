# Privacy Policy

Last updated: 19 October 2026

pew2 is an app for controlling coding agents that run on your own computer. This
policy covers the pew2 iOS app and the pew2 command line tool.

The short version: pew2 has no accounts, advertising, or analytics. Conversation
traffic between the phone and your computer is encrypted end to end. Three
optional features take other paths: push notifications (through Expo and
Apple), call-style rings (through the relay and Apple), and voice calls with
Pew, an AI assistant run by OpenAI. Each is described below. The coding agents
you choose have their own data practices.

## What the developer collects

pew2 does not maintain a developer-operated database of users or conversations.
There is no account to create, analytics SDK, crash reporter, or advertising
identifier in the app. The transport and notification services described below
handle data needed to deliver the service.

If you enable notifications, your computer holds a push delivery address for
your phone in memory, and, for call-style rings, a second Apple delivery
address (a VoIP push token). The daemon does not write either to disk. They are
cleared when the daemon stops, and the app can register them again when
reconnecting.

## Where your data lives

Your computer runs the agent and holds its conversation history, project files,
and agent credentials. The app receives conversation text and images to display
them, and holds session state and unsent messages in memory. It does not save a
persistent conversation archive on the phone.

The app stores pairing details, a device identifier, the last selected agent,
cached agent information, and whether you agreed to voice calls in the iOS
Keychain. Keychain entries can survive
uninstalling the app. Use **Forget** in the app to remove its saved pairing and
cached agent list; this does not remove agent history on your computer or all
Keychain preferences. To invalidate an old pairing, rotate the pairing token on
your computer using `pew2 pair --rotate`.

Images you attach, share, or save can create temporary files on your phone.
Images you choose to save to Photos remain there until you delete them. Data
shared with another app is subject to that app's handling. Agent history and
files on your computer remain under your control and the agent's own retention
settings.

## How the connection works

The app can connect directly to your computer or through a relay. A relay may
still be used on the same Wi-Fi, depending on the pairing address. Session
frames are encrypted end to end using XChaCha20-Poly1305, with a pairing key
held by your devices. The key is carried in the fragment of the pairing link,
which is not included in the connection request sent to the relay. Keep the
complete pairing link and QR code private: anyone with them can pair.

The relay cannot read encrypted session messages. It can observe connection IP
addresses, frame sizes and timing, device and session identifiers, message
counters, and a room identifier derived from the pairing token. The relay application does not persist messages
or conversation history. The hosted relay runs on Cloudflare; infrastructure
metadata handling is subject to Cloudflare's policies. You can also run your own
relay.

## Permissions the app asks for

- **Camera.** To scan the pairing code and take a photo to send to an agent.
- **Photos.** To attach an image or save one an agent sends you.
- **Microphone.** Two uses. Dictation: while you hold the microphone button,
  iOS turns speech into text on the device (the app requires on-device
  recognition), and the text goes to your chosen agent when you send it. Voice
  calls: while a call with Pew is open, your voice is streamed to OpenAI (see
  "Voice calls with Pew").
- **Speech recognition.** For dictation only, on the device.
- **Notifications.** To alert you when an agent finishes or needs you. The app
  explains this before iOS asks. See "Notifications" below.

You can refuse these permissions and continue using the app's other features.

## Notifications

When remote notifications are enabled and registered, your computer sends
finished-turn notifications to Expo's push service, which passes them to Apple
Push Notification service (APNs). This happens even while the app is open;
the phone decides whether to show a banner. Local alerts can also be generated
from events received over the encrypted session connection.

Remote notification payloads are not end-to-end encrypted. Expo and Apple can
read the project or agent name, a short excerpt from the agent's final message,
a session identifier used to open the conversation, and the device's push
delivery address. The excerpt can contain private information from that
conversation. The full conversation is not sent as a push payload.

When Pew wants to call you and call-style rings are not available, your
computer sends a Time Sensitive notification instead (it can show during a
Focus, if you allow that in iOS Settings). It carries the same kind of short
summary as a call-style ring and takes the Expo and Apple path above.

Expo states that notification contents are held in memory and queues only as
needed for delivery, not in databases, and may be visible to staff during
active debugging. Apple's delivery handling is subject to its own policies.

Turning notifications off in iOS stops banners, but does not immediately remove
a push address already registered with your computer. To stop the daemon from
sending further push payloads for that phone, disable notifications and restart
the daemon (`pew2 service restart`). The app will not register a new push address while
notification permission is denied.

## Voice calls with Pew

Voice calls are optional. Pew is an AI voice assistant, not a person. It is
run on OpenAI's Realtime API. The app asks you to agree, once, before the first
call ("Pew is an AI. Your voice goes to OpenAI.").

During a call, the following goes to OpenAI:

- your voice, streamed from the phone directly to OpenAI;
- the instructions and a briefing your computer prepares when the call starts:
  the names of your open sessions and their project folders, which agent each
  one is, whether it is working, its last few lines, and any approvals or
  questions waiting on you (with their text and options);
- during the call, updates about sessions you work with (when one starts or
  finishes, and its reply), and the results of what Pew does for you (reading a
  session's status, sending it a message you dictate, answering an approval).
- when your computer runs voice tasks, a summary of them: project and branch
  names, task titles and states, recent task events and the agent's closing
  message, conversations running at the computer (agent, project folder and
  title), screenshot file names (never the pictures), and, if DAVE runs on
  your computer, the names of projects whose top recommendation changed. Task
  and project details are trimmed and have code, paths and secret-looking text
  removed before they are sent.

Pew's spoken replies are generated by OpenAI and played on the phone. What you
ask Pew to send to an agent then goes to that agent, as if you had typed it.

The call is authorised with an OpenAI login found on your computer: an existing
login one of your coding agents already has (GG Coder, then Codex), or one you
make for pew2 from the phone, or an OpenAI API key you configure. Your computer
uses it only to create a short-lived (10 minute) key for that one call; the
phone never receives your login. With a ChatGPT login, OpenAI's consumer terms
and data controls apply to the call; with an API key, OpenAI's API data
policies apply. OpenAI may keep data under its own policies; see
[OpenAI's privacy policy](https://openai.com/policies/privacy-policy/).

pew2 does not record call audio. So the next call about the same conversation
can carry on, your computer keeps the text of the last 20 back-and-forths of
your calls about each conversation (and of calls placed from the home screen),
plus a one-line note of what Pew did on them. It stays on your computer, in its
pew2 settings folder, readable only by your user account; it never goes to the
relay or to us, and goes to OpenAI only as part of a later call about that
conversation. A conversation's call history is deleted after 30 days without a
call about it, and all of it when you tap "Forget call history" in the call
settings. Your computer also stores your call settings (when Pew may ring you,
which conversations may ring) and, if you sign in from the phone, that OpenAI
login, in the same folder.

## Call-style rings

If you turn on "Ring me", your computer can ring your iPhone like a phone call
when a conversation you allowed to ring is waiting on you. The ring travels
from your computer to the pew2 relay, which signs it and sends it to Apple
Push Notification service. The ring carries the title "Pew", a one-line
summary (such as how many things are waiting and in which project), an item
identifier and a ring identifier. The relay does not store it. These rings are
not end to end encrypted: the relay, Cloudflare and Apple can read that summary.
Rings stop when the time you chose runs out, and do not ring for anything that
is not waiting on you. In China, call-style rings are off and a notification is
used instead.

## Third parties

pew2 has no analytics, advertising, or crash reporting SDKs. Delivery services
include [Expo](https://expo.dev/privacy), [Apple](https://www.apple.com/legal/privacy/),
and [Cloudflare](https://www.cloudflare.com/privacypolicy/), as described above.
Voice calls use [OpenAI](https://openai.com/policies/privacy-policy/), as
described above.
Opening the privacy policy or support links contacts GitHub in your browser;
[GitHub's privacy statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement)
applies to that visit. Do not post private conversations, credentials, or other
sensitive information in public issues.

The coding agents you connect to pew2 are separate programs under their own
terms and privacy policies. They may send your prompts, code, or attachments to
their providers. pew2 passes your messages to the agent you choose; it does not
make those providers' processing local-only.

## Children

pew2 is a developer tool and is not directed at children. Voice calls use
OpenAI, whose terms require users to be 13 or older and, under 18, to have a
parent's or guardian's permission.

## Changes

If this policy changes, the updated version will appear at this address and the
date at the top will change with it.

## Contact

Questions, or anything that looks wrong, at
<https://github.com/KenKaiii/pew2/issues>.
