/**
 * Sync tests run against a **local bare repository**, so the whole publish and
 * inbound path is exercised without touching the network.
 *
 * The most important test here is that a publish never removes an inbound
 * prompt. That failure mode is silent — a force-push or a careless `git add -A`
 * would delete a prompt the phone had written but the bridge had not fetched,
 * and nothing would report it.
 */

import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import { git, gitOrThrow } from '../src/git.js';
import { RelaySync } from '../src/sync.js';

let root: string;
let remote: string;
let bridgeClone: string;
let phoneClone: string;
let outDir: string;

const BRANCH = 'relay';

/** Create a bare remote with an initial commit on the relay branch. */
async function seedRemote(): Promise<void> {
  await gitOrThrow(['init', '--bare', '--initial-branch', BRANCH, remote], { cwd: root });

  const seed = join(root, 'seed');
  await mkdir(seed, { recursive: true });
  await gitOrThrow(['init', '--initial-branch', BRANCH], { cwd: seed });
  await gitOrThrow(['config', 'user.email', 'seed@example.com'], { cwd: seed });
  await gitOrThrow(['config', 'user.name', 'seed'], { cwd: seed });
  await writeFile(join(seed, 'README.md'), '# relay\n');
  await gitOrThrow(['add', '-A'], { cwd: seed });
  await gitOrThrow(['commit', '-m', 'seed'], { cwd: seed });
  await gitOrThrow(['remote', 'add', 'origin', remote], { cwd: seed });
  await gitOrThrow(['push', 'origin', BRANCH], { cwd: seed });
}

/** A second working copy standing in for the phone. */
async function cloneForPhone(): Promise<void> {
  await gitOrThrow(['clone', '--branch', BRANCH, remote, phoneClone], { cwd: root });
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
  await gitOrThrow(['fetch', 'origin', BRANCH], { cwd: phoneClone });
  await gitOrThrow(['reset', '--hard', `origin/${BRANCH}`], { cwd: phoneClone });

  const dir = join(phoneClone, 'in', sessionId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), JSON.stringify(body));
  await gitOrThrow(['add', '-A'], { cwd: phoneClone });
  await gitOrThrow(['commit', '-m', `prompt ${name}`], { cwd: phoneClone });
  await gitOrThrow(['push', 'origin', BRANCH], { cwd: phoneClone });
}

async function makeSync(): Promise<RelaySync> {
  const sync = new RelaySync({
    repoUrl: remote,
    token: null,
    branch: BRANCH,
    cloneDir: bridgeClone,
    outDir,
  });
  await sync.init();
  return sync;
}

async function writeChunk(sessionId: string, content: string): Promise<void> {
  const dir = join(outDir, 'sessions', sessionId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'events-0001.jsonl'), content);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ccr-sync-'));
  remote = join(root, 'remote.git');
  bridgeClone = join(root, 'bridge');
  phoneClone = join(root, 'phone');
  outDir = join(root, 'out');

  await seedRemote();
  await cloneForPhone();
});

describe('RelaySync', () => {
  it('publishes local chunks to the remote', async () => {
    await writeChunk('sess-1', '{"seq":1,"kind":"assistant_text"}\n');
    const sync = await makeSync();

    expect(await sync.publish('relay: update')).toBe('pushed');

    // Visible from another clone, i.e. the phone would see it.
    await gitOrThrow(['pull', 'origin', BRANCH], { cwd: phoneClone });
    const text = await readFile(
      join(phoneClone, 'out', 'sessions', 'sess-1', 'events-0001.jsonl'),
      'utf8',
    );
    expect(text).toContain('"seq":1');
  });

  it('uses its own repository even when the clone sits inside another one', async () => {
    // Regression: the clone defaulted to a directory inside the project's own
    // repository. `git rev-parse --git-dir` walked up, found the enclosing .git,
    // reported success, and the bridge then staged into the *project* repo
    // instead of the relay — failing on an ignored path and pushing nothing.
    const outer = join(root, 'outer');
    await mkdir(outer, { recursive: true });
    await gitOrThrow(['init', '--initial-branch', 'main'], { cwd: outer });
    await gitOrThrow(['config', 'user.email', 'outer@example.com'], { cwd: outer });
    await gitOrThrow(['config', 'user.name', 'outer'], { cwd: outer });
    await writeFile(join(outer, '.gitignore'), 'nested/\n');
    await gitOrThrow(['add', '-A'], { cwd: outer });
    await gitOrThrow(['commit', '-m', 'outer'], { cwd: outer });

    const nested = join(outer, 'nested', 'repo');
    await writeChunk('sess-1', '{"seq":1}\n');

    const sync = new RelaySync({
      repoUrl: remote,
      token: null,
      branch: BRANCH,
      cloneDir: nested,
      outDir,
    });
    await sync.init();
    expect(await sync.publish('relay: nested')).toBe('pushed');

    // The enclosing repository must be completely untouched — no staged files,
    // no commits, nothing added to its index.
    const status = await git(['status', '--porcelain'], { cwd: outer });
    expect(status.stdout.trim()).toBe('');

    // And the relay received the data — the commit went to the clone, not to
    // the enclosing repository.
    const tree = await git(['ls-tree', '-r', '--name-only', `refs/heads/${BRANCH}`], {
      cwd: remote,
    });
    expect(tree.stdout).toContain('out/sessions/sess-1/events-0001.jsonl');

    await gitOrThrow(['pull', 'origin', BRANCH], { cwd: phoneClone });
    expect(existsSync(join(phoneClone, 'out', 'sessions', 'sess-1', 'events-0001.jsonl'))).toBe(
      true,
    );
  });

  it('rewrites a stale remote rather than fetching from the wrong repository', async () => {
    // Retries with backoff make this slower than the default allowance.
    // Regression: an existing clone was trusted as long as *some* remote was
    // configured. Re-pointing CCR_REPO_URL then left the clone fetching from
    // the old repository while pushing to the new one — which appears to work
    // and fails confusingly later.
    const first = await makeSync();
    await writeChunk('sess-1', '{"seq":1}\n');
    expect(await first.publish('first')).toBe('pushed');

    // A second, independent relay.
    const other = join(root, 'other.git');
    await gitOrThrow(['init', '--bare', '--initial-branch', BRANCH, other], { cwd: root });

    const second = new RelaySync({
      repoUrl: other,
      token: null,
      branch: BRANCH,
      cloneDir: bridgeClone,
      outDir,
    });
    await second.init();

    const url = await git(['remote', 'get-url', 'origin'], { cwd: bridgeClone });
    expect(url.stdout.trim()).toBe(other);

    await writeChunk('sess-2', '{"seq":1}\n');
    expect(existsSync(join(outDir, 'sessions', 'sess-2', 'events-0001.jsonl'))).toBe(true);

    // Also guards the fixed bug: a failed push must never be reported as
    // 'clean', which would tell the caller there is nothing left to send.
    expect(await second.publish('second')).toBe('pushed');

    const tree = await git(['ls-tree', '-r', '--name-only', `refs/heads/${BRANCH}`], { cwd: other });
    expect(tree.stdout).toContain('out/sessions/sess-2/events-0001.jsonl');
  });

  it('reports nothing to do when the tree is unchanged', async () => {
    await writeChunk('sess-1', '{"seq":1}\n');
    const sync = await makeSync();

    expect(await sync.publish('first')).toBe('pushed');
    expect(await sync.publish('second')).toBe('clean');
  });

  it('picks up later changes', async () => {
    await writeChunk('sess-1', '{"seq":1}\n');
    const sync = await makeSync();
    await sync.publish('first');

    await writeChunk('sess-2', '{"seq":1}\n');
    expect(await sync.publish('second')).toBe('pushed');
  });

  describe('the inbound safety property', () => {
    it('never removes a prompt written by the phone', async () => {
      await phoneWritesPrompt('sess-1', '1700000000-aaa.json', { version: 1, text: 'hello' });

      // The bridge publishes without having consumed the prompt first.
      await writeChunk('sess-1', '{"seq":1}\n');
      const sync = await makeSync();
      await sync.publish('relay: update');

      // It must still be there, locally and on the remote.
      expect(existsSync(join(bridgeClone, 'in', 'sess-1', '1700000000-aaa.json'))).toBe(true);

      await gitOrThrow(['pull', 'origin', BRANCH], { cwd: phoneClone });
      const survived = await readFile(
        join(phoneClone, 'in', 'sess-1', '1700000000-aaa.json'),
        'utf8',
      );
      expect(JSON.parse(survived).text).toBe('hello');
    });

    it('survives a publish that races the phone writing a prompt', async () => {
      const sync = await makeSync();

      await writeChunk('sess-1', '{"seq":1}\n');
      await sync.publish('first');

      // Phone commits while the bridge is mid-publish.
      await phoneWritesPrompt('sess-1', '1700000001-bbb.json', { version: 1, text: 'second' });
      await writeChunk('sess-1', '{"seq":2}\n');

      // The push is rejected the first time; the retry must merge, not clobber.
      expect(await sync.publish('second')).toBe('pushed');

      await gitOrThrow(['pull', 'origin', BRANCH], { cwd: phoneClone });
      expect(existsSync(join(phoneClone, 'in', 'sess-1', '1700000001-bbb.json'))).toBe(true);
      const chunk = await readFile(
        join(phoneClone, 'out', 'sessions', 'sess-1', 'events-0001.jsonl'),
        'utf8',
      );
      expect(chunk).toContain('"seq":2');
    });
  });

  describe('reading inbound prompts', () => {
    it('lists prompts the phone has written', async () => {
      await phoneWritesPrompt('sess-1', '1700000000-aaa.json', { version: 1, text: 'one' });
      await phoneWritesPrompt('sess-2', '1700000001-bbb.json', { version: 1, text: 'two' });

      const sync = await makeSync();
      const found = await sync.listInbound();

      expect(found.sort()).toEqual([
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
      expect(existsSync(join(bridgeClone, 'in', '.done'))).toBe(true);
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
