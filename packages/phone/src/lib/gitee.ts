/**
 * The Gitee REST client.
 *
 * Behaviours here were arrived at against the live API, and several of them are
 * counter-intuitive:
 *
 *  - **Auth goes in a header.** A token in a query string leaks into access logs
 *    and browser history. Writes additionally carry `access_token` in the body
 *    because that is what Gitee's contents API documents.
 *  - **Remaining quota is unknowable.** Gitee returns no `X-RateLimit-*` headers
 *    on authenticated requests (they appear only for anonymous callers), and
 *    `GET /api/v5/rate_limit` is a 404. So the client cannot budget requests; it
 *    can only react to a 429/403 by backing off.
 *  - **Conditional requests are pointless.** A 304 still costs quota, so
 *    `If-None-Match` buys nothing — there is no cheap way to ask "has anything
 *    changed?". The client therefore keeps its inquiries small and — where it
 *    can — bounded: one tiny JSON file per poll, and chunks only by number.
 */

import { reactive } from 'vue';

import { decodeBase64Text } from './encoding';

export const API_BASE = 'https://gitee.com/api/v5';
export const OUT_BRANCH = 'relay-out';
export const IN_BRANCH = 'relay-in';

export type ApiFailure =
  | 'network'
  | 'timeout'
  | 'auth'
  | 'throttled'
  | 'not-found'
  | 'server'
  | 'bad-response';

export class GiteeError extends Error {
  override readonly name = 'GiteeError';
  readonly failure: ApiFailure;
  readonly status: number | null;

  constructor(failure: ApiFailure, message: string, status: number | null = null) {
    super(message);
    this.failure = failure;
    this.status = status;
  }
}

export interface ThrottleState {
  /** True while the client is serving out a backoff. */
  active: boolean;
  /** Epoch ms before which no request should be attempted. */
  until: number;
  attempts: number;
  message: string | null;
}

export interface RelayTarget {
  owner: string;
  repo: string;
  token: string;
}

export interface FileResult {
  path: string;
  sha: string;
  size: number;
  text: string;
}

/** Backoff ceiling. Beyond this the user is better off retrying by hand. */
const MAX_BACKOFF_MS = 120_000;
/** Long enough that the first throttle visibly holds off a poll cycle. */
const BASE_BACKOFF_MS = 15_000;
/** A hung request on a phone has to be abandoned rather than waited on. */
const REQUEST_TIMEOUT_MS = 25_000;

export const throttle = reactive<ThrottleState>({
  active: false,
  until: 0,
  attempts: 0,
  message: null,
});

export function throttleRemainingMs(now = Date.now()): number {
  return Math.max(0, throttle.until - now);
}

function describeFailure(failure: ApiFailure): string {
  switch (failure) {
    case 'network':
      return 'Network unreachable — check the phone’s connection.';
    case 'timeout':
      return 'The request timed out.';
    case 'auth':
      return 'The access token was rejected (or lacks access to this repository).';
    case 'throttled':
      return 'Gitee is throttling requests.';
    case 'not-found':
      return 'Not found.';
    case 'server':
      return 'Gitee returned a server error.';
    case 'bad-response':
      return 'Gitee returned something unexpected.';
  }
}

function encodePath(path: string): string {
  return path
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

export class GiteeClient {
  #owner = '';
  #repo = '';
  #token = '';

  configure(target: RelayTarget): void {
    const changed =
      target.owner !== this.#owner || target.repo !== this.#repo || target.token !== this.#token;
    this.#owner = target.owner;
    this.#repo = target.repo;
    this.#token = target.token;
    // A new token may not be throttled at all; a new repo changes every URL.
    if (changed) this.resetThrottle();
  }

  get configured(): boolean {
    return this.#owner !== '' && this.#repo !== '' && this.#token !== '';
  }

  get repoLabel(): string {
    return `${this.#owner}/${this.#repo}`;
  }

  get throttled(): boolean {
    return throttle.until > Date.now();
  }

  resetThrottle(): void {
    throttle.active = false;
    throttle.until = 0;
    throttle.attempts = 0;
    throttle.message = null;
  }

  #url(path: string): string {
    return `${API_BASE}/repos/${encodeURIComponent(this.#owner)}/${encodeURIComponent(this.#repo)}${path}`;
  }

  #headers(extra?: Record<string, string>): Record<string, string> {
    // Header auth, never a query parameter.
    return { Authorization: `Bearer ${this.#token}`, ...extra };
  }

  /** Apply exponential backoff with jitter; called on 429 and (Gitee's other) 403. */
  #backoff(message: string, retryAfterMs: number | null): void {
    throttle.attempts += 1;
    const exponential = Math.min(BASE_BACKOFF_MS * 2 ** (throttle.attempts - 1), MAX_BACKOFF_MS);
    const base = retryAfterMs !== null ? Math.max(retryAfterMs, 1000) : exponential;
    const jitter = Math.random() * base * 0.3;
    throttle.until = Date.now() + base + jitter;
    throttle.active = true;
    throttle.message = message;
  }

  async #fetch(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
        // The relay is live data; never let an HTTP cache answer for it.
        cache: 'no-store',
      });
      return response;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new GiteeError('timeout', describeFailure('timeout'));
      }
      throw new GiteeError('network', describeFailure('network'));
    } finally {
      clearTimeout(timer);
    }
  }

  async #json<T>(url: string, init: RequestInit, what: string): Promise<T> {
    const response = await this.#fetch(url, init);

    if (response.status === 429 || response.status === 403) {
      const retryAfter = Number.parseInt(response.headers.get('Retry-After') ?? '', 10);
      const retryAfterMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : null;
      const detail = await this.#errorText(response);
      const message = detail ? `${describeFailure('throttled')} (${detail})` : describeFailure('throttled');
      this.#backoff(message, retryAfterMs);
      throw new GiteeError('throttled', message, response.status);
    }

    if (response.status === 401) {
      // A rejected token is not a throttle; surface it without a long backoff.
      this.resetThrottle();
      throw new GiteeError('auth', describeFailure('auth'), 401);
    }

    if (response.status === 404) {
      this.resetThrottle();
      throw new GiteeError('not-found', `${describeFailure('not-found')} (${what})`, 404);
    }

    if (response.status >= 500) {
      const detail = await this.#errorText(response);
      const message = detail ?? describeFailure('server');
      // A 5xx is usually transient; back off gently rather than hammering.
      this.#backoff(message, null);
      throw new GiteeError('server', message, response.status);
    }

    if (!response.ok) {
      const detail = await this.#errorText(response);
      throw new GiteeError('bad-response', detail ?? `${describeFailure('bad-response')} (HTTP ${response.status})`, response.status);
    }

    this.resetThrottle();

    try {
      return (await response.json()) as T;
    } catch {
      throw new GiteeError('bad-response', `${what}: the response was not JSON.`, response.status);
    }
  }

  async #errorText(response: Response): Promise<string | null> {
    try {
      const body = (await response.json()) as { message?: unknown; error?: unknown };
      if (typeof body.message === 'string' && body.message.length > 0) return body.message;
      if (typeof body.error === 'string' && body.error.length > 0) return body.error;
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Read one file. Returns null when the path is absent (404).
   *
   * A 404 is deliberately not an error here: readers use it as a signal. A
   * chunk 404 means Gitee's Contents API has not caught up with the branch ref
   * yet, and a missing `index.json` means nothing has been published — neither
   * is a failure worth surfacing.
   */
  async readFile(path: string, ref: string): Promise<FileResult | null> {
    type ContentsResponse = {
      path?: string;
      sha?: string;
      size?: number;
      content?: string;
      encoding?: string;
    };

    try {
      const data = await this.#json<ContentsResponse | ContentsResponse[]>(
        `${this.#url(`/contents/${encodePath(path)}`)}?ref=${encodeURIComponent(ref)}`,
        { headers: this.#headers() },
        path,
      );

      if (Array.isArray(data)) {
        throw new GiteeError('bad-response', `${path} is a directory, not a file.`);
      }
      if (typeof data.content !== 'string') {
        // Gitee omits `content` for very large files; that is fatal for a chunk.
        throw new GiteeError('bad-response', `${path} came back without content (too large?).`);
      }

      return {
        path: data.path ?? path,
        sha: data.sha ?? '',
        size: typeof data.size === 'number' ? data.size : 0,
        text: decodeBase64Text(data.content),
      };
    } catch (error) {
      if (error instanceof GiteeError && error.failure === 'not-found') return null;
      throw error;
    }
  }

  /**
   * Write a prompt to the inbound branch.
   *
   * `content` must already be base64 of the exact JSON body; this method does no
   * encoding of its own so the signed bytes are exactly the bytes sent.
   */
  async writeFile(options: {
    path: string;
    contentBase64: string;
    message: string;
    branch?: string;
  }): Promise<{ sha: string | null }> {
    const branch = options.branch ?? IN_BRANCH;
    const body = {
      access_token: this.#token,
      content: options.contentBase64,
      message: options.message,
      branch,
    };

    type PutResponse = { content?: { sha?: string } };
    const data = await this.#json<PutResponse>(
      this.#url(`/contents/${encodePath(options.path)}`),
      {
        method: 'PUT',
        headers: this.#headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(body),
      },
      options.path,
    );

    return { sha: data.content?.sha ?? null };
  }
}

export const gitee = new GiteeClient();
