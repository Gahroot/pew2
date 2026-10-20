/**
 * The layout of `pew2 pair`, as pure functions.
 *
 * Rendering is separated from doing so the screen can be tested without a
 * daemon, a relay, a phone or a terminal. Every function here takes plain data
 * and returns lines of text; nothing reads the environment, opens a socket or
 * writes to stdout.
 *
 * The screen answers three questions, in the order a user asks them:
 *
 *   1. What do I do?          the QR, and one line saying scan it
 *   2. Will it work?          one status line — checked, not claimed
 *   3. Did it work?           a live line that resolves when the phone connects
 *
 * The QR is the only way the pairing leaves this screen. The link used to be
 * printed beside it "for when the camera will not read it", which put the token
 * *and* the key in plain text in every screenshot and scrollback of this
 * terminal — and a pairing is admitted to whichever device claims it first.
 * Nothing on this screen is a secret any more: no link, no token, no fingerprint.
 *
 * Facts are never asserted without having been verified. "Works from anywhere"
 * printed next to an unreachable relay is worse than no status line, because it
 * sends the user to debug their phone instead of their relay.
 */
import {
  PALETTE,
  glyphs,
  styler,
  truncate,
  width,
  type Glyphs,
  type Style,
} from "./ui.js";
import { rail } from "./rail.js";

export type Reach = "anywhere" | "local" | "unreachable";

export interface PairView {
  /**
   * The pairing token. Never rendered — the waiting line uses it to watch the
   * local daemon for the phone. The link itself is not part of the view at all,
   * so no change to the layout can print it by accident.
   */
  token: string;
  reach: Reach;
  /** Relay origin and whether it answered a health check, when configured. */
  relay?: { url: string; healthy: boolean | null };
  /** LAN addresses, best first. Only meaningful without a relay. */
  addresses: string[];
  port: number;
  daemonRunning: boolean;
  rotated: boolean;
  /**
   * The phone this code replaced, when printing it re-minted a claimed pairing.
   *
   * Naming it is what stops an unasked-for rotation reading as the tool losing
   * state: the previous phone stops working the moment this screen appears, and
   * the person looking at it is the only one who can tell whether that was the
   * point.
   *
   * Already a display label rather than a raw id. The caller applies
   * `deviceLabel`, which lives beside the command that also prints it on the
   * paired line — importing it here would close a cycle, since that module
   * already depends on this one.
   */
  supersededDevice?: string;
}

export interface RenderOptions {
  style?: Style;
  glyph?: Glyphs;
  columns?: number;
  now?: number;
}

/** Visible width of the gutter: the two-space hang under a section (style B has no pipe). */
const GUTTER_WIDTH = 2;

/**
 * The rail prefix every line hangs off.
 *
 * This screen used to indent with two plain spaces under its own rule, which
 * made `pew2 pair` the one command that did not look like the rest of pew2.
 * The pipe carries colour, so unlike a bare string it has to be built per call
 * from the caller's style.
 */
function gut(_options: RenderOptions = {}): string {
  // Style B has no vertical rule: lines simply hang two spaces in under their section.
  return "  ";
}

/**
 * Indent a pre-rendered block, such as the QR.
 *
 * The QR sets its own colours per cell, so the indent must be plain spaces
 * outside the escapes — prefixing a styled string would bleed the terminal's
 * background into the quiet zone and can stop the code scanning.
 */
export function indent(block: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return block
    .split("\n")
    .map((line) => `${pad}${line}`)
    .join("\n");
}

/**
 * Centre a block within `columns`, never negative and never past the left edge.
 *
 * Returns 0 — not the gutter — when the block is wider than the terminal, so a
 * QR in a narrow window gets every cell of the width available to it. Callers
 * must drop the rail prefix in that case too, or they hand back the columns
 * this just protected.
 */
export function centerIndent(blockWidth: number, columns: number): number {
  if (blockWidth >= columns) return 0;
  return Math.max(GUTTER_WIDTH, Math.floor((columns - blockWidth) / 2));
}

/** The widest line of a multi-line block, in terminal cells. */
export function blockWidth(block: string): number {
  return block.split("\n").reduce((max, line) => Math.max(max, width(line)), 0);
}

/**
 * The opening mark.
 *
 * Was a brand line and a full-width rule, which is why this screen read as a
 * different program to every other command. It is the shared rail intro now,
 * and the rule is gone: the pipe already does the job of tying the screen
 * together, and a rule on top of it is two borders doing one job.
 */
export function header(options: RenderOptions = {}): string[] {
  return rail(options).intro("pew2 pair", "connect a phone");
}

/** What the user physically does, in the app's own words ("Scan QR code"). */
export function steps(options: RenderOptions = {}): string[] {
  return rail(options).step("Scan this with pew2", "on your phone");
}

/**
 * The one status line: will a scan connect, and from where.
 *
 * Each state is a checked fact, and only the first thing wrong is shown — a
 * stopped daemon makes reach irrelevant, a dead relay makes "anywhere" a lie.
 * "Same Wi-Fi only" is said in words rather than left to a colour the user may
 * not be able to see.
 */
export function statusRows(view: PairView, options: RenderOptions = {}): string[] {
  const g_ = gut(options);
  const s = options.style ?? styler();
  const g = options.glyph ?? glyphs();
  const columns = options.columns ?? 80;
  const ellipsis = g.unicode ? "…" : "...";
  const room = Math.max(16, columns - GUTTER_WIDTH - 20);

  const ok = s.hex(PALETTE.success, g.tick);
  const warn = s.hex(PALETTE.warning, g.warn);
  const bad = s.hex(PALETTE.danger, g.cross);
  const row = (mark: string, text: string, note?: string) =>
    `${g_}${mark} ${s.bold(text)}${note ? ` ${s.dim(`${g.dot} ${note}`)}` : ""}`;

  if (!view.daemonRunning) return [row(bad, "pew2 is not running", "pew2 service install")];
  if (view.relay?.healthy === false && view.reach !== "local") {
    return [row(bad, "relay not responding", "the phone will not connect")];
  }
  if (view.reach === "anywhere") {
    return [row(ok, "works anywhere", truncate(hostOf(view.relay?.url ?? ""), room, ellipsis))];
  }
  if (view.reach === "local") {
    return [row(warn, "same Wi-Fi only", view.addresses[0] ?? "this machine")];
  }
  return [row(bad, "no route to this machine")];
}

/**
 * The closing line when the screen is not going to wait for a device.
 *
 * Lives here rather than inline in the command because that is how it went
 * wrong: built by hand inside `cmdPair`, it was the one line on this screen
 * printed with a literal two-space indent instead of the rail, and no test
 * could see it. A daemon that is not running is the most important thing this
 * screen ever says, so it is a rendered value like everything else.
 */
export function closingLines(daemonRunning: boolean, options: RenderOptions = {}): string[] {
  const s = options.style ?? styler();
  return rail(options).outro(
    daemonRunning
      ? s.dim("Scan the code above when you are ready.")
      : `${s.dim("Start the daemon before scanning:")} ${s.bold("pew2 service install")}`,
    daemonRunning ? undefined : "stop",
  );
}

/** The waiting line's text, before the spinner glyph is prepended. */
export function waitingLabel(view: PairView, options: RenderOptions = {}): string {
  const s = options.style ?? styler();
  return view.reach === "anywhere"
    ? `${s.dim("waiting for your phone")}`
    : `${s.dim("waiting for your phone")} ${s.hex(PALETTE.faint, "(same Wi-Fi)")}`;
}

/** The line that replaces the spinner once a device actually connects. */
export function pairedLine(
  deviceName: string,
  elapsedMs: number,
  options: RenderOptions = {},
): string {
  const g_ = gut(options);
  const s = options.style ?? styler();
  const g = options.glyph ?? glyphs();
  const seconds = (elapsedMs / 1000).toFixed(1);
  return `${g_}${s.hex(PALETTE.success, g.tick)} ${s.bold("paired")} ${s.dim(`${g.dot} ${deviceName} ${g.dot} ${seconds}s`)}`;
}

/** Shown when nobody scanned. Not an error: the code stays valid. */
export function timeoutLines(options: RenderOptions = {}): string[] {
  const s = options.style ?? styler();
  return rail(options).outro(s.dim("Stopped waiting. The code above stays valid."), "quiet");
}

/** The keyboard hint, omitted when there is no keyboard to press. */
export function hintLine(interactive: boolean, options: RenderOptions = {}): string[] {
  if (!interactive) return [];
  const g_ = gut(options);
  const s = options.style ?? styler();
  return [rail(options).bar(), `${g_}${s.hex(PALETTE.faint, "q")} ${s.dim("quit")}`];
}

/**
 * Everything above the live line, in order.
 *
 * Returned as one array rather than printed so a caller can measure it, test it
 * or write it somewhere other than stdout.
 */
export function renderPair(
  view: PairView,
  qr: string | undefined,
  options: RenderOptions = {},
): string[] {
  const g_ = gut(options);
  const columns = options.columns ?? 80;
  const lines: string[] = [...header(options)];

  if (qr) {
    lines.push(rail(options).bar());
    // Centred in what is left after the rail, then hung off it like everything
    // else. The pipe is written before the QR's own escapes and the padding
    // after it is unstyled, so the quiet zone stays the terminal's background
    // — prefixing with a styled pad is what breaks scanning.
    //
    // Except when the code will not fit. A wrapped QR cannot be scanned at all,
    // and three columns of rail is enough to cause that on its own in a split
    // pane, so consistency loses to a code that works: the rail breaks for the
    // width of the QR rather than the QR breaking for the width of the rail.
    const block = blockWidth(qr);
    const fits = block + GUTTER_WIDTH <= columns;
    const pad = fits ? Math.max(0, centerIndent(block, columns) - GUTTER_WIDTH) : 0;
    for (const row of indent(qr, pad).split("\n")) lines.push(fits ? `${g_}${row}` : row);
  }

  lines.push(...steps(options));
  lines.push(...statusRows(view, options));

  if (view.rotated) {
    const s = options.style ?? styler();
    const g = options.glyph ?? glyphs();
    // Hangs under the status line, with no gap: it is part of that section,
    // not a new one. (Style B: a blank line only ever opens a section.)
    lines.push(
      // Named when one exists. A pairing this call took from a specific phone
      // deserves to say which, rather than a general warning that leaves the
      // user working out whether it means them.
      view.supersededDevice
        ? `${g_}${s.hex(PALETTE.warning, g.warn)} ${s.dim(`new code ${g.dot} ${view.supersededDevice} must scan again`)}`
        : `${g_}${s.hex(PALETTE.warning, g.warn)} ${s.dim(`new code ${g.dot} paired phones must scan again`)}`,
    );
  }

  return lines;
}

/** Host of a ws/wss/http origin, or the raw string when it will not parse. */
export function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin.replace(/^\w+:\/\//, "").replace(/\/$/, "");
  }
}
