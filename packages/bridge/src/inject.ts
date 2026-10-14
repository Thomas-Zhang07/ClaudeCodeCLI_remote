/**
 * Typing into a session on the user's behalf.
 *
 * Three things make this less obvious than writing a string and a carriage
 * return:
 *
 *  - **Bracketed paste.** Claude Code's input parser recognises the terminal's
 *    paste markers and collapses a pasted burst into a `[Pasted text #N +M
 *    lines]` placeholder. Injecting raw text therefore does not submit the
 *    prompt — the session receives the placeholder instead. The text has to be
 *    wrapped in the same markers a terminal would send.
 *  - **Enter is `\r`.** A bare `\n` is a newline *within* a multi-line prompt,
 *    not a submit. Which is the behaviour we want inside the text, and the wrong
 *    one at the end.
 *  - **Bursts are detected.** Paste detection is length-sensitive, so a large
 *    write can straddle a render and be reinterpreted. Writes are chunked, and
 *    the Enter is sent only after the paste end has settled.
 */

/** What a terminal emits around pasted text. */
export const PASTE_START = '\x1b[200~';
export const PASTE_END = '\x1b[201~';

export interface WriteTarget {
  write(data: string): void;
}

/** Why a prompt was not typed into a session. */
export type InjectionRefusal =
  | 'injection-disabled'
  | 'unknown-session'
  | 'not-controllable'
  | 'session-not-idle'
  | 'permission-dialog-open'
  | 'tool-in-flight';

/**
 * Find which of the prompts we typed matches a turn that has appeared.
 *
 * Typing into a terminal is not delivery — Claude Code queues input mid-turn
 * and can discard what it queued — so the transcript is the only proof. Matching
 * on the text is imperfect by nature, so the rules are deliberately narrow:
 * exact after normalising whitespace, or a long shared prefix for the case
 * where the parser truncated the turn before storing it. A truncation marker
 * must not read as a mismatch and leave a delivered prompt looking lost.
 *
 * @returns the index of the match, or -1.
 */
export function matchDeliveredTurn(
  waiting: readonly { text: string }[],
  turnText: string,
): number {
  const normalise = (value: string): string => value.trim().replace(/\s+/g, ' ');
  const turn = normalise(turnText);
  if (turn.length === 0) return -1;

  return waiting.findIndex((entry) => {
    const sent = normalise(entry.text);
    if (sent.length === 0) return false;
    if (sent === turn) return true;
    // Long enough that a shared prefix cannot be coincidence.
    return sent.length > 40 && turn.length > 40 && sent.slice(0, 200) === turn.slice(0, 200);
  });
}

export interface InjectionContext {
  /** The operator has allowed prompts at all. */
  injectionEnabled: boolean;
  /** The session is known to the bridge. */
  hasSession: boolean;
  /** A live `ccr` registration owns this session's terminal. */
  controllable: boolean;
  /** Kind of the most recent main-thread event, or null if there is none. */
  lastMainKind: string | null;
  /**
   * The session has recorded nothing at all — it has just been started.
   *
   * Distinct from "we do not know", and the distinction matters: a brand new
   * session is provably safe to type into, because nothing has run yet so no
   * dialog can be open. Without this the guard would refuse every prompt to a
   * freshly started session, meaning a conversation could only ever be
   * continued from the phone, never begun.
   */
  isFresh: boolean;
  /**
   * Hook events are reaching the bridge for this session, and are current.
   *
   * When true, hooks answer the idle question authoritatively and the transcript
   * is not consulted. When false — hooks not installed, not configured for this
   * session, gone quiet, or the receiver down — the `lastMainKind`/`isFresh`
   * rule below applies exactly as it did before hooks existed, so nothing is
   * made less safe by their absence.
   */
  hooksLive: boolean;
  /**
   * A permission dialog is on screen on the PC right now.
   *
   * Only consulted while `hooksLive`; without hooks we do not know, and the
   * transcript rule is the conservative answer.
   */
  dialogOpen: boolean;
  /** A tool call has started and has not finished. Only consulted while `hooksLive`. */
  toolInFlight: boolean;
}

/**
 * Decide whether a prompt may be typed into a session.
 *
 * Pure and separate from delivery so the rule can be tested directly, because
 * it is the rule that keeps typing from being dangerous.
 *
 * Two sources answer the same question, in this order:
 *
 *  1. **Hooks**, when they are live for this session. A `PreToolUse` with no
 *     matching completion means a tool is in flight, and a permission dialog —
 *     if one is open — is blocking exactly that call; a `Notification` naming a
 *     permission dialog says so outright; a `Stop` says the turn ended. This is
 *     the authoritative answer, and it is the one that fixes the false refusals
 *     below.
 *  2. **The transcript**, otherwise. The `turn_end` requirement is the
 *     important one here. **A permission dialog only exists mid-turn**, so
 *     requiring the main thread to have *finished* a turn proves no dialog is
 *     open — and typing into a dialog answers it, which can approve a tool
 *     rather than submit a prompt. It is read from the transcript rather than
 *     the session's status because "waiting for input" is what an idle prompt
 *     reports too, so the status cannot tell the two apart.
 *
 * `turn_end` is a weaker signal than it looks: `turn_duration` is not written
 * after every turn, so a session that finished one without it looks busy
 * indefinitely. Hooks exist to replace that inference, not to weaken it — hence
 * the order above, and hence the transcript rule surviving untouched beneath.
 *
 * Fails closed: anything unrecognised refuses, and hook state is only believed
 * while `hooksLive` says the events are actually arriving.
 */
export function injectionRefusal(context: InjectionContext): InjectionRefusal | null {
  if (!context.injectionEnabled) return 'injection-disabled';
  if (!context.hasSession) return 'unknown-session';
  if (!context.controllable) return 'not-controllable';

  if (context.hooksLive) {
    // Both refusals are the same class of hazard — typing lands on something
    // other than the prompt box. An open dialog is the dangerous one; a tool in
    // flight is merely useless and confusing, and worth refusing for the same
    // reason the mid-turn case is: the prompt queues and may never be run.
    if (context.dialogOpen) return 'permission-dialog-open';
    if (context.toolInFlight) return 'tool-in-flight';
    // Hooks saw nothing blocking. That is a stronger statement than the
    // transcript's, because it is derived from `Stop` rather than from a
    // `turn_duration` record that may never have been written.
    return null;
  }

  // A completed turn proves the session is idle at a clean prompt — and, since
  // a dialog only exists mid-turn, that none is open.
  //
  // A session that has recorded nothing at all is safe for the same reason by a
  // different route: nothing has run, so there is nothing to be blocked on.
  // This is what lets the phone start a conversation rather than only join one.
  if (context.lastMainKind === 'turn_end') return null;
  if (context.isFresh) return null;

  return 'session-not-idle';
}

export interface InjectOptions {
  /** Bytes per write. Large writes can be mistaken for a paste mid-render. */
  chunkBytes?: number;
  /** Pause between chunks. */
  chunkDelayMs?: number;
  /** Pause after the paste marker before Enter, so the TUI registers it. */
  settleMs?: number;
}

const DEFAULTS: Required<InjectOptions> = {
  chunkBytes: 512,
  chunkDelayMs: 8,
  settleMs: 90,
};

/**
 * Deliver a prompt as though it had been typed and submitted.
 *
 * Chunking is by UTF-8 byte budget, walking back to a character boundary, so a
 * multi-byte character is never split across two writes.
 */
export async function injectPrompt(
  target: WriteTarget,
  text: string,
  options: InjectOptions = {},
): Promise<void> {
  const { chunkBytes, chunkDelayMs, settleMs } = { ...DEFAULTS, ...options };

  // Normalise line endings: a stray \r inside the body would submit early,
  // truncating the prompt at that point.
  const body = text.replace(/\r\n|\r/g, '\n');

  target.write(PASTE_START);
  for (const chunk of splitByBytes(body, chunkBytes)) {
    target.write(chunk);
    if (chunkDelayMs > 0) await delay(chunkDelayMs);
  }
  target.write(PASTE_END);

  if (settleMs > 0) await delay(settleMs);
  target.write('\r');
}

/**
 * Split into chunks of at most `maxBytes` UTF-8 bytes, never mid-character.
 *
 * A prompt ending in a character that was cut in half would arrive as a
 * replacement glyph — and for a CJK prompt, which is three bytes per character,
 * that is not a rare edge.
 */
export function splitByBytes(text: string, maxBytes: number): string[] {
  if (maxBytes <= 0) throw new Error('maxBytes must be positive');
  if (text.length === 0) return [];

  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return [text];

  const chunks: string[] = [];
  let start = 0;

  while (start < bytes.length) {
    let end = Math.min(start + maxBytes, bytes.length);
    // Back off to a character boundary; continuation bytes match 10xxxxxx.
    while (end > start && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
    if (end === start) end = Math.min(start + maxBytes, bytes.length);

    chunks.push(bytes.subarray(start, end).toString('utf8'));
    start = end;
  }

  return chunks;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
