/**
 * The application store.
 *
 * The relay is read as two small JSON files plus numbered chunks, never as a
 * file listing: `out/index.json` is the session list, each session's
 * `head.json` carries its status and its chunk range, and `sessions/<id>/` holds
 * immutable `events-NNNN.jsonl` chunks fetched by number. Knowing the range is
 * what makes a listing unnecessary — a listing grew with every chunk ever
 * written, while a range is two integers however much history exists.
 *
 * A poll cycle is deliberately cheap. The list is polled slowly and only while
 * it is on screen; an open session polls just its head. Chunks are requested
 * only for numbers we do not already hold, a few at a time, because a phone that
 * slept through a long run is missing many at once and requesting them together
 * is what trips a `429`. Polling stops outright while the tab is hidden: Gitee
 * charges quota even for a `304`, so a background poll is never free.
 */

import { computed, reactive } from 'vue';

import { blobCache } from '@/lib/cache';
import { encodeBase64Text, utf8Bytes } from '@/lib/encoding';
import { assembleStream, parseChunk, summarize } from '@/lib/events';
import type { Assembled, LoadedChunk, TimelineMeta } from '@/lib/events';
import { pathSafeTimestamp } from '@/lib/format';
import {
  GiteeError,
  IN_BRANCH,
  OUT_BRANCH,
  gitee,
  throttle,
  type ApiFailure,
  type FileResult,
} from '@/lib/gitee';
import { newPromptId, randomSuffix, signPrompt } from '@/lib/hmac';
import { canSign, isConfigured, settings } from '@/lib/settings';
import { getJSON, setJSON } from '@/lib/storage';
import type {
  NormalizedEvent,
  OutboundPrompt,
  RelayIndex,
  SessionHead,
  SessionIndexEntry,
  SubagentNode,
} from '@/types';

/** Must match MAX_PROMPT_BYTES in the bridge: longer prompts are refused there. */
export const MAX_PROMPT_BYTES = 8_000;
/** The bridge treats a prompt older than this as stale, so warn before sending. */
const PROMPT_STALE_MS = 10 * 60 * 1000;
const ERROR_BACKOFF_CAP_MS = 120_000;
const OUTBOUND_KEY = 'ccr.outbound.v1';
const OUTBOUND_PER_SESSION = 20;

/**
 * The session list rarely changes and is only read while browsing, so it is
 * polled slowly. An open session's head is ~200 B and is polled at the user's
 * chosen interval while that session is working, and slowly otherwise.
 */
const LIST_POLL_MS = 60_000;
const IDLE_DETAIL_POLL_MS = 60_000;

/** Chunks fetched in one pass before deferring the rest to the next poll. */
const MAX_CHUNKS_PER_PASS = 5;
/** A gap between chunk fetches, so a catch-up never fires as a burst. */
const CHUNK_FETCH_GAP_MS = 250;
/** Gitee's Contents API lags the branch ref by seconds, so a 404 is retried. */
const CHUNK_404_ATTEMPTS = 2;
const CHUNK_404_RETRY_MS = 2_500;
/** Polls a chunk may stay unfetchable before we stop calling it "in flight". */
const STUCK_POLLS = 3;
/** Refetches of a torn chunk before we give up and report the hole. */
const RESYNC_ATTEMPTS = 2;

export type GapReason = 'chunk-incomplete' | 'sequence-gap';

/**
 * Why chunk loading stopped short.
 *
 * The distinction matters because the four cases look identical from the
 * outside and deserve very different reactions: two are entirely normal, one is
 * a stall worth surfacing, and only the last is damage.
 */
type BlockKind =
  /** The newest chunk has no sentinel yet — the writer is still appending. */
  | 'unsealed'
  /** We hit the per-pass fetch cap; the rest waits for the next poll. */
  | 'deferred'
  /** A 404 that survived the lag retry. In flight, but worth watching. */
  | 'unavailable'
  /** Torn or self-inconsistent. Refetched, then reported as a hole. */
  | 'malformed';

interface Blocked {
  n: number;
  kind: BlockKind;
}

export interface DetailState {
  sessionId: string;
  loading: boolean;
  error: string | null;
  errorKind: ApiFailure | null;
  head: SessionHead | null;
  subagents: SubagentNode[];
  /** False until the forest has been fetched once, so the first load fetches it. */
  subagentsLoaded: boolean;
  events: NormalizedEvent[];
  summary: TimelineMeta;
  /**
   * Earlier history was dropped by the relay's rolling retention. Not a fault,
   * and deliberately distinct from `gap`: nothing is broken, the window is just
   * bounded.
   */
  pruned: { droppedEvents: number } | null;
  /** True while a fetch failed and a retry could still repair the stream. */
  resyncing: boolean;
  /**
   * A hole we cannot repair by refetching — the sequence inside the loaded
   * chunks jumps.
   */
  gap: { afterSeq: number; reason: GapReason } | null;
  /** Chunk numbers in the retained range that are not loaded yet. */
  pendingChunks: number[];
  /**
   * The newest chunk has not arrived or has not been sealed yet. Normal while a
   * turn is streaming, so it is reported quietly rather than as a fault.
   */
  inFlight: boolean;
  /** Consecutive polls the current blockage has persisted, to spot a real stall. */
  blockedPolls: number;
  /** Chunk number from which content should be refetched, when resyncing. */
  resyncFrom: number | null;
  resyncAttempts: number;
  chunksLoaded: number;
  /** Size of the retained range, so the UI can show progress. */
  chunksTotal: number;
  lastLoadedAt: number;
}

export interface RelayState {
  index: RelayIndex | null;
  indexLoaded: boolean;
  /** The index is published but carries no sessions. */
  empty: boolean;
  /** Heads we have seen, for whichever sessions have been opened. */
  heads: Record<string, SessionHead>;
  phase: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  errorKind: ApiFailure | null;
  consecutiveErrors: number;
  lastPollAt: number;
  lastSuccessAt: number;
  activeSessionId: string | null;
  detail: DetailState | null;
  outbound: Record<string, OutboundPrompt[]>;
}

export const relay = reactive<RelayState>({
  index: null,
  indexLoaded: false,
  empty: false,
  heads: {},
  phase: 'idle',
  error: null,
  errorKind: null,
  consecutiveErrors: 0,
  lastPollAt: 0,
  lastSuccessAt: 0,
  activeSessionId: null,
  detail: null,
  outbound: loadOutbound(),
});

function loadOutbound(): Record<string, OutboundPrompt[]> {
  const raw = getJSON<Record<string, OutboundPrompt[]>>(OUTBOUND_KEY, {});
  const cleaned: Record<string, OutboundPrompt[]> = {};
  for (const [sessionId, list] of Object.entries(raw)) {
    if (Array.isArray(list)) cleaned[sessionId] = list.filter((p) => p && typeof p.promptId === 'string');
  }
  return cleaned;
}

function persistOutbound(): void {
  const trimmed: Record<string, OutboundPrompt[]> = {};
  for (const [sessionId, list] of Object.entries(relay.outbound)) {
    trimmed[sessionId] = list.slice(0, OUTBOUND_PER_SESSION);
  }
  setJSON(OUTBOUND_KEY, trimmed);
}

function parseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** `events-` + the number zero-padded to four digits + `.jsonl`. */
function chunkFile(n: number): string {
  return `events-${String(n).padStart(4, '0')}.jsonl`;
}

/** Where a chunk lives in the relay. */
function chunkPath(sessionId: string, n: number): string {
  return `out/sessions/${sessionId}/${chunkFile(n)}`;
}

/**
 * Where a fetched chunk is cached.
 *
 * The generation is part of the key because a chunk *number* is only meaningful
 * within one. Rebuilding the bridge's output restarts the numbering at chunk 1,
 * so `events-0001.jsonl` can hold 49 events where it held 398 — and a cache
 * keyed by path alone kept serving the old bytes, which the assembler then read
 * as a stream gap in data that was verified contiguous.
 *
 * An absent generation falls back to the bare path, which is the *weaker* path:
 * such a cache is not protected against a rebuild at all. It is kept only so a
 * head published by an older bridge — which carries no token — stays readable.
 */
function chunkCacheKey(sessionId: string, generation: string | undefined, n: number): string {
  return generation === undefined
    ? chunkPath(sessionId, n)
    : `out/sessions/${sessionId}/${generation}/${chunkFile(n)}`;
}

/**
 * The head's generation, or undefined when it carries none.
 *
 * Empty is treated as absent: it is what a writer would publish if it had
 * nothing to say, and assuming it matches is the compatibility path above.
 */
function headGeneration(head: SessionHead): string | undefined {
  return typeof head.generation === 'string' && head.generation !== '' ? head.generation : undefined;
}

export function sessionDir(sessionId: string): string {
  return `out/sessions/${sessionId}`;
}

export function outboundFor(sessionId: string | null): OutboundPrompt[] {
  if (!sessionId) return [];
  return relay.outbound[sessionId] ?? [];
}

// ---------------------------------------------------------------------------
// The session list
// ---------------------------------------------------------------------------

export interface SessionRow extends SessionIndexEntry {
  /**
   * The head, when we happen to be holding one for this session.
   *
   * Only an opened session has one — the list is rendered from the index alone,
   * deliberately: fetching a head per session would cost one request per row.
   */
  head: SessionHead | null;
}

export const sessions = computed<SessionRow[]>(() => {
  const index = relay.index;
  if (!index) return [];
  return index.sessions
    .map((entry) => ({ ...entry, head: relay.heads[entry.sessionId] ?? null }))
    .sort((a, b) => {
      const at = Date.parse(a.head?.updatedAt ?? a.updatedAt) || 0;
      const bt = Date.parse(b.head?.updatedAt ?? b.updatedAt) || 0;
      return bt - at;
    });
});

/** Backoff remaining, evaluated at call time (callers pass a ticking `now`). */
export function throttledForMs(now = Date.now()): number {
  return Math.max(0, throttle.until - now);
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

function configureClient(): void {
  gitee.configure({ owner: settings.owner, repo: settings.repo, token: settings.token });
}

// Every entry point configures before it fetches: opening a session from a deep
// link can beat the first poll, and an unconfigured client would otherwise
// request `/repos///…` and report a bogus 404.
configureClient();

/**
 * Read one chunk, tolerating Gitee's Contents API lagging the branch ref.
 *
 * A chunk named in `head.json` can 404 for a few seconds after it is pushed,
 * because the Contents API serves from a cache that trails the ref. That is in
 * flight, not missing, so it is retried briefly rather than reported as a hole
 * in the stream.
 */
async function readChunk(path: string): Promise<FileResult | null> {
  for (let attempt = 0; attempt < CHUNK_404_ATTEMPTS; attempt++) {
    const file = await gitee.readFile(path, OUT_BRANCH);
    if (file !== null) return file;
    if (attempt < CHUNK_404_ATTEMPTS - 1) await delay(CHUNK_404_RETRY_MS);
  }
  return null;
}

function rangeInclusive(from: number, to: number): number[] {
  const out: number[] = [];
  for (let n = from; n <= to; n++) out.push(n);
  return out;
}

/** The session list. One small request, and it is only read while browsing. */
async function refreshIndex(): Promise<void> {
  const file = await gitee.readFile('out/index.json', OUT_BRANCH);
  if (!file) {
    // Nothing published yet (or no access to it). Not an error state: a relay
    // that has never been used looks exactly like this.
    relay.index = null;
    relay.empty = true;
    relay.indexLoaded = true;
    return;
  }

  const index = parseJson<RelayIndex>(file.text);
  if (!index || !Array.isArray(index.sessions)) {
    throw new GiteeError('bad-response', 'out/index.json is not a relay index.');
  }

  relay.index = index;
  relay.empty = index.sessions.length === 0;
  relay.indexLoaded = true;
}

function handleFailure(error: unknown): void {
  relay.consecutiveErrors += 1;
  if (error instanceof GiteeError) {
    relay.error = error.message;
    relay.errorKind = error.failure;
  } else if (error instanceof Error) {
    relay.error = error.message;
    relay.errorKind = 'bad-response';
  } else {
    relay.error = 'Unexpected failure.';
    relay.errorKind = 'bad-response';
  }
  relay.phase = 'error';
}

/** One poll. Cheap and idempotent: the caller decides how often to run it. */
export async function pollOnce(options: { force?: boolean } = {}): Promise<void> {
  if (!isConfigured.value) return;
  configureClient();

  if (throttle.until > Date.now()) return;

  const detail = relay.activeSessionId !== null && relay.detail !== null ? relay.detail : null;
  if (!relay.indexLoaded && detail === null) relay.phase = 'loading';

  try {
    if (detail !== null) {
      // A session is open: its head is the only thing polled. The index is left
      // alone until the user goes back to the list, so watching one session
      // never re-downloads the others.
      await loadDetail({ forceMeta: options.force === true });
      // Detail failures are handled inside the load so they can be shown against
      // the session, but a rejected token has to reach the store as well or the
      // redirect to Settings never fires while a session is on screen.
      if (detail.errorKind === 'auth') {
        throw new GiteeError('auth', detail.error ?? 'The access token was rejected.', 401);
      }
    } else {
      await refreshIndex();
    }

    relay.lastPollAt = Date.now();
    relay.lastSuccessAt = Date.now();
    relay.phase = 'ready';
    relay.error = null;
    relay.errorKind = null;
    relay.consecutiveErrors = 0;
  } catch (error) {
    relay.lastPollAt = Date.now();
    handleFailure(error);
  }
}

// ---------------------------------------------------------------------------
// Session detail
// ---------------------------------------------------------------------------

function createDetail(sessionId: string): DetailState {
  return {
    sessionId,
    loading: false,
    error: null,
    errorKind: null,
    head: relay.heads[sessionId] ?? null,
    subagents: [],
    subagentsLoaded: false,
    events: [],
    summary: summarize([]),
    pruned: null,
    resyncing: false,
    gap: null,
    pendingChunks: [],
    inFlight: false,
    blockedPolls: 0,
    resyncFrom: null,
    resyncAttempts: 0,
    chunksLoaded: 0,
    chunksTotal: 0,
    lastLoadedAt: 0,
  };
}

export async function openSession(sessionId: string): Promise<void> {
  relay.activeSessionId = sessionId;
  relay.detail = createDetail(sessionId);
  await loadDetail({ forceMeta: true });
}

/**
 * Only one load per session runs at a time.
 *
 * A poll landing while the detail is opening would otherwise fetch the same
 * chunks twice, which is exactly the kind of duplicated request that eats an
 * unknowable quota on a phone.
 */
let detailLoadInFlight: { sessionId: string | null; promise: Promise<void> } | null = null;

export function closeSession(): void {
  relay.activeSessionId = null;
  relay.detail = null;
  // Back on the list, which may have gone stale while the session was open, and
  // is not polled at all from the detail view. Refresh it now rather than after
  // a whole slow-cadence interval.
  schedule(0);
}

export async function refreshDetail(): Promise<void> {
  await loadDetail({ forceMeta: true });
}

export interface LoadDetailOptions {
  /** Refetch the subagent forest even when no new chunk arrived. */
  forceMeta?: boolean;
}

function loadDetail(options: LoadDetailOptions = {}): Promise<void> {
  const sessionId = relay.activeSessionId;
  if (detailLoadInFlight && detailLoadInFlight.sessionId === sessionId) {
    return detailLoadInFlight.promise;
  }

  const promise = loadDetailNow(options).finally(() => {
    if (detailLoadInFlight?.promise === promise) detailLoadInFlight = null;
  });
  detailLoadInFlight = { sessionId, promise };
  return promise;
}

/** Clear a detail that has nothing recorded yet. */
function applyEmpty(detail: DetailState): void {
  detail.events = [];
  detail.summary = summarize([]);
  detail.pruned = null;
  detail.resyncing = false;
  detail.gap = null;
  detail.pendingChunks = [];
  detail.inFlight = false;
  detail.blockedPolls = 0;
  detail.resyncFrom = null;
  detail.resyncAttempts = 0;
  detail.chunksLoaded = 0;
  detail.chunksTotal = 0;
  detail.lastLoadedAt = Date.now();
}

async function loadDetailNow(options: LoadDetailOptions = {}): Promise<void> {
  const sessionId = relay.activeSessionId;
  const detail = relay.detail;
  if (!sessionId || !detail || detail.sessionId !== sessionId) return;
  if (!isConfigured.value) return;

  configureClient();
  detail.loading = true;
  detail.error = null;
  detail.errorKind = null;

  try {
    const dir = sessionDir(sessionId);

    // --- head.json: the one file polled while a session is open -----------
    const headFile = await gitee.readFile(`${dir}/head.json`, OUT_BRANCH);
    if (!headFile) {
      // No published head. Keep whatever we already had rather than blanking
      // the screen; only a first-ever open has nothing to show.
      if (detail.head === null) detail.error = 'This session has no published data yet.';
      return;
    }

    const head = parseJson<SessionHead>(headFile.text);
    if (!head || typeof head.chunkFirst !== 'number' || typeof head.chunkLast !== 'number') {
      throw new GiteeError('bad-response', 'head.json is not a session head.');
    }
    detail.head = head;
    relay.heads[sessionId] = head;

    // --- the generation ---------------------------------------------------
    const generation = headGeneration(head);

    // A rebuilt series makes every cached chunk of the previous one
    // unreachable: same names, different contents. Evict them here rather than
    // leaving them to age out — nothing will ever read them again, and a phone
    // that has been closed since before the rebuild has no memory of the old
    // token to delete it by.
    if (generation !== undefined) {
      blobCache.evictExcept(`${dir}/`, `${dir}/${generation}/`);
    }

    // --- an empty range means the session has recorded nothing ------------
    if (head.chunkLast < head.chunkFirst) {
      applyEmpty(detail);
      return;
    }

    // --- walk the retained range, fetching only what we do not hold -------
    const loaded: LoadedChunk[] = [];
    let fetchedNew = false;
    let fetchedThisPass = 0;
    let blocked: Blocked | null = null;

    for (let n = head.chunkFirst; n <= head.chunkLast; n++) {
      const path = chunkPath(sessionId, n);
      const cacheKey = chunkCacheKey(sessionId, generation, n);
      const mustRefetch = detail.resyncFrom !== null && n >= detail.resyncFrom;

      // A sealed chunk of a given generation is immutable, so its cache key is
      // valid indefinitely; reusing one is the entire point of numbering chunks.
      let text = mustRefetch ? null : blobCache.get(cacheKey, '');
      let sha = '';
      let justFetched = false;

      if (text === null) {
        if (fetchedThisPass >= MAX_CHUNKS_PER_PASS) {
          // Catch-up is deliberately gradual: a phone that slept through a long
          // run is missing many chunks at once, and asking for them together is
          // what trips a 429. The rest arrive on the following polls.
          blocked = { n, kind: 'deferred' };
          break;
        }
        if (fetchedThisPass > 0) await delay(CHUNK_FETCH_GAP_MS);

        const file = await readChunk(path);
        if (file === null) {
          // 404 even after a retry: the Contents API has not caught up with the
          // ref. In flight, not a hole.
          blocked = { n, kind: 'unavailable' };
          break;
        }
        text = file.text;
        sha = file.sha;
        justFetched = true;
        fetchedThisPass++;
      }

      const parsed = parseChunk(text, n);
      if (!parsed.ok) {
        // No sentinel means the writer is still appending — the expected state
        // of the newest chunk. Anything else is corruption.
        blocked = { n, kind: parsed.incomplete ? 'unsealed' : 'malformed' };
        break;
      }

      // Cache only a complete, self-consistent chunk: a chunk without a
      // sentinel will change, and the cache assumes chunks are immutable.
      if (justFetched) {
        blobCache.set(cacheKey, sha, text);
        fetchedNew = true;
      }
      loaded.push({ n, events: parsed.events });
    }

    // --- interpret what stopped us ----------------------------------------
    let gap: DetailState['gap'] = null;
    let resyncing = false;
    let inFlight = false;
    const lastLoadedSeq = loaded.at(-1)?.events.at(-1)?.seq ?? 0;

    if (blocked !== null && blocked.kind === 'unavailable') {
      detail.blockedPolls += 1;
      inFlight = true;
      // Gitee's lag is seconds, not polls. One that persists long enough to be
      // noticed is reported as resyncing, never as a gap: a chunk that has not
      // arrived is not the same as a discontinuity in the stream.
      if (detail.blockedPolls >= STUCK_POLLS) resyncing = true;
    } else if (blocked !== null && blocked.kind === 'malformed') {
      detail.blockedPolls = 0;
      if (detail.resyncAttempts >= RESYNC_ATTEMPTS) {
        // Already given up on this hole. Keep reporting it without looping.
        gap = { afterSeq: lastLoadedSeq, reason: 'chunk-incomplete' };
      } else {
        detail.resyncFrom =
          detail.resyncFrom === null ? blocked.n : Math.min(detail.resyncFrom, blocked.n);
        detail.resyncAttempts += 1;
        if (detail.resyncAttempts >= RESYNC_ATTEMPTS) {
          // A couple of refetches have not fixed it; report the hole rather than
          // loop on it forever.
          detail.resyncFrom = null;
          gap = { afterSeq: lastLoadedSeq, reason: 'chunk-incomplete' };
        } else {
          resyncing = true;
        }
      }
    } else {
      // Fully loaded, or stopped only by something that heals itself: the
      // writer still working on the newest chunk, or our own gradual catch-up.
      detail.blockedPolls = 0;
      detail.resyncAttempts = 0;
      if (blocked === null) detail.resyncFrom = null;
      inFlight = blocked !== null;
    }

    // A jump in the sequence is only a hole when the reader has what it asked
    // for. While chunks remain unfetched — a catch-up after the phone slept, a
    // just-pushed chunk the Contents API has not caught up with — their absence
    // is the competing explanation, and the honest word is "catching up", not
    // "torn". A torn strip is a claim about the record; a reader that has simply
    // not finished fetching has no standing to make it.
    //
    // An unsealed newest chunk is deliberately *not* one of these cases: it
    // means everything sealed has been loaded, so a jump there is real damage
    // and must be reported.
    const catchingUp =
      blocked !== null && (blocked.kind === 'deferred' || blocked.kind === 'unavailable');

    const assembled: Assembled = assembleStream(loaded);
    // Withheld here, not forgotten: a jump in a range we have not finished
    // fetching is re-tested on every poll, and becomes the fault above as soon
    // as the range is complete.
    const gapWithheld = catchingUp && assembled.gapAfterSeq !== null;
    if (assembled.gapAfterSeq !== null && gap === null && !catchingUp) {
      gap = { afterSeq: assembled.gapAfterSeq, reason: 'sequence-gap' };
    }

    const pending = blocked === null ? [] : rangeInclusive(blocked.n, head.chunkLast);

    // A pass that stopped before loading the *start* of the range assembles
    // nothing at all. Replacing the timeline with that blanks the screen for as
    // many polls as the catch-up takes, which looks exactly like a session with
    // no history — the worst possible thing to show someone who opened the
    // phone to find out what happened.
    const keptPrevious = blocked !== null && loaded.length === 0;
    if (!keptPrevious) {
      detail.events = assembled.events;
      detail.summary = summarize(assembled.events);
    }

    detail.gap = gap;
    detail.resyncing = resyncing;
    // A single outstanding chunk is the newest one, still unsealed — the steady
    // state while a turn streams, and not worth announcing. More than one means
    // a catch-up, which is visible to the reader and so is worth explaining.
    //
    // `keptPrevious` is the case that most needs the sentence: nothing loaded,
    // so the roll above is holding older events. Without it that case would be
    // the one that stayed silent whenever the session has a single chunk.
    //
    // `gapWithheld` is the other: the timeline stops where the sequence jumped,
    // and a fault about it is being withheld — so the reader must be told why
    // the strip ends early rather than left to wonder.
    detail.inFlight =
      !resyncing && (keptPrevious || gapWithheld || (inFlight && pending.length > 1));
    detail.pendingChunks = pending;
    detail.chunksLoaded = loaded.length;
    detail.chunksTotal = head.chunkLast - head.chunkFirst + 1;
    detail.pruned =
      head.chunkFirst > 1 || head.droppedEvents > 0 ? { droppedEvents: head.droppedEvents } : null;
    detail.lastLoadedAt = Date.now();

    // --- the subagent forest ----------------------------------------------
    // It only changes when events do, so it is fetched when a new chunk lands
    // rather than on every poll.
    if (options.forceMeta === true || fetchedNew || !detail.subagentsLoaded) {
      const file = await gitee.readFile(`${dir}/subagents.json`, OUT_BRANCH);
      if (file) {
        const parsed = parseJson<SubagentNode[]>(file.text);
        if (Array.isArray(parsed)) {
          detail.subagents = parsed;
          detail.subagentsLoaded = true;
        }
      }
    }

    applyInjectionAcks(sessionId, assembled.events);
  } catch (error) {
    if (error instanceof GiteeError) {
      detail.error = error.message;
      detail.errorKind = error.failure;
    } else {
      detail.error = error instanceof Error ? error.message : 'Failed to load this session.';
      detail.errorKind = 'bad-response';
    }
  } finally {
    detail.loading = false;
  }
}

/** Fold `injection` events back onto the prompts we sent. */
function applyInjectionAcks(sessionId: string, events: readonly NormalizedEvent[]): void {
  const list = relay.outbound[sessionId];
  if (!list || list.length === 0) return;

  let changed = false;
  for (const event of events) {
    if (event.kind !== 'injection') continue;
    const target = list.find((prompt) => prompt.promptId === event.promptId);
    if (!target) continue;
    if (target.acknowledged === event.state && target.ackDetail === event.detail) continue;
    target.acknowledged = event.state;
    if (event.detail !== undefined) target.ackDetail = event.detail;
    changed = true;
  }
  if (changed) persistOutbound();
}

// ---------------------------------------------------------------------------
// Sending prompts
// ---------------------------------------------------------------------------

export type SendOutcome = { ok: true; promptId: string } | { ok: false; error: string };

function failureMessage(error: unknown): string {
  if (error instanceof GiteeError) return error.message;
  if (error instanceof Error) return error.message;
  return 'The write failed.';
}

export async function sendPrompt(text: string): Promise<SendOutcome> {
  const sessionId = relay.activeSessionId;
  if (!sessionId) return { ok: false, error: 'No session is open.' };

  const detail = relay.detail;
  if (!detail || detail.sessionId !== sessionId) return { ok: false, error: 'No session is open.' };
  // Fail closed: only an explicit `true` counts. Testing for `=== false` would
  // let a head that failed to parse, or predates the field, look writable.
  if (detail.head?.controllable !== true) {
    return { ok: false, error: 'This session is read-only.' };
  }
  if (relay.index?.injectionEnabled !== true) {
    return { ok: false, error: 'Prompts are turned off on the PC.' };
  }
  if (!isConfigured.value) return { ok: false, error: 'Configure the relay in Settings first.' };
  if (!canSign.value) return { ok: false, error: 'Set the shared secret in Settings first.' };

  const trimmed = text.trim();
  if (trimmed === '') return { ok: false, error: 'The prompt is empty.' };

  const bytes = utf8Bytes(trimmed).length;
  if (bytes > MAX_PROMPT_BYTES) {
    return { ok: false, error: `Too long: ${bytes} bytes, the limit is ${MAX_PROMPT_BYTES}.` };
  }

  configureClient();

  const ts = new Date().toISOString();
  const promptId = newPromptId();

  let sig: string;
  try {
    sig = await signPrompt({ sessionId, ts, promptId, text: trimmed }, settings.secret);
  } catch (error) {
    return { ok: false, error: failureMessage(error) };
  }

  // The bytes signed are exactly the bytes published, so the PC can verify them.
  const body = { version: 1, sessionId, promptId, ts, text: trimmed, sig };
  const contentBase64 = encodeBase64Text(JSON.stringify(body));
  const path = `in/${sessionId}/${pathSafeTimestamp(new Date(ts))}-${randomSuffix()}.json`;

  try {
    await gitee.writeFile({
      path,
      contentBase64,
      message: `relay: prompt ${promptId.slice(0, 8)} for ${sessionId}`,
      branch: IN_BRANCH,
    });
  } catch (error) {
    return { ok: false, error: failureMessage(error) };
  }

  const record: OutboundPrompt = { promptId, sessionId, ts, text: trimmed, path };
  const list = relay.outbound[sessionId] ?? [];
  list.unshift(record);
  relay.outbound[sessionId] = list.slice(0, OUTBOUND_PER_SESSION);
  persistOutbound();

  return { ok: true, promptId };
}

/** How long ago a prompt was written, for the "expires after 10 minutes" note. */
export function promptAgeMs(prompt: OutboundPrompt, now = Date.now()): number {
  const t = Date.parse(prompt.ts);
  return Number.isFinite(t) ? now - t : 0;
}

export function promptExpired(prompt: OutboundPrompt, now = Date.now()): boolean {
  return prompt.acknowledged === undefined && promptAgeMs(prompt, now) > PROMPT_STALE_MS;
}

// ---------------------------------------------------------------------------
// Polling loop
// ---------------------------------------------------------------------------

let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let started = false;

/**
 * How long to wait between polls, by what is on screen.
 *
 * The bridge publishes on turn boundaries rather than continuously, so polling
 * faster than that mostly buys `304`s — which Gitee charges quota for anyway.
 * A session that is not working has nothing new to say, so it drops to the slow
 * cadence alongside the list.
 */
function currentCadenceMs(): number {
  const detail = relay.detail;
  if (relay.activeSessionId !== null && detail !== null) {
    const status = detail.head?.status;
    // An unknown status means we have not loaded a head yet, so keep trying at
    // the lively cadence rather than sitting on the slow one.
    return status === undefined || status === 'active' ? settings.pollMs : IDLE_DETAIL_POLL_MS;
  }
  return LIST_POLL_MS;
}

function nextDelay(): number {
  const base = currentCadenceMs();

  if (relay.consecutiveErrors > 0) {
    // Exponential backoff on errors, capped so a flaky connection still heals.
    const backoff = Math.min(base * 2 ** relay.consecutiveErrors, ERROR_BACKOFF_CAP_MS);
    return Math.max(base, backoff);
  }
  if (throttle.until > Date.now()) {
    return Math.max(base, Math.min(throttle.until - Date.now() + 250, ERROR_BACKOFF_CAP_MS));
  }
  return base;
}

function schedule(delay?: number): void {
  if (!started) return;
  // A hidden tab is frozen on a phone, and Gitee charges for a `304` as surely
  // as for a `200`, so a poll from the background is never worth making.
  if (document.hidden) {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    return;
  }
  if (timer !== null) {
    if (delay === undefined) return;
    clearTimeout(timer);
  }
  timer = setTimeout(() => {
    timer = null;
    void tick();
  }, delay ?? nextDelay());
}

async function tick(): Promise<void> {
  if (!started || document.hidden) return;
  if (running) {
    schedule();
    return;
  }

  running = true;
  try {
    await pollOnce();
  } finally {
    running = false;
  }
  schedule();
}

function onVisibilityChange(): void {
  if (document.hidden) {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    blobCache.flush();
    return;
  }
  // Back to the foreground: refresh immediately, then resume the cadence.
  schedule(0);
}

export function startPolling(): void {
  if (started) return;
  started = true;
  document.addEventListener('visibilitychange', onVisibilityChange);
  schedule(0);
}

export function stopPolling(): void {
  started = false;
  document.removeEventListener('visibilitychange', onVisibilityChange);
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

/** Force a refresh now (pull-to-refresh button, or after saving settings). */
export async function refreshNow(): Promise<void> {
  if (!isConfigured.value) return;
  // A manual refresh clears the backoff: the user has decided to spend a request.
  throttle.attempts = 0;
  throttle.until = 0;
  throttle.active = false;
  relay.consecutiveErrors = 0;
  try {
    await pollOnce({ force: true });
  } finally {
    schedule();
  }
}

/** Called when settings change: the target may now be a different repository. */
export function onSettingsChanged(): void {
  configureClient();
  throttle.attempts = 0;
  throttle.until = 0;
  throttle.active = false;
  relay.index = null;
  relay.indexLoaded = false;
  relay.empty = false;
  relay.heads = {};
  relay.error = null;
  relay.errorKind = null;
  relay.consecutiveErrors = 0;
  if (relay.activeSessionId && relay.detail) {
    relay.detail = createDetail(relay.activeSessionId);
  }
  schedule(0);
}
