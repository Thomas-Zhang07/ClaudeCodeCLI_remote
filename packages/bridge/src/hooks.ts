/**
 * The hook receiver: an authoritative answer to "is anything blocking?".
 *
 * The bridge already infers whether a session is idle from its transcript, and
 * that inference is unreliable in one direction that matters: `turn_duration` is
 * not written after every turn, so a session that finished a turn without one
 * looks busy forever and every prompt sent to it is refused. Claude Code can
 * instead *tell* us. See docs/KNOWN-ISSUES.md #8.
 *
 * Three hook events answer the question directly:
 *
 *  - `PreToolUse` with no matching `PostToolUse`/`PostToolUseFailure` by
 *    `tool_use_id` — a tool call is in flight. `PreToolUse` fires *before* the
 *    permission check, so a call that is waiting on a dialog is in flight too,
 *    and this is what covers the dialog from the moment it appears.
 *  - `Notification` carrying a permission message — the dialog is on screen.
 *    This arrives a few seconds after the dialog does, which is why it is a
 *    second signal rather than the only one.
 *  - `Stop` — the turn ended, so nothing is blocking anything any more.
 *
 * The state machine is **pure** and takes `now` as an argument, so the rules can
 * be tested without a server, a clock, or Claude Code. Everything that touches
 * the network lives in `startHookServer` at the bottom.
 *
 * Two properties are deliberate:
 *
 *  - **Fails closed.** An unrecognised event changes nothing, and the guard
 *    refuses whenever the state is uncertain.
 *  - **Hooks gate nothing.** The receiver only observes. It is never consulted
 *    by Claude Code for a decision, it never writes to a session, and it never
 *    blocks a tool call.
 */

import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { BUDGETS, singleLine, truncateText, type AttentionLevel } from '@ccr/shared';

/** The single endpoint hooks post to. Must match `HOOK_PATH` in hooks/post-hook.mjs. */
export const HOOK_PATH = '/hook';

/**
 * Largest body accepted.
 *
 * A `PreToolUse` payload carries `tool_input`, which for a `Write` can be
 * megabytes. The forwarder strips that before posting, so this is only a guard
 * against something else posting to the port.
 */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

// ---------------------------------------------------------------------------
// The payload
// ---------------------------------------------------------------------------

/**
 * One hook event, reduced to what the bridge actually uses.
 *
 * The base fields are common to every event; the rest are present only on the
 * events that carry them (`tool_use_id` on tool events, `message` on
 * notifications). Unknown fields are dropped rather than passed along, so a
 * future Claude Code release adding a field cannot enlarge what we store.
 */
export interface HookPayload {
  sessionId: string;
  eventName: string;
  /**
   * The agent this hook fired inside, or null for the main thread.
   *
   * Present ⇒ the event came from within a subagent and must not be mistaken
   * for main-thread activity.
   */
  agentId: string | null;
  agentType: string | null;
  transcriptPath: string | null;
  cwd: string | null;
  permissionMode: string | null;
  toolName: string | null;
  toolUseId: string | null;
  message: string | null;
  notificationType: string | null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Parse one hook input.
 *
 * Returns null for anything without a session id and an event name — those two
 * are the only fields every event guarantees, and without them the payload
 * cannot be attributed to anything.
 */
export function parseHookPayload(raw: unknown): HookPayload | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;

  const sessionId = text(o['session_id']);
  const eventName = text(o['hook_event_name']);
  if (!sessionId || !eventName) return null;

  return {
    sessionId,
    eventName,
    agentId: text(o['agent_id']),
    agentType: text(o['agent_type']),
    transcriptPath: text(o['transcript_path']),
    cwd: text(o['cwd']),
    permissionMode: text(o['permission_mode']),
    toolName: text(o['tool_name']),
    toolUseId: text(o['tool_use_id']),
    message: text(o['message']),
    notificationType: text(o['notification_type']),
  };
}

/**
 * Whether this event reports a permission dialog.
 *
 * `notification_type` is the correct signal, but it is **sometimes omitted**
 * upstream, and a dialog we fail to recognise is a dialog we would type into —
 * which answers it and can approve a tool. So a permission-shaped message is
 * accepted as well, and either signal alone is enough. Over-reporting a dialog
 * costs a refusal, which self-clears on the next tool event; under-reporting
 * costs an approved tool.
 */
export function isPermissionPrompt(event: HookPayload): boolean {
  if (event.eventName !== 'Notification') return false;
  if (event.notificationType === 'permission_prompt') return true;
  return /permission|approv|allow|grant|authoriz/i.test(event.message ?? '');
}

// ---------------------------------------------------------------------------
// Per-session state
// ---------------------------------------------------------------------------

export interface HookSessionState {
  /**
   * At least one hook event has been seen for this session.
   *
   * The bridge only trusts hook state over the transcript once this is true:
   * before any event arrives it knows nothing, and "knows nothing" must not read
   * as "no dialog is open".
   */
  hooksLive: boolean;
  /** When the last event was received. Compared against transcript activity. */
  lastEventAt: number;
  lastEventName: string | null;
  /**
   * Tool calls started and not yet finished, by `tool_use_id`.
   *
   * An empty string stands for a call that arrived without an id — it can still
   * be paired with a later id-less completion, and it is cleared by `Stop` in
   * any case, so a lost event cannot wedge the guard past the end of a turn.
   */
  tools: readonly string[];
  /** A permission dialog is on screen right now. */
  dialogOpen: boolean;
  /** The agent the dialog belongs to, or null when it is the main thread's. */
  dialogAgent: string | null;
  /** Last notification surfaced, so a repeated one is not published twice. */
  lastNote: string | null;
  lastNoteAt: number;
  /** Events seen, for logging and for `SIGHUP`-style diagnostics. */
  events: number;
}

export function emptyHookState(): HookSessionState {
  return {
    hooksLive: false,
    lastEventAt: 0,
    lastEventName: null,
    tools: [],
    dialogOpen: false,
    dialogAgent: null,
    lastNote: null,
    lastNoteAt: 0,
    events: 0,
  };
}

export interface HookOutcome {
  state: HookSessionState;
  /**
   * Set when the event is worth showing on the phone.
   *
   * A permission dialog is the "you are needed" moment, and until now the phone
   * could only infer it from `status`/`waitingFor`, which the session registry
   * does not always carry.
   */
  attention: { text: string; level: AttentionLevel } | null;
}

/** Claude Code re-fires its idle notification; only publish a change. */
const NOTE_DEDUPE_MS = 60_000;

/**
 * Events that mean the tool call a dialog was blocking has moved on.
 *
 * A dialog cannot outlive the call it is blocking, so any of these proves it is
 * gone. (`Notification` is deliberately absent: it is what *opens* a dialog,
 * and it never closes one.)
 */
const PROGRESS_EVENTS: ReadonlySet<string> = new Set([
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Stop',
  'SessionStart',
  'SessionEnd',
]);

/**
 * Fold one hook event into a session's state.
 *
 * Pure: the caller supplies `now`, and the previous state is never mutated.
 */
export function applyHookEvent(
  previous: HookSessionState | undefined,
  event: HookPayload,
  now: number,
): HookOutcome {
  const state: HookSessionState = {
    ...(previous ?? emptyHookState()),
    hooksLive: true,
    lastEventAt: now,
    lastEventName: event.eventName,
    events: (previous?.events ?? 0) + 1,
  };

  let attention: HookOutcome['attention'] = null;

  // Cleared before the event is applied, so a `PreToolUse` that ends one tool
  // call and starts the next cannot be read as still being blocked.
  //
  // A main-thread event clears any dialog: the main thread only moves when the
  // dialog blocking it has been answered. A subagent's event clears only the
  // dialog that same subagent opened, because a subagent finishing says nothing
  // about a dialog the main thread is sitting behind.
  if (state.dialogOpen && PROGRESS_EVENTS.has(event.eventName)) {
    if (event.agentId === null || event.agentId === state.dialogAgent) {
      state.dialogOpen = false;
      state.dialogAgent = null;
    }
  }

  switch (event.eventName) {
    case 'SessionStart':
    case 'SessionEnd':
      // A new (or ended) session has nothing in flight. `SessionEnd` matters
      // most: without it a session killed mid-tool would refuse forever, since
      // no `PostToolUse` is ever coming to pair with that `PreToolUse`.
      state.tools = [];
      break;

    case 'PreToolUse':
      state.tools = [...state.tools, event.toolUseId ?? ''];
      break;

    case 'PostToolUse':
    case 'PostToolUseFailure':
      state.tools = removeOne(state.tools, event.toolUseId ?? '');
      break;

    case 'Stop':
      // The turn is over, so no tool can still be running — and this is what
      // bounds every way a call can fail to be paired off. A denied permission
      // dialog is the one that happens in practice: `PreToolUse` has fired and
      // neither completion event ever will, so that call looks in flight until
      // the turn it belonged to ends. Refusing for the rest of that turn is the
      // same answer the transcript rule gave, and it is bounded, which the
      // alternative — a timeout guess — would not be.
      state.tools = [];
      break;

    case 'Notification': {
      const permission = isPermissionPrompt(event);
      if (permission) {
        state.dialogOpen = true;
        state.dialogAgent = event.agentId;
      }
      attention = notificationAttention(event, state, now);
      break;
    }

    default:
      // Unrecognised: record that hooks are alive for this session and change
      // nothing else. Guessing at an event we do not understand is how a guard
      // like this gets a hole in it.
      break;
  }

  return { state, attention };
}

function removeOne(ids: readonly string[], id: string): string[] {
  const index = ids.indexOf(id);
  if (index === -1) return [...ids];
  return [...ids.slice(0, index), ...ids.slice(index + 1)];
}

function notificationAttention(
  event: HookPayload,
  state: HookSessionState,
  now: number,
): HookOutcome['attention'] {
  const permission = isPermissionPrompt(event);
  const body = event.message ?? (permission ? 'Claude Code is asking for permission' : '');
  // Nothing to say is not worth a timeline entry; the guard still refuses.
  if (body.trim().length === 0) return null;

  const text = truncateText(singleLine(body), BUDGETS.message);
  if (state.lastNote === text && now - state.lastNoteAt < NOTE_DEDUPE_MS) return null;

  state.lastNote = text;
  state.lastNoteAt = now;
  return { text, level: permission ? 'waiting' : 'info' };
}

/** The three facts the injection guard needs, defaulted for a session we have never heard from. */
export interface HookFacts {
  hooksLive: boolean;
  dialogOpen: boolean;
  toolInFlight: boolean;
}

export function hookFacts(state: HookSessionState | undefined): HookFacts {
  return {
    hooksLive: state?.hooksLive === true,
    dialogOpen: state?.dialogOpen === true,
    toolInFlight: (state?.tools.length ?? 0) > 0,
  };
}

/**
 * Whether hook state for a session is fresh enough to be believed.
 *
 * Hook delivery can stop while the events keep firing — the receiver is a
 * separate process, and a hook whose POST fails is simply lost. Nothing about
 * "no events recently" can tell that apart from "the session is idle", and
 * refusing every idle session is the very bug hooks are here to fix. So the
 * test is not silence but **disagreement**: if the transcript has moved on to a
 * timestamp later than the last hook event (beyond ordinary jitter), the hooks
 * demonstrably missed something, and the transcript rule takes over again.
 *
 * @param lastMainEventAt newest timestamp seen in the session's own transcript,
 *   or 0 when nothing has been read. Transcript timestamps and hook arrival
 *   times come from the same clock — this machine's — so they are comparable.
 */
export function hooksCurrent(
  state: HookSessionState | undefined,
  lastMainEventAt: number,
  quietMs: number,
): boolean {
  if (!state?.hooksLive) return false;
  if (lastMainEventAt === 0) return true;
  return lastMainEventAt <= state.lastEventAt + quietMs;
}

// ---------------------------------------------------------------------------
// The receiver
// ---------------------------------------------------------------------------

export interface HookServerOptions {
  port: number;
  /** Required on every request when set. Null accepts anything (and warns). */
  token: string | null;
  onEvent: (payload: HookPayload) => void;
  /** Defaults to silent; the bridge passes its stderr writer. */
  log?: (message: string) => void;
}

export interface HookServer {
  readonly port: number;
  /** False once the socket is closed or has failed; hooks must not be trusted then. */
  readonly running: boolean;
  close(): Promise<void>;
}

/**
 * Listen for hook events.
 *
 * Bound to loopback explicitly, and only loopback: the payloads describe what
 * every session on the machine is doing, and nothing outside this machine has
 * any business writing them.
 *
 * Rejects with the listen error rather than exiting — a port already in use
 * must leave the bridge running without hooks, not stop it.
 */
export async function startHookServer(options: HookServerOptions): Promise<HookServer> {
  const log = options.log ?? ((): void => {});
  let running = true;
  let rejections = 0;

  const server: Server = createServer((request, response) => {
    void handle(request, response);
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let reply: { status: number; body: Record<string, unknown> };
    try {
      reply = await respond(request);
    } catch (error) {
      // Nothing a hook can send should be able to take the receiver down. The
      // rejection is caught here rather than left to `handle`'s caller: an
      // unhandled rejection ends the process, and this is the bridge.
      reply = { status: 500, body: { ok: false } };
      log(`hook receiver error: ${String(error)}`);
    }

    try {
      response.writeHead(reply.status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(reply.body));
    } catch {
      // The peer is already gone. Answering it is not worth another failure.
    }
  }

  async function respond(
    request: IncomingMessage,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    if (request.method !== 'POST') return { status: 405, body: { ok: false, reason: 'method' } };
    if (!isLoopbackAddress(request.socket.remoteAddress)) {
      return { status: 403, body: { ok: false, reason: 'not-loopback' } };
    }

    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== HOOK_PATH) return { status: 404, body: { ok: false, reason: 'path' } };

    if (options.token !== null) {
      const supplied = request.headers['x-ccr-token'];
      const candidate = typeof supplied === 'string' ? supplied : url.searchParams.get('token');
      if (!sameToken(options.token, candidate)) {
        // Counted rather than logged in full: a misconfigured hook retries on
        // every event, and a log line each time would bury everything else.
        rejections++;
        if (rejections <= 3) log('hook receiver: rejected a request with a bad or missing token');
        return { status: 403, body: { ok: false, reason: 'token' } };
      }
    }

    const read = await readBody(request);
    if (!read.ok) {
      return read.reason === 'too-large'
        ? { status: 413, body: { ok: false, reason: 'too-large' } }
        : { status: 400, body: { ok: false, reason: 'truncated' } };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(read.body);
    } catch {
      return { status: 400, body: { ok: false, reason: 'malformed' } };
    }

    const payload = parseHookPayload(parsed);
    if (!payload) return { status: 400, body: { ok: false, reason: 'not-a-hook-payload' } };

    try {
      options.onEvent(payload);
    } catch (error) {
      // The listener is the bridge; if it throws, the hook must still see 202
      // so it does not retry or report a failure it cannot act on.
      log(`hook event handling failed: ${String(error)}`);
    }

    return { status: 202, body: { ok: true } };
  }

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    // Loopback by name, not by address family, so this cannot be widened by a
    // later edit into something that answers on the LAN.
    server.listen(options.port, '127.0.0.1');
  });

  // Attached only once listening succeeded, so the caller's own "port in use"
  // message is the only one printed in that case.
  server.on('error', (error) => {
    if (running) log(`hook receiver failed: ${String(error)}`);
    running = false;
  });
  server.on('close', () => {
    running = false;
  });

  // The port actually bound, which differs from the one requested only when 0
  // was asked for and the system chose.
  const bound = server.address();
  const port = typeof bound === 'object' && bound !== null ? bound.port : options.port;

  return {
    port,
    get running() {
      return running;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        // A hook holding a connection open must not hold up shutdown.
        setTimeout(resolve, 250).unref?.();
      }),
  };
}

/**
 * Whether a peer address is this machine.
 *
 * The socket is bound to `127.0.0.1`, so this can only ever reject — it is a
 * second lock on the same door, there to survive somebody later "fixing" the
 * bind address to something that answers on the network.
 */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  // IPv4, IPv6, and IPv4-mapped-IPv6, which is what Node reports for a v4
  // connection on a dual-stack socket.
  return (
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1' ||
    address.startsWith('127.')
  );
}

function sameToken(expected: string, supplied: string | null): boolean {
  if (!supplied) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(supplied, 'utf8');
  // Constant-time, and length is compared first because timingSafeEqual throws
  // on a length mismatch. The token is local, but comparing secrets with `===`
  // is a habit worth not having.
  return a.length === b.length && timingSafeEqual(a, b);
}

type BodyResult = { ok: true; body: string } | { ok: false; reason: 'too-large' | 'read' };

/** Read the body, bounded, and without letting a torn connection throw. */
async function readBody(request: IncomingMessage): Promise<BodyResult> {
  const chunks: Buffer[] = [];
  let size = 0;

  try {
    for await (const chunk of request) {
      const buffer = chunk as Buffer;
      size += buffer.length;
      if (size > MAX_BODY_BYTES) {
        // Stop buffering but keep draining, so the reply reaches the sender
        // instead of being lost to a reset socket. The cost is bounded by the
        // sender, which on a loopback observer is not a threat worth designing
        // against — and the alternative is answering nobody.
        request.resume();
        return { ok: false, reason: 'too-large' };
      }
      chunks.push(buffer);
    }
  } catch {
    // The peer went away mid-body. Not an error to report, but not a payload
    // to act on either.
    return { ok: false, reason: 'read' };
  }

  return { ok: true, body: Buffer.concat(chunks).toString('utf8') };
}
