/**
 * Sync tests run against a **local bare repository**, so the whole publish and
 * inbound path is exercised without touching the network.
 *
 * The most important test here is that a publish never removes an inbound
 * prompt. That failure mode is silent — and it is why outbound and inbound live
 * on separate branches: outbound is amended and force-pushed, which would take
 * an un-fetched prompt with it if the two shared a branch.
 */

import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import { git, gitOrThrow } from '../src/git.js';
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
