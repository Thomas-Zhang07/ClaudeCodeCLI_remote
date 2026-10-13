/**
 * The application store.
 *
 * One poll cycle is deliberately cheap in the steady state: fetch the head of
 * `relay-out`, compare it with the sha we last saw, and stop. Content is only
 * fetched for blobs whose sha changed, and chunks only for the session actually
 * on screen — the manifest is what makes that possible without walking files.
 */

import { computed, reactive } from 'vue';

import { blobCache } from '@/lib/cache';
import { encodeBase64Text, utf8Bytes } from '@/lib/encoding';
import { assembleStream, findManifestBreak, findMissingChunks, parseChunk, summarize } from '@/lib/events';
import type { Assembled, LoadedChunk, TimelineMeta } from '@/lib/events';
import { pathSafeTimestamp } from '@/lib/format';
import { GiteeError, IN_BRANCH, OUT_BRANCH, gitee, throttle, type ApiFailure } from '@/lib/gitee';
import { newPromptId, randomSuffix, signPrompt } from '@/lib/hmac';
import { canSign, isConfigured, settings } from '@/lib/settings';
import { getJSON, setJSON } from '@/lib/storage';
import type {
  ChunkManifest,
  NormalizedEvent,
  OutboundPrompt,
  RelayIndex,
  SessionIndexEntry,
  SessionState,
  SubagentNode,
} from '@/types';

/** Must match MAX_PROMPT_BYTES in the bridge: longer prompts are refused there. */
export const MAX_PROMPT_BYTES = 8_000;
/** The bridge treats a prompt older than this as stale, so warn before sending. */
const PROMPT_STALE_MS = 10 * 60 * 1000;
const ERROR_BACKOFF_CAP_MS = 120_000;
const OUTBOUND_KEY = 'ccr.outbound.v1';
const OUTBOUND_PER_SESSION = 20;

export type GapReason = 'chunk-incomplete' | 'missing-chunk' | 'manifest-break' | 'sequence-gap';

export interface DetailState {
  sessionId: string;
  loading: boolean;
  error: string | null;
  errorKind: ApiFailure | null;
  state: SessionState | null;
  manifest: ChunkManifest | null;
  subagents: SubagentNode[];
  events: NormalizedEvent[];
  summary: TimelineMeta;
  /** True while a fetch failed and a retry could still repair the stream. */
  resyncing: boolean;
  /**
   * A hole we cannot repair by refetching — the manifest itself is
   * discontinuous, or the sequence inside the loaded chunks jumps.
   */
  gap: { afterSeq: number; reason: GapReason } | null;
  pendingChunks: number[];
  /** Chunk number from which content should be refetched, when resyncing. */
  resyncFrom: number | null;
  resyncAttempts: number;
  chunksLoaded: number;
  lastLoadedAt: number;
}

export interface RelayState {
  index: RelayIndex | null;
  indexLoaded: boolean;
  /** The branch exists (or the index is written) but carries no sessions. */
  empty: boolean;
  states: Record<string, SessionState>;
  branchSha: string | null;
  treeTruncated: boolean;
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
  states: {},
  branchSha: null,
  treeTruncated: false,
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

/** path -> blob sha, from the last tree walk. */
let treeIndex = new Map<string, string>();

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

function chunkPath(sessionId: string, n: number): string {
  return `out/sessions/${sessionId}/events-${String(n).padStart(4, '0')}.jsonl`;
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
  /** state.json wins over index.json when both are present. */
  detail: SessionState | null;
}

export const sessions = computed<SessionRow[]>(() => {
  const index = relay.index;
  if (!index) return [];
  return index.sessions
    .map((entry) => ({ ...entry, detail: relay.states[entry.sessionId] ?? null }))
    .sort((a, b) => {
      const at = Date.parse(a.detail?.updatedAt ?? a.updatedAt) || 0;
      const bt = Date.parse(b.detail?.updatedAt ?? b.updatedAt) || 0;
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

/** Read a path through the blob cache, refetching when its sha has moved. */
async function fetchPath(path: string, force = false): Promise<{ text: string; sha: string } | null> {
  const known = treeIndex.get(path) ?? '';

  if (!force && known !== '') {
    const cached = blobCache.get(path, known);
    if (cached !== null) return { text: cached, sha: known };
  }

  const file = await gitee.readFile(path, OUT_BRANCH);
  if (!file) return null;
  const sha = file.sha || known;
  blobCache.set(path, sha, file.text);
  return { text: file.text, sha };
}

async function refreshIndex(): Promise<void> {
  const file = await fetchPath('out/index.json');
  if (!file) {
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

/**
 * Refresh `state.json` for the sessions we can see.
 *
 * Only the list, plus the open session, is kept fresh: a phone does not need the
 * cost of a hundred sessions it is not looking at, and every one of these is a
 * request against an API that will not tell us how much quota is left.
 */
async function refreshStates(): Promise<void> {
  const rows = relay.index?.sessions ?? [];
  const wanted = relay.activeSessionId
    ? rows.filter((row) => row.sessionId === relay.activeSessionId)
    : rows;

  for (const row of wanted) {
    const path = `${sessionDir(row.sessionId)}/state.json`;
    const known = treeIndex.get(path);
    // Nothing in the tree means the session directory is gone; keep what we had.
    if (known === undefined) continue;
    if (blobCache.has(path, known) && row.sessionId !== relay.activeSessionId) continue;

    const file = await fetchPath(path);
    if (!file) continue;
    const state = parseJson<SessionState>(file.text);
    if (state) relay.states[row.sessionId] = state;
  }
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
  if (!relay.indexLoaded) relay.phase = 'loading';

  try {
    const head = await gitee.branchHead(OUT_BRANCH);
    relay.lastPollAt = Date.now();

    if (head === null) {
      // No branch yet: the PC has never published. Not an error state.
      relay.branchSha = null;
      relay.index = null;
      relay.empty = true;
      relay.indexLoaded = true;
      relay.phase = 'ready';
      relay.error = null;
      relay.errorKind = null;
      relay.consecutiveErrors = 0;
      relay.lastSuccessAt = Date.now();
      return;
    }

    // Steady state: one request, no content, done.
    const unchanged = head === relay.branchSha && relay.indexLoaded && !options.force;
    if (unchanged) {
      const detail = relay.detail;
      // A stream that is mid-resync may repair itself in place (a torn chunk is
      // refetched from the cached tree), so it is worth retrying even when the
      // branch has not moved.
      const needsDetail =
        relay.activeSessionId !== null &&
        detail !== null &&
        (detail.resyncing || detail.events.length === 0 || detail.manifest === null);

      if (needsDetail) await loadDetail();

      relay.phase = 'ready';
      relay.error = null;
      relay.errorKind = null;
      relay.consecutiveErrors = 0;
      relay.lastSuccessAt = Date.now();
      return;
    }

    const tree = await gitee.tree(OUT_BRANCH);
    relay.treeTruncated = tree.truncated;
    treeIndex = new Map(
      tree.entries
        .filter((entry) => entry.type === 'blob')
        .map((entry) => [entry.path, entry.sha] as const),
    );
    relay.branchSha = head;

    await refreshIndex();
    await refreshStates();
    if (relay.activeSessionId) await loadDetail();

    relay.phase = 'ready';
    relay.error = null;
    relay.errorKind = null;
    relay.consecutiveErrors = 0;
    relay.lastSuccessAt = Date.now();
  } catch (error) {
    handleFailure(error);
    if (error instanceof GiteeError && error.failure === 'not-found') {
      // The repository itself is missing: say so once, clearly.
      relay.error = `Repository not found (${gitee.repoLabel}). Check the owner and repo name.`;
    }
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
    state: relay.states[sessionId] ?? null,
    manifest: null,
    subagents: [],
    events: [],
    summary: summarize([]),
    resyncing: false,
    gap: null,
    pendingChunks: [],
    resyncFrom: null,
    resyncAttempts: 0,
    chunksLoaded: 0,
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
}

export async function refreshDetail(): Promise<void> {
  await loadDetail({ forceMeta: true });
}

export interface LoadDetailOptions {
  /** Refetch state/manifest/subagents even when the sha is unchanged. */
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

async function loadDetailNow(options: LoadDetailOptions = {}): Promise<void> {
  const sessionId = relay.activeSessionId;
  const detail = relay.detail;
  if (!sessionId || !detail || detail.sessionId !== sessionId) return;
  if (!isConfigured.value) return;

  configureClient();
  detail.loading = true;
  detail.error = null;
  detail.errorKind = null;
  const forceMeta = options.forceMeta === true;

  try {
    const base = sessionDir(sessionId);

    // --- state, manifest, subagents -------------------------------------
    const stateFile = await fetchPath(`${base}/state.json`, forceMeta);
    if (stateFile) {
      const state = parseJson<SessionState>(stateFile.text);
      if (state) {
        detail.state = state;
        relay.states[sessionId] = state;
      }
    } else if (detail.state === null) {
      detail.error = 'This session has no state.json yet.';
    }

    const manifestFile = await fetchPath(`${base}/manifest.json`, forceMeta);
    const manifest = manifestFile ? parseJson<ChunkManifest>(manifestFile.text) : null;
    detail.manifest = manifest;

    const subagentsFile = await fetchPath(`${base}/subagents.json`, forceMeta);
    if (subagentsFile) {
      const parsed = parseJson<SubagentNode[]>(subagentsFile.text);
      if (Array.isArray(parsed)) detail.subagents = parsed;
    }

    // --- chunks ---------------------------------------------------------
    const state = detail.state;
    const declared = (manifest?.chunks ?? [])
      .filter((entry) => typeof entry?.n === 'number')
      .sort((a, b) => a.n - b.n);
    // `chunkLast` is authoritative: it is only advanced once a chunk is sealed.
    const chunkLast = state?.chunkLast ?? (declared.length > 0 ? declared[declared.length - 1]!.n : 0);
    const sealed = declared.filter((entry) => entry.n <= chunkLast);

    const pending = findMissingChunks(sealed);
    const manifestBreak = findManifestBreak(sealed);

    let collect = sealed;
    let gap: DetailState['gap'] = null;

    if (manifestBreak) {
      // A break in the manifest cannot be repaired by refetching: the bridge
      // simply does not have those events.
      collect = sealed.filter((entry) => entry.n < manifestBreak.n);
      const previous = sealed.filter((entry) => entry.n < manifestBreak.n).at(-1);
      gap = { afterSeq: previous?.lastSeq ?? 0, reason: 'manifest-break' };
    } else if (pending.length > 0) {
      const firstMissing = pending[0]!;
      collect = sealed.filter((entry) => entry.n < firstMissing);
      const previous = collect.at(-1);
      gap = { afterSeq: previous?.lastSeq ?? 0, reason: 'missing-chunk' };
    }

    const loaded: LoadedChunk[] = [];
    let resyncing = false;
    const unreadable: number[] = [];
    let resyncFrom = detail.resyncFrom;

    for (const entry of collect) {
      const path = chunkPath(sessionId, entry.n);
      const mustRefetch = resyncFrom !== null && entry.n >= resyncFrom;
      // A sealed chunk is immutable, so its tree blob sha doubles as the cache
      // key; `sha256` is the manifest's own digest of the same bytes.
      const blobSha = treeIndex.get(path) ?? entry.sha256;

      let text = mustRefetch ? null : blobCache.get(path, blobSha);

      if (text === null) {
        const file = await gitee.readFile(path, OUT_BRANCH);
        if (!file) {
          // The manifest advertises a chunk the repository does not have (yet).
          resyncing = true;
          unreadable.push(entry.n);
          break;
        }
        text = file.text;
        blobCache.set(path, file.sha || blobSha, text);
      }

      const parsed = parseChunk(text, entry);
      if (!parsed.ok) {
        // A torn or inconsistent chunk: drop it, refetch it next time, and do
        // not render anything after it — the sequence cannot be trusted.
        resyncing = true;
        unreadable.push(entry.n);
        resyncFrom = resyncFrom === null ? entry.n : Math.min(resyncFrom, entry.n);
        break;
      }

      loaded.push({ entry, events: parsed.events });
    }

    if (unreadable.length === 0) {
      // Everything read cleanly, so the previous forced refetch (if any) worked.
      resyncFrom = null;
    } else if (resyncFrom !== null && detail.resyncAttempts >= 2) {
      // Two refetches have not fixed it. Report the hole rather than looping.
      resyncing = false;
      const previous = loaded.at(-1)?.entry;
      gap = gap ?? { afterSeq: previous?.lastSeq ?? 0, reason: 'chunk-incomplete' };
      resyncFrom = null;
    }

    const assembled: Assembled = assembleStream(loaded);
    if (assembled.gapAfterSeq !== null && gap === null) {
      gap = { afterSeq: assembled.gapAfterSeq, reason: 'sequence-gap' };
    }

    detail.events = assembled.events;
    detail.summary = summarize(assembled.events);
    detail.gap = gap;
    detail.resyncing = resyncing;
    detail.pendingChunks = unreadable;
    detail.resyncFrom = resyncFrom;
    if (resyncing) detail.resyncAttempts += 1;
    detail.chunksLoaded = loaded.length;
    detail.lastLoadedAt = Date.now();

    applyInjectionAcks(sessionId, assembled.events);
  } catch (error) {
    if (error instanceof GiteeError) {
      detail.error = error.message;
      detail.errorKind = error.failure;
      if (error.failure === 'throttled') resyncingFallback(detail);
    } else {
      detail.error = error instanceof Error ? error.message : 'Failed to load this session.';
      detail.errorKind = 'bad-response';
    }
  } finally {
    detail.loading = false;
  }
}

function resyncingFallback(detail: DetailState): void {
  if (detail.events.length === 0) detail.resyncing = true;
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
  if (detail.state?.controllable === false) {
    return { ok: false, error: 'This session is read-only.' };
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

function nextDelay(): number {
  const base = settings.pollMs;

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
  if (!started) return;
  if (document.hidden) {
    // Background tabs are frozen on a phone; polling would only burn quota.
    schedule(settings.pollMs);
    return;
  }
  if (running) {
    schedule(settings.pollMs);
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
  relay.branchSha = null;
  relay.indexLoaded = false;
  relay.error = null;
  relay.errorKind = null;
  relay.consecutiveErrors = 0;
  treeIndex = new Map();
  if (relay.activeSessionId && relay.detail) {
    relay.detail = createDetail(relay.activeSessionId);
  }
  schedule(0);
}
