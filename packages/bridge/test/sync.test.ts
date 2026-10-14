/**
 * Sync tests run against a **local bare repository**, so the whole publish and
 * inbound path is exercised without touching the network.
 *
 * The most important test here is that a publish never removes an inbound
 * prompt. That failure mode is silent — and it is why outbound and inbound live
 * on separate branches: outbound is amended and force-pushed, which would take
 * an un-fetched prompt with it if the two shared a branch.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import { ensureClone, fetchArgs, git, gitOrThrow } from '../src/git.js';
import { RelaySync } from '../src/sync.js';

const OUT = 'relay-out';
const IN = 'relay-in';

let root: string;
let remote: string;
let outClone: string;
let inClone: string;
let phoneClone: string;
let outDir: string;

/** Create a bare remote holding both branches. */
async function seedRemote(): Promise<void> {
  await gitOrThrow(['init', '--bare', remote], { cwd: root });

  const seed = join(root, 'seed');
  await mkdir(seed, { recursive: true });
  await gitOrThrow(['init', '--initial-branch', OUT], { cwd: seed });
  await gitOrThrow(['config', 'user.email', 'seed@example.com'], { cwd: seed });
  await gitOrThrow(['config', 'user.name', 'seed'], { cwd: seed });
  await writeFile(join(seed, 'README.md'), '# relay\n');
  await gitOrThrow(['add', '-A'], { cwd: seed });
  await gitOrThrow(['commit', '-m', 'seed'], { cwd: seed });
  await gitOrThrow(['remote', 'add', 'origin', remote], { cwd: seed });

  await gitOrThrow(['push', 'origin', `${OUT}:${OUT}`], { cwd: seed });
  // The inbound branch must exist before the phone can clone it.
  await gitOrThrow(['push', 'origin', `${OUT}:${IN}`], { cwd: seed });
}

/** A second working copy standing in for the phone, on the inbound branch. */
async function cloneForPhone(): Promise<void> {
  await gitOrThrow(['clone', '--branch', IN, remote, phoneClone], { cwd: root });
  await gitOrThrow(['config', 'user.email', 'phone@example.com'], { cwd: phoneClone });
  await gitOrThrow(['config', 'user.name', 'phone'], { cwd: phoneClone });
}

/**
 * Write a prompt the way the phone does.
 *
 * The real phone uses the Contents API, which commits against whatever the
 * remote head currently is — it has no stale local branch to be rejected. The
 * reset reproduces that; without it this helper would fail whenever the bridge
 * has published in the meantime, which is a flaw in the test, not the code.
 */
async function phoneWritesPrompt(sessionId: string, name: string, body: unknown): Promise<void> {
  await gitOrThrow(['fetch', 'origin', IN], { cwd: phoneClone });
  await gitOrThrow(['reset', '--hard', `origin/${IN}`], { cwd: phoneClone });

  const dir = join(phoneClone, 'in', sessionId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), JSON.stringify(body));
  await gitOrThrow(['add', '-A'], { cwd: phoneClone });
  await gitOrThrow(['commit', '-m', `prompt ${name}`], { cwd: phoneClone });
  await gitOrThrow(['push', 'origin', IN], { cwd: phoneClone });
}

function relayOptions(over: Partial<ConstructorParameters<typeof RelaySync>[0]> = {}) {
  return {
    repoUrl: remote,
    token: null,
    outBranch: OUT,
    inBranch: IN,
    outCloneDir: outClone,
    inCloneDir: inClone,
    outDir,
    ...over,
  };
}

async function makeSync(): Promise<RelaySync> {
  const sync = new RelaySync(relayOptions());
  await sync.init();
  return sync;
}

async function writeChunk(sessionId: string, content: string): Promise<void> {
  const dir = join(outDir, 'sessions', sessionId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'events-0001.jsonl'), content);
}

/** Pull the inbound branch into the phone clone and read a path from it. */
async function readFromRemote(path: string): Promise<string | null> {
  await gitOrThrow(['fetch', 'origin', IN], { cwd: phoneClone });
  const result = await git(['show', `origin/${IN}:${path}`], { cwd: phoneClone });
  return result.code === 0 ? result.stdout : null;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ccr-sync-'));
  remote = join(root, 'remote.git');
  outClone = join(root, 'out-clone');
  inClone = join(root, 'in-clone');
  phoneClone = join(root, 'phone');
  outDir = join(root, 'out');

  await seedRemote();
  await cloneForPhone();
});

describe('RelaySync', () => {
  it('publishes local chunks to the outbound branch', async () => {
    await writeChunk('sess-1', '{"seq":1,"kind":"assistant_text"}\n');
    const sync = await makeSync();

    expect(await sync.publish('relay: update')).toBe('pushed');

    const tree = await git(['ls-tree', '-r', '--name-only', `refs/heads/${OUT}`], { cwd: remote });
    expect(tree.stdout).toContain('out/sessions/sess-1/events-0001.jsonl');
  });

  it('keeps outbound history at a single commit', async () => {
    // The whole point of the branch split: publishing every few seconds must not
    // add a commit every few seconds.
    const sync = await makeSync();

    for (let i = 1; i <= 5; i++) {
      await writeChunk(`sess-${i}`, `{"seq":${i}}\n`);
      expect(await sync.publish(`publish ${i}`)).toBe('pushed');
    }

    const log = await git(['rev-list', '--count', `refs/heads/${OUT}`], { cwd: remote });
    // Exactly one commit, no matter how many publishes. The first amend rewrites
    // whatever was at the branch tip — the seed here, nothing on a fresh relay —
    // and every later publish rewrites that same commit again.
    expect(Number.parseInt(log.stdout.trim(), 10)).toBe(1);

    // And every chunk is still present — amending rewrites the commit, never the
    // files, so a reader's cached blob SHAs stay valid.
    const tree = await git(['ls-tree', '-r', '--name-only', `refs/heads/${OUT}`], { cwd: remote });
    for (let i = 1; i <= 5; i++) {
      expect(tree.stdout).toContain(`out/sessions/sess-${i}/events-0001.jsonl`);
    }
  });

  it('reports nothing to do when the outbound branch already matches', async () => {
    await writeChunk('sess-1', '{"seq":1}\n');
    const sync = await makeSync();

    expect(await sync.publish('first')).toBe('pushed');
    expect(await sync.publish('second')).toBe('clean');
  });

  it('uses its own repository even when the clone sits inside another one', async () => {
    // Regression: the clone defaulted to a directory inside the project's own
    // repository. `git rev-parse --git-dir` walked up, found the enclosing .git,
    // reported success, and the bridge then staged into the *project* repo
    // instead of the relay.
    const outer = join(root, 'outer');
    await mkdir(outer, { recursive: true });
    await gitOrThrow(['init', '--initial-branch', 'main'], { cwd: outer });
    await gitOrThrow(['config', 'user.email', 'outer@example.com'], { cwd: outer });
    await gitOrThrow(['config', 'user.name', 'outer'], { cwd: outer });
    await writeFile(join(outer, '.gitignore'), 'nested/\n');
    await gitOrThrow(['add', '-A'], { cwd: outer });
    await gitOrThrow(['commit', '-m', 'outer'], { cwd: outer });

    await writeChunk('sess-1', '{"seq":1}\n');
    const sync = new RelaySync(
      relayOptions({
        outCloneDir: join(outer, 'nested', 'out'),
        inCloneDir: join(outer, 'nested', 'in'),
      }),
    );
    await sync.init();
    expect(await sync.publish('relay: nested')).toBe('pushed');

    // The enclosing repository must be completely untouched.
    const status = await git(['status', '--porcelain'], { cwd: outer });
    expect(status.stdout.trim()).toBe('');

    const tree = await git(['ls-tree', '-r', '--name-only', `refs/heads/${OUT}`], { cwd: remote });
    expect(tree.stdout).toContain('out/sessions/sess-1/events-0001.jsonl');
  });

  it('rewrites a stale remote rather than fetching from the wrong repository', async () => {
    const first = await makeSync();
    await writeChunk('sess-1', '{"seq":1}\n');
    expect(await first.publish('first')).toBe('pushed');

    const other = join(root, 'other.git');
    await gitOrThrow(['init', '--bare', other], { cwd: root });

    const second = new RelaySync(relayOptions({ repoUrl: other }));
    await second.init();

    const url = await git(['remote', 'get-url', 'origin'], { cwd: outClone });
    expect(url.stdout.trim()).toBe(other);

    await writeChunk('sess-2', '{"seq":1}\n');
    expect(await second.publish('second')).toBe('pushed');

    const tree = await git(['ls-tree', '-r', '--name-only', `refs/heads/${OUT}`], { cwd: other });
    expect(tree.stdout).toContain('out/sessions/sess-2/events-0001.jsonl');
  });

  describe('the inbound safety property', () => {
    it('never removes a prompt written by the phone', async () => {
      await phoneWritesPrompt('sess-1', '1700000000-aaa.json', { version: 1, text: 'hello' });

      // The bridge publishes without having consumed the prompt first.
      await writeChunk('sess-1', '{"seq":1}\n');
      const sync = await makeSync();
      await sync.publish('relay: update');

      expect(existsSync(join(inClone, 'in', 'sess-1', '1700000000-aaa.json'))).toBe(true);
      expect(await readFromRemote('in/sess-1/1700000000-aaa.json')).toContain('hello');
    });

    it('survives a publish that races the phone writing a prompt', async () => {
      const sync = await makeSync();
      await writeChunk('sess-1', '{"seq":1}\n');
      await sync.publish('first');

      await phoneWritesPrompt('sess-1', '1700000001-bbb.json', { version: 1, text: 'second' });
      await writeChunk('sess-1', '{"seq":2}\n');

      expect(await sync.publish('second')).toBe('pushed');

      // The force-push on the outbound branch must not have touched inbound.
      expect(await readFromRemote('in/sess-1/1700000001-bbb.json')).toContain('second');
    });

    it('survives repeated outbound force-pushes', async () => {
      await phoneWritesPrompt('sess-1', '1700000002-ccc.json', { version: 1, text: 'keep me' });
      const sync = await makeSync();

      for (let i = 1; i <= 4; i++) {
        await writeChunk('sess-1', `{"seq":${i}}\n`);
        await sync.publish(`publish ${i}`);
      }

      expect(await readFromRemote('in/sess-1/1700000002-ccc.json')).toContain('keep me');
    });
  });

  describe('opening the inbound channel', () => {
    it('creates the inbound branch when the relay does not have one', async () => {
      // The phone writes through an API that needs a branch to exist, and an
      // empty repository has none. Bootstrapping here means the phone never has
      // to handle a first-run case.
      await gitOrThrow(['push', 'origin', '--delete', IN], { cwd: phoneClone });

      const gone = await git(['ls-remote', '--heads', remote, IN], { cwd: root });
      expect(gone.stdout.trim()).toBe('');

      await makeSync();

      const back = await git(['ls-remote', '--heads', remote, IN], { cwd: root });
      expect(back.stdout).toContain(IN);
    });

    it('leaves an existing inbound branch alone', async () => {
      const before = await git(['rev-parse', `refs/heads/${IN}`], { cwd: remote });
      await makeSync();
      const after = await git(['rev-parse', `refs/heads/${IN}`], { cwd: remote });
      expect(after.stdout.trim()).toBe(before.stdout.trim());
    });
  });

  describe('reading inbound prompts', () => {
    it('lists prompts the phone has written', async () => {
      await phoneWritesPrompt('sess-1', '1700000000-aaa.json', { version: 1, text: 'one' });
      await phoneWritesPrompt('sess-2', '1700000001-bbb.json', { version: 1, text: 'two' });

      const sync = await makeSync();
      expect((await sync.listInbound()).sort()).toEqual([
        join('sess-1', '1700000000-aaa.json'),
        join('sess-2', '1700000001-bbb.json'),
      ]);
    });

    it('reads a prompt back', async () => {
      await phoneWritesPrompt('sess-1', '1700000000-aaa.json', { version: 1, text: 'hello' });

      const sync = await makeSync();
      const [first] = await sync.listInbound();
      const body = await sync.readInbound(first!);
      expect((body as { text: string }).text).toBe('hello');
    });

    it('returns null rather than throwing for a missing prompt', async () => {
      const sync = await makeSync();
      expect(await sync.readInbound('nope.json')).toBeNull();
    });

    it('returns an empty list when nothing has been written', async () => {
      const sync = await makeSync();
      expect(await sync.listInbound()).toEqual([]);
    });

    it('stops listing a prompt once it has been consumed', async () => {
      await phoneWritesPrompt('sess-1', '1700000000-aaa.json', { version: 1, text: 'hello' });

      const sync = await makeSync();
      const found = await sync.listInbound();
      expect(found).toHaveLength(1);

      await sync.markConsumed(found);

      expect(await sync.listInbound()).toEqual([]);
      // Moved aside, not deleted — it is the record of what was run.
      expect(existsSync(join(inClone, 'in', '.done'))).toBe(true);
      expect(await readFromRemote('in/.done/sess-1__1700000000-aaa.json')).toContain('hello');
    });
  });

  describe('recovering a consume whose push failed', () => {
    /**
     * Refuse every push, the way a transient failure would.
     *
     * A hook on the bare remote rather than a stubbed transport, so the whole
     * path — commit, push, rejection — is the real one.
     */
    async function refusePushes(): Promise<void> {
      await writeFile(join(remote, 'hooks', 'pre-receive'), '#!/bin/sh\necho refused >&2\nexit 1\n', {
        mode: 0o755,
      });
    }

    async function allowPushes(): Promise<void> {
      await rm(join(remote, 'hooks', 'pre-receive'), { force: true });
    }

    it('does not silently ignore prompts written after the failed push', async () => {
      await phoneWritesPrompt('sess-1', '1700000000-aaa.json', { version: 1, text: 'first' });
      const sync = await makeSync();

      const first = await sync.listInbound();
      expect(first).toEqual([join('sess-1', '1700000000-aaa.json')]);

      // The consume is committed locally, and the push carrying it is rejected.
      await refusePushes();
      await sync.markConsumed(first);
      expect(await readFromRemote('in/sess-1/1700000000-aaa.json')).toContain('first');
      await allowPushes();

      // The phone writes its next prompt on top of the remote head, which the
      // local clone has now diverged from. `merge --ff-only` can never succeed
      // again, and ignoring that left the working tree frozen: the prompt was
      // fetched but never listed, so it was ignored for good.
      await phoneWritesPrompt('sess-1', '1700000001-bbb.json', { version: 1, text: 'second' });

      const second = await sync.listInbound();
      expect(second).toEqual([join('sess-1', '1700000001-bbb.json')]);

      // Recovery resets to the remote head before re-applying the moves, so the
      // prompt we had already run must not come back as one to run again.
      expect(existsSync(join(inClone, 'in', 'sess-1', '1700000000-aaa.json'))).toBe(false);
      expect(existsSync(join(inClone, 'in', '.done', 'sess-1__1700000000-aaa.json'))).toBe(true);
      expect(await readFromRemote('in/.done/sess-1__1700000000-aaa.json')).toContain('first');
    });

    it('keeps listing prompts it never consumed', async () => {
      // The other half of the safety property: the reset must not lose a prompt
      // the bridge had not acted on yet.
      await phoneWritesPrompt('sess-1', '1700000000-aaa.json', { version: 1, text: 'run me' });
      await phoneWritesPrompt('sess-1', '1700000001-bbb.json', { version: 1, text: 'and me' });

      const sync = await makeSync();
      const found = await sync.listInbound();
      expect(found).toHaveLength(2);

      // Consume only the first, and fail the push that records it.
      await refusePushes();
      await sync.markConsumed([found[0]!]);
      await allowPushes();

      // Divergence is forced by a third prompt landing on the older remote head.
      await phoneWritesPrompt('sess-1', '1700000002-ccc.json', { version: 1, text: 'third' });

      const after = await sync.listInbound();
      // The unconsumed one is still there, alongside the new one.
      expect(after.sort()).toEqual([
        join('sess-1', '1700000001-bbb.json'),
        join('sess-1', '1700000002-ccc.json'),
      ]);
    });
  });
});

describe('fetching with credentials', () => {
  /**
   * Observe the URL git actually used.
   *
   * `GIT_TRACE` records the command line to a file, which is the only way to
   * see it without a network. The address is a discard port, so the fetch fails
   * at once — what is under test is what was attempted.
   */
  async function traceOf(run: () => Promise<void>): Promise<string> {
    const trace = join(root, 'git-trace.log');
    const previous = process.env['GIT_TRACE'];
    process.env['GIT_TRACE'] = trace;
    try {
      await run();
    } finally {
      if (previous === undefined) delete process.env['GIT_TRACE'];
      else process.env['GIT_TRACE'] = previous;
    }
    return readFile(trace, 'utf8');
  }

  /** Nothing listens here, and it refuses immediately. */
  const unreachable = 'http://127.0.0.1:9/relay.git';

  it('puts the token in the fetch URL, and never in the clone config', async () => {
    // Fetching from `origin` uses the configured URL, which deliberately has no
    // credential in it — so it is anonymous, and only works where a credential
    // manager happens to hold a cached token. That is the worst shape a bug can
    // have: it works on the machine that never tests it.
    const dir = join(root, 'authed-clone');
    const trace = await traceOf(async () => {
      await ensureClone({ repoUrl: unreachable, token: 'tok-abc', dir, branch: OUT });
    });

    expect(trace).toContain('oauth2:tok-abc@127.0.0.1');
    expect(await readFile(join(dir, '.git', 'config'), 'utf8')).not.toContain('tok-abc');
  });

  it(
    'authenticates every fetch the sync layer makes',
    async () => {
      const sync = new RelaySync(relayOptions({ repoUrl: unreachable, token: 'tok-abc' }));
      const trace = await traceOf(async () => {
        await sync.init();
        await sync.listInbound();
      });

      // Both clones, and the inbound refresh. Publish uses the same helper.
      expect(trace.match(/oauth2:tok-abc@127\.0\.0\.1:9/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    },
    // Seventeen git processes, each with Windows' spawn cost.
    30_000,
  );

  it('never fetches from the bare configured URL', async () => {
    // The exact command git ran is the only place the two are distinguishable.
    const args = fetchArgs({ repoUrl: 'https://gitee.com/o/r.git', token: 'tok-abc', branch: OUT });
    expect(args[0]).toBe('fetch');
    expect(args[1]).toBe('https://oauth2:tok-abc@gitee.com/o/r.git');
    // The destination refspec is explicit because fetching by URL does not
    // update `refs/remotes/origin/<branch>`; forced, because the outbound branch
    // is force-pushed on every publish.
    expect(args[2]).toBe(`+${OUT}:refs/remotes/origin/${OUT}`);
    expect(args).not.toContain('origin');
  });
});

describe('git', () => {
  it('strips proxy variables for relay operations', async () => {
    const { gitEnv } = await import('../src/git.js');
    const env = gitEnv({
      bypassProxy: true,
      base: { HTTPS_PROXY: 'http://127.0.0.1:7890', PATH: '/usr/bin' },
    });

    expect(env['HTTPS_PROXY']).toBeUndefined();
    expect(env['NO_PROXY']).toBe('*');
    expect(env['PATH']).toBe('/usr/bin');
  });

  it('leaves the environment alone when not bypassing', async () => {
    const { gitEnv } = await import('../src/git.js');
    const env = gitEnv({ bypassProxy: false, base: { HTTPS_PROXY: 'http://127.0.0.1:7890' } });
    expect(env['HTTPS_PROXY']).toBe('http://127.0.0.1:7890');
  });

  it('embeds a token in an authenticated URL without persisting it elsewhere', async () => {
    const { authenticatedUrl } = await import('../src/git.js');
    const url = authenticatedUrl('https://gitee.com/owner/repo.git', 'tok123');
    expect(url).toContain('oauth2');
    expect(url).toContain('tok123');
  });

  it('passes a non-URL remote through unchanged', async () => {
    const { authenticatedUrl } = await import('../src/git.js');
    expect(authenticatedUrl('/tmp/some/repo.git', 'tok')).toBe('/tmp/some/repo.git');
  });

  it('reports a failing command instead of throwing', async () => {
    const result = await git(['rev-parse', '--git-dir'], { cwd: root });
    expect(result.code).not.toBe(0);
  });
});
