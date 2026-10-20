# App Store Connect: App Privacy answers (19 October 2026)

Paste into App Store Connect > the app > App Privacy. These answers can't be
set from the command line; they're edited on the website only.
Engineering guidance, not legal advice: re-check against PRIVACY.md before
submitting.

**Does this app collect data?** Yes.

"Collect" in Apple's sense means data sent off the device to the developer or
third parties (Apple counts processors such as OpenAI, Expo and Cloudflare).
Data that only goes to the user's own computer, end to end encrypted, is not
collected.

## Data types

### Audio Data (Contact Info: no; under "User Content")
- **Collected:** Yes (voice calls with Pew stream the user's voice to OpenAI).
- **Linked to the user's identity:** No. (No pew2 account. Note: OpenAI may
  link it to the user's own OpenAI account; that's OpenAI's collection under the
  user's login, but answer conservatively if unsure. **Lawyer.**)
- **Used for tracking:** No.
- **Purposes:** App Functionality.

### Other User Content
- **Collected:** Yes.
  - Voice-call briefing sent to OpenAI: session/project names, agent replies,
    waiting questions and approvals.
  - Notification and ring summaries through Expo, Apple and the relay: project
    or agent name, a short excerpt.
- **Linked:** No. **Tracking:** No. **Purposes:** App Functionality.

### Identifiers: Device ID
- **Collected:** Yes. Push delivery addresses (Expo push token, APNs VoIP
  token) go through Expo, Apple and the relay to deliver notifications/rings.
- **Linked:** No. **Tracking:** No. **Purposes:** App Functionality.

### Not collected
Contact info, health, financial, location, sensitive info, contacts, browsing
history, search history, purchases, usage data, diagnostics, photos (images go
only to the user's own computer, encrypted end to end), other data.

## Tracking
No. The app does not track users across apps or websites and shows no ads.
No App Tracking Transparency prompt is needed.

## Also update
- Privacy Policy URL: https://github.com/KenKaiii/pew2/blob/main/PRIVACY.md
  (push the updated PRIVACY.md to GitHub before submitting).
- License Agreement: keep Apple's standard EULA (TERMS.md is linked in the
  app and adds to it), or paste TERMS.md as a custom EULA.
- Age rating: "Unrestricted Web Access" = No. The app now includes an AI
  assistant (Pew) that generates speech; recheck the 2026 age-rating questions
  about AI/chatbot features when submitting.
