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
  | 'session-not-idle';

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
}

/**
 * Decide whether a prompt may be typed into a session.
 *
 * Pure and separate from delivery so the rule can be tested directly, because
 * it is the rule that keeps typing from being dangerous.
 *
 * The `turn_end` requirement is the important one. **A permission dialog only
 * exists mid-turn**, so requiring the main thread to have *finished* a turn
 * proves no dialog is open — and typing into a dialog answers it, which can
 * approve a tool rather than submit a prompt.
 *
 * It is checked against the transcript rather than the session's status because
 * "waiting for input" is what an idle prompt reports too, so the status cannot
 * tell the two apart. Injecting mid-turn is merely unhelpful, since Claude Code
 * queues it; answering a dialog is not.
 *
 * Fails closed: anything unrecognised refuses.
 */
export function injectionRefusal(context: InjectionContext): InjectionRefusal | null {
  if (!context.injectionEnabled) return 'injection-disabled';
  if (!context.hasSession) return 'unknown-session';
  if (!context.controllable) return 'not-controllable';

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
