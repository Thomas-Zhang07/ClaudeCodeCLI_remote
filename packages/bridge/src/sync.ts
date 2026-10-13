/**
 * Publishing to and reading from the relay repository.
 *
 * The safety property that matters most here: **`in/` is never staged.** Only
 * `out/` is ever added to a commit. A squash, a force-push, or a careless `add
 * -A` could otherwise destroy a prompt the phone had written but the bridge had
 * not yet fetched, and it would vanish with no error anywhere.
 *
 * Publishing is a fetch → fast-forward → mirror → commit → push loop. Because
 * the phone commits to the same branch through the API, losing the race is
 * routine rather than exceptional, so a rejection is retried with jitter rather
 * than treated as a failure.
 */

import { cp, mkdir, readdir, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

import { authenticatedUrl, ensureClone, git, gitEnv, gitOrThrow } from './git.js';

export interface RelayOptions {
  repoUrl: string;
  token: string | null;
  branch: string;
  /** Local clone of the relay repository. */
  cloneDir: string;
  /** Local directory of normalized chunks to publish. */
  outDir: string;
  log?: (message: string) => void;
}

export type PublishOutcome = 'pushed' | 'clean' | 'failed';

const MAX_PUSH_ATTEMPTS = 5;
/** Inbound prompts waiting to be injected. */
const IN_DIR = 'in';
const IN_DONE_DIR = 'in/.done';

export class RelaySync {
  readonly #options: RelayOptions;
  readonly #log: (message: string) => void;
  #ready = false;

  constructor(options: RelayOptions) {
    this.#options = options;
    this.#log = options.log ?? ((): void => {});
  }

  get cloneDir(): string {
    return this.#options.cloneDir;
  }

  async init(): Promise<void> {
    await ensureClone({
      repoUrl: this.#options.repoUrl,
      token: this.#options.token,
      dir: this.#options.cloneDir,
      branch: this.#options.branch,
    });
    this.#ready = true;
  }

  /**
   * Publish the current local output tree.
   *
   * Returns `clean` when there was nothing to send, which is the common case —
   * a session that produced no new events has nothing to say.
   */
  async publish(note: string): Promise<PublishOutcome> {
    if (!this.#ready) throw new Error('RelaySync.init() must be called first');
    const { branch, cloneDir, outDir } = this.#options;

    for (let attempt = 0; attempt < MAX_PUSH_ATTEMPTS; attempt++) {
      await this.#fastForward();

      // Mirror only `out/`. Copying is additive: files absent locally are left
      // alone, so nothing the phone wrote can be removed by a publish.
      await cp(outDir, join(cloneDir, 'out'), { recursive: true, force: true });

      await gitOrThrow(['add', '-A', '--', 'out'], { cwd: cloneDir });

      const staged = await git(['diff', '--cached', '--quiet'], { cwd: cloneDir });
      if (staged.code === 0) return 'clean';

      await gitOrThrow(['commit', '-m', note], { cwd: cloneDir });

      const url = authenticatedUrl(this.#options.repoUrl, this.#options.token);
      const pushed = await git(['push', url, `HEAD:${branch}`], {
        cwd: cloneDir,
        bypassProxy: true,
        timeoutMs: 120_000,
      });

      if (pushed.code === 0) return 'pushed';

      // Almost always the phone committing underneath us. Fetch, fast-forward,
      // and try again with the newer history.
      this.#log(`push rejected (attempt ${attempt + 1}), retrying after fast-forward`);
      await sleep(400 * 2 ** attempt + Math.random() * 300);
    }

    return 'failed';
  }

  /** Bring the local branch up to date with the remote, if it has moved. */
  async #fastForward(): Promise<void> {
    const { branch, cloneDir } = this.#options;

    const fetched = await git(['fetch', 'origin', branch], {
      cwd: cloneDir,
      bypassProxy: true,
      timeoutMs: 120_000,
    });
    if (fetched.code !== 0) return;

    // Non-fatal: a fresh clone has no local commits to move, and a divergence
    // is handled by the caller's retry rather than forced away.
    await git(['merge', '--ff-only', 'FETCH_HEAD'], { cwd: cloneDir });
  }

  // -------------------------------------------------------------------------
  // Inbound
  // -------------------------------------------------------------------------

  /**
   * Fetch and list prompts the phone has written.
   *
   * Files under `in/.done/` are already consumed and skipped.
   */
  async listInbound(): Promise<string[]> {
    const { branch, cloneDir } = this.#options;

    await git(['fetch', 'origin', branch], { cwd: cloneDir, bypassProxy: true, timeoutMs: 120_000 });
    await git(['merge', '--ff-only', 'FETCH_HEAD'], { cwd: cloneDir });

    const dir = join(cloneDir, IN_DIR);
    const names: string[] = [];

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return names; // No inbound directory yet.
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === '.done') continue;
      // Layout is in/<sessionId>/<ts>-<rand>.json.
      const sessionDir = join(dir, entry.name);
      for (const file of await readdir(sessionDir).catch(() => [])) {
        if (file.endsWith('.json')) names.push(join(entry.name, file));
      }
    }

    return names;
  }

  async readInbound(relativePath: string): Promise<unknown> {
    try {
      return JSON.parse(await readFile(join(this.#options.cloneDir, IN_DIR, relativePath), 'utf8'));
    } catch {
      return null;
    }
  }

  /**
   * Move consumed prompts aside and publish the move.
   *
   * Moved rather than deleted: the file is evidence of what was run, and the
   * prohibition on rewriting history makes deletion the more dangerous option.
   */
  async markConsumed(relativePaths: readonly string[]): Promise<void> {
    if (relativePaths.length === 0) return;
    const { cloneDir } = this.#options;

    await mkdir(join(cloneDir, IN_DONE_DIR), { recursive: true });

    for (const relative of relativePaths) {
      const from = join(cloneDir, IN_DIR, relative);
      const to = join(cloneDir, IN_DONE_DIR, relative.replace(/[/\\]/g, '__'));
      await rename(from, to).catch(() => {});
    }

    await gitOrThrow(['add', '-A', '--', IN_DIR], { cwd: cloneDir });
    const staged = await git(['diff', '--cached', '--quiet'], { cwd: cloneDir });
    if (staged.code === 0) return;

    await gitOrThrow(['commit', '-m', 'relay: consume inbound prompts'], { cwd: cloneDir });

    const url = authenticatedUrl(this.#options.repoUrl, this.#options.token);
    await git(['push', url, `HEAD:${this.#options.branch}`], {
      cwd: cloneDir,
      bypassProxy: true,
      timeoutMs: 120_000,
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { gitEnv };
