/**
 * Publishing to and reading from the relay repository.
 *
 * **Two branches, deliberately separate.**
 *
 * Outbound data is rewritten: each publish amends a single commit and
 * force-pushes, so a repository receiving a push every few seconds does not
 * accumulate a commit every few seconds. That is only safe because nothing else
 * writes there.
 *
 * Inbound data is append-only and never rewritten. If the two shared a branch,
 * compacting the outbound side would destroy a prompt the phone had written but
 * the bridge had not yet fetched — and it would vanish with no error anywhere.
 * Keeping them apart is what makes compaction safe rather than merely unlikely
 * to hurt.
 *
 * The two also get separate clones, so a force-push on one cannot disturb the
 * working tree of the other.
 */

import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { authenticatedUrl, ensureClone, git, gitOrThrow } from './git.js';

export interface RelayOptions {
  repoUrl: string;
  token: string | null;
  /** Branch the bridge owns and may rewrite. */
  outBranch: string;
  /** Branch the phone writes to; append-only. */
  inBranch: string;
  outCloneDir: string;
  inCloneDir: string;
  /** Local directory of normalized chunks to publish. */
  outDir: string;
  log?: (message: string) => void;
}

export type PublishOutcome = 'pushed' | 'clean' | 'failed';

const MAX_PUSH_ATTEMPTS = 4;
const IN_DIR = 'in';
const IN_DONE_DIR = 'in/.done';

export class RelaySync {
  readonly #options: RelayOptions;
  readonly #log: (message: string) => void;
  #outReady = false;
  #inReady = false;

  constructor(options: RelayOptions) {
    this.#options = options;
    this.#log = options.log ?? ((): void => {});
  }

  get outCloneDir(): string {
    return this.#options.outCloneDir;
  }

  get inCloneDir(): string {
    return this.#options.inCloneDir;
  }

  async init(): Promise<void> {
    const { repoUrl, token, outBranch, inBranch, outCloneDir, inCloneDir } = this.#options;

    await ensureClone({ repoUrl, token, dir: outCloneDir, branch: outBranch });
    this.#outReady = true;

    await ensureClone({ repoUrl, token, dir: inCloneDir, branch: inBranch });
    await this.#openInboundBranch();
    this.#inReady = true;
  }

  /**
   * Create the inbound branch if the relay does not have it yet.
   *
   * Something has to: the phone writes through the Contents API, which needs a
   * branch to write to, and an empty repository has none. Doing it here means
   * the phone never has to handle a first-run case.
   */
  async #openInboundBranch(): Promise<void> {
    const { inBranch, inCloneDir } = this.#options;

    const existing = await git(['rev-parse', '--verify', `refs/remotes/origin/${inBranch}`], {
      cwd: inCloneDir,
    });
    if (existing.code === 0) return;

    await mkdir(join(inCloneDir, IN_DIR), { recursive: true });
    await writeFile(join(inCloneDir, IN_DIR, '.gitkeep'), '');
    await gitOrThrow(['add', '-A', '--', IN_DIR], { cwd: inCloneDir });
    await gitOrThrow(['commit', '-m', 'relay: open inbound channel'], { cwd: inCloneDir });

    const url = authenticatedUrl(this.#options.repoUrl, this.#options.token);
    const pushed = await git(['push', url, `HEAD:${inBranch}`], {
      cwd: inCloneDir,
      bypassProxy: true,
      timeoutMs: 120_000,
    });
    if (pushed.code !== 0) {
      this.#log(`could not open the inbound branch: ${pushed.stderr.trim().split('\n').at(-1) ?? ''}`);
    }
  }

  // -------------------------------------------------------------------------
  // Outbound
  // -------------------------------------------------------------------------

  /**
   * Publish the current local output tree.
   *
   * Returns `clean` only when the remote already holds everything — never
   * merely because there is nothing new to commit. A previous attempt may have
   * committed and then failed to push, and reporting that as clean would tell
   * the caller to stop trying while the data sat on this machine.
   */
  async publish(note: string): Promise<PublishOutcome> {
    if (!this.#outReady) throw new Error('RelaySync.init() must be called first');
    const { outBranch, outCloneDir, outDir } = this.#options;

    for (let attempt = 0; attempt < MAX_PUSH_ATTEMPTS; attempt++) {
      await this.#fastForward(outCloneDir, outBranch);

      // The outbound branch belongs entirely to the bridge, so the mirror is
      // authoritative: whatever is not present locally is removed.
      //
      // Additive copying was the original behaviour and it is wrong. Files from
      // a previous layout, a renamed session, or a pruned one would linger on
      // the relay forever, and a reader would keep seeing them. Nothing else
      // lives on this branch, so nothing else can be lost by clearing it.
      const outSubtree = join(outCloneDir, 'out');
      await rm(outSubtree, { recursive: true, force: true });
      await cp(outDir, outSubtree, { recursive: true, force: true });

      await gitOrThrow(['add', '-A', '--', 'out'], { cwd: outCloneDir });

      const hasHead = (await git(['rev-parse', '--verify', 'HEAD'], { cwd: outCloneDir })).code === 0;
      const staged = await git(['diff', '--cached', '--quiet'], { cwd: outCloneDir });
      const hasStaged = staged.code !== 0;

      if (hasStaged || !hasHead) {
        // Amend rather than accumulate. The tree still contains every chunk ever
        // written — chunk files are never modified or renumbered, only the
        // commit that carries them is rewritten, so a reader's cached blob SHAs
        // stay valid.
        //
        // The first amend rewrites whatever was at the branch tip, since the
        // clone checked that out. That is intended: this branch belongs to the
        // bridge, and file content is preserved regardless — only commit
        // identity changes.
        await gitOrThrow(
          hasHead ? ['commit', '--amend', '-m', note] : ['commit', '-m', note],
          { cwd: outCloneDir },
        );
      } else if (await this.#remoteMatchesHead(outCloneDir, outBranch)) {
        return 'clean';
      }

      const url = authenticatedUrl(this.#options.repoUrl, this.#options.token);
      const pushed = await git(['push', '--force', url, `HEAD:${outBranch}`], {
        cwd: outCloneDir,
        bypassProxy: true,
        timeoutMs: 120_000,
      });

      if (pushed.code === 0) return 'pushed';

      this.#log(
        `push rejected (attempt ${attempt + 1}): ${pushed.stderr.trim().split('\n').at(-1) ?? ''}`,
      );
      await sleep(400 * 2 ** attempt + Math.random() * 300);
    }

    return 'failed';
  }

  /** True when the remote ref points at exactly what we have locally. */
  async #remoteMatchesHead(dir: string, branch: string): Promise<boolean> {
    const local = await git(['rev-parse', 'HEAD'], { cwd: dir });
    const remote = await git(['rev-parse', `refs/remotes/origin/${branch}`], { cwd: dir });
    if (local.code !== 0 || remote.code !== 0) return false;
    return local.stdout.trim() === remote.stdout.trim();
  }

  /** Bring a local branch up to date with its remote, if it has moved. */
  async #fastForward(dir: string, branch: string): Promise<void> {
    const fetched = await git(['fetch', 'origin', branch], {
      cwd: dir,
      bypassProxy: true,
      timeoutMs: 120_000,
    });
    if (fetched.code !== 0) return;

    // Non-fatal: a fresh clone has no local commits to move. A genuine
    // divergence is handled by the caller's retry rather than forced away here.
    await git(['merge', '--ff-only', 'FETCH_HEAD'], { cwd: dir });
  }

  // -------------------------------------------------------------------------
  // Inbound
  // -------------------------------------------------------------------------

  /** Fetch and list prompts the phone has written. */
  async listInbound(): Promise<string[]> {
    if (!this.#inReady) return [];
    const { inBranch, inCloneDir } = this.#options;

    await git(['fetch', 'origin', inBranch], {
      cwd: inCloneDir,
      bypassProxy: true,
      timeoutMs: 120_000,
    });
    await git(['merge', '--ff-only', 'FETCH_HEAD'], { cwd: inCloneDir });

    const dir = join(inCloneDir, IN_DIR);
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
      return JSON.parse(await readFile(join(this.#options.inCloneDir, IN_DIR, relativePath), 'utf8'));
    } catch {
      return null;
    }
  }

  /**
   * Move consumed prompts aside and publish the move.
   *
   * Moved rather than deleted: the file is the record of what was run, and
   * deleting from an append-only branch is the more dangerous option. The push
   * is a plain fast-forward — this branch is never force-pushed.
   */
  async markConsumed(relativePaths: readonly string[]): Promise<void> {
    if (relativePaths.length === 0 || !this.#inReady) return;
    const { inCloneDir } = this.#options;

    await mkdir(join(inCloneDir, IN_DONE_DIR), { recursive: true });

    for (const relative of relativePaths) {
      const from = join(inCloneDir, IN_DIR, relative);
      const to = join(inCloneDir, IN_DONE_DIR, relative.replace(/[/\\]/g, '__'));
      await rename(from, to).catch(() => {});
    }

    await gitOrThrow(['add', '-A', '--', IN_DIR], { cwd: inCloneDir });
    const staged = await git(['diff', '--cached', '--quiet'], { cwd: inCloneDir });
    if (staged.code === 0) return;

    await gitOrThrow(['commit', '-m', 'relay: consume inbound prompts'], { cwd: inCloneDir });

    const url = authenticatedUrl(this.#options.repoUrl, this.#options.token);
    await git(['push', url, `HEAD:${this.#options.inBranch}`], {
      cwd: inCloneDir,
      bypassProxy: true,
      timeoutMs: 120_000,
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
