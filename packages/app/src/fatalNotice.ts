/**
 * A daemon's refusal, made readable under Pew on the home screen.
 *
 * The refusals (`device-refused`, `unpaired`, `wire-version`) arrive as two
 * or three sentences of explanation in one string. Shown as the greeting, a
 * one-line headline that shrinks to fit, the whole paragraph came out in
 * unreadably small type. Split instead: the first sentence is the headline
 * (what is wrong), the rest is a wrapped note (what to do), and anything the
 * daemon wrapped in backticks is a command to type, picked out from the
 * prose around it.
 *
 * Pure (no Expo), so it is tested with the rest.
 */

export interface FatalNotice {
  headline: string;
  /** The rest, as runs of prose and commands. Empty when the message was one sentence. */
  detail: NoticeRun[];
}

export interface NoticeRun {
  text: string;
  /** Typed into a terminal: shown so it stands out from the prose. */
  command?: true;
}

/** Split at the first sentence end that is followed by more text. */
export function fatalNotice(message: string): FatalNotice {
  const text = message.trim().replace(/\s+/g, " ");
  // A sentence ends at . ! or ? followed by a space; not inside a command,
  // so a `pew2 pair --rotate.` style string never splits mid-command.
  let inCommand = false;
  let cut = -1;
  for (let i = 0; i < text.length - 1; i++) {
    const c = text[i];
    if (c === "`") inCommand = !inCommand;
    else if (!inCommand && (c === "." || c === "!" || c === "?") && text[i + 1] === " ") {
      cut = i + 1;
      break;
    }
  }
  if (cut < 0) return { headline: stripTicks(text), detail: [] };
  return { headline: stripTicks(text.slice(0, cut).trim()), detail: runs(text.slice(cut).trim()) };
}

function stripTicks(text: string): string {
  return text.replace(/`/g, "");
}

/** Prose and `commands`, in order. An unclosed backtick is read as plain text. */
function runs(text: string): NoticeRun[] {
  const parts = text.split("`");
  if (parts.length % 2 === 0) return [{ text: stripTicks(text) }];
  return parts.flatMap((part, i) => (part === "" ? [] : [i % 2 === 1 ? { text: part, command: true as const } : { text: part }]));
}

/**
 * The app's own short wording for a refusal it understands, in place of the
 * daemon's paragraph: one sentence for what is wrong, one for the fix. The
 * daemon's text is kept for anything this app does not recognise, so a newer
 * daemon's new refusal still says something.
 */
export function refusalText(code: unknown, detail: unknown): string {
  const said = typeof detail === "string" ? detail : "";
  switch (code) {
    case "device-refused":
      return "Paired to another device. Run `pew2 pair --rotate`, then scan.";
    case "unpaired":
      return "Not paired with this computer. Run `pew2 pair`, then scan.";
    case "wire-version":
      return said.includes("on your computer")
        ? "pew2 on your computer is out of date. Update it, then reconnect."
        : "This app is out of date. Update it, then reconnect.";
    default:
      return said || "This device is no longer paired.";
  }
}
