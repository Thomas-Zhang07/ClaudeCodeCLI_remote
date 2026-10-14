/**
 * A session that has ended has to say so, on the relay, without being told twice.
 *
 * The reported failure: a `ccr` session was closed on the PC and the phone went
 * on showing it as **active**, for as long as Gitee kept answering — which is
 * forever. Two things caused it and both are tested here.
 *
 *  - The status comes from the **registry**, and a session leaving it produces no
 *    event — the transcript simply stops. Publishing was driven by appended
 *    events, so this transition reached `head.json` on disk and stopped there.
 *  - `ccr` stopped the bridge it started with a signal, which on Windows is a
 *    `TerminateProcess`: the process died between two writes, leaving the last
 *    `index.json` describing a session that no longer existed. So the shutdown
 *    path has to finish the record itself.
 *
 * The relay is a **local bare repository**, as in `sync.test.ts`, so the whole
 * publish path is exercised without the network. The assertions read the
 * bridge's clone, which is what `publish()` writes before it pushes and is
 * therefore the phone's view one git push short of the wire.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';
import { gitOrThrow } from '../src/git.js';
import { Bridge } from '../src/index.js';

const SESSION_ID = '11111111-2222-3333-4444-555555555555';
const SESSION_PID = 987_654;
const SLUG = 'E--scratch';
const OUT_BRANCH = 'relay-out';

let root: string | null = null;

afterEach(async () => {
  if (root !== null) await rm(root, { recursive: true, force: true });
  root = null;
});

/** A port nothing is listening on, so the hook receiver starts rather than logs. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/** One assistant line, which is the smallest thing the parser calls an event. */
function transcriptLine(text: string): string {
  return `${JSON.stringify({
    timestamp: new Date().toISOString(),
    type: 'assistant',
    message: {
      role: 'assistant',
      model: 'claude-sonnet-5-5',
      content: [{ type: 'text', text }],
    },
  })}\n`;
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

/**
 * Poll until the condition holds, so the test is not a stopwatch.
 *
 * The last value is carried into the failure: a publish that never happened and
 * a publish that carried the wrong status are different bugs, and a bare
 * "timed out" would not say which one this is.
 */
async function waitFor(
  describe: string,
  check: () => Promise<string | null>,
  want: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: string | null = null;
  for (;;) {
    last = await check();
    if (last === want) return;
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${describe}: wanted ${want}, last saw ${last}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('a session that ends', () => {
  it('reaches the relay as ended, with no further event and no second push', async () => {
    root = await mkdtemp(join(tmpdir(), 'ccr-ending-'));

    const projectsDir = join(root, 'projects');
    const sessionsDir = join(root, 'sessions');
    const stateDir = join(root, 'state');
    const outDir = join(stateDir, 'out');
    const remote = join(root, 'remote');
    // What the phone would be reading, once a publish has run.
    const clone = join(stateDir, 'repo-out');

    const registryPath = join(sessionsDir, `${SESSION_PID}.json`);
    const headIn = (...parts: string[]): string => join(outDir, 'sessions', SESSION_ID, ...parts);
    const headOut = (...parts: string[]): string => join(clone, 'out', 'sessions', SESSION_ID, ...parts);

    await gitOrThrow(['init', '--bare', '--initial-branch', OUT_BRANCH, remote], { cwd: root });
    await mkdir(join(projectsDir, SLUG), { recursive: true });
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(join(projectsDir, SLUG, `${SESSION_ID}.jsonl`), transcriptLine('the first reply'));

    // A live session, as the harness records one.
    await writeFile(
      registryPath,
      JSON.stringify({
        pid: SESSION_PID,
        sessionId: SESSION_ID,
        cwd: 'E:\\scratch',
        status: 'busy',
      }),
    );

    const config = loadConfig(
      {
        CCR_PROJECTS_DIR: projectsDir,
        CCR_SESSIONS_DIR: sessionsDir,
        CCR_STATE_DIR: stateDir,
        CCR_OUT_DIR: outDir,
        CCR_REPO_URL: remote,
        CCR_HOOK_PORT: String(await freePort()),
        // Small, so the test is about the trigger and not about the debounce.
        CCR_PUSH_MIN_MS: '100',
        CCR_RESCAN_MS: '50',
        CCR_POLL_FILES_MS: '50',
      },
      root,
    );

    const bridge = new Bridge(config);
    await bridge.start();

    // The registry is the truth about what is running, so a live entry has to
    // reach the relay as `active`. On a bridge that only published on appended
    // events, this file would never appear at all.
    await waitFor(
      'the live session to be published as active',
      async () => (await readJson<{ status: string }>(headOut('head.json')))?.status ?? null,
      'active',
    );

    // The session ends exactly as one does: the harness removes its registry
    // entry. No event is written — a stopped session produces none, so nothing
    // that publishes on an event will ever notice this.
    await rm(registryPath, { force: true });

    // This is the assertion the phone's complaint reduces to: the relay has to
    // correct itself, because nothing else is going to.
    await waitFor(
      'the ended session to be published as ended',
      async () => (await readJson<{ status: string }>(headOut('head.json')))?.status ?? null,
      'ended',
    );

    // The local head is the source of that publish, and the two must not be
    // allowed to disagree.
    expect((await readJson<{ status: string }>(headIn('head.json')))?.status).toBe('ended');

    // And the index — throttled to one write every two seconds while ticking —
    // must not be left behind by the shutdown that follows. This is the write
    // `ccr`'s signal used to interrupt.
    await bridge.stop();

    await waitFor(
      'the shutdown publish to carry the ended session to the index',
      async () => {
        const index = await readJson<{ sessions: { sessionId: string; status: string }[] }>(
          join(clone, 'out', 'index.json'),
        );
        return index?.sessions.find((s) => s.sessionId === SESSION_ID)?.status ?? null;
      },
      'ended',
    );

    // The contract the phone actually depends on, read from what would be the
    // remote: a session that has ended says so in both files it reads.
    expect(
      (
        await readJson<{ sessions: { sessionId: string; status: string; controllable: boolean }[] }>(
          join(clone, 'out', 'index.json'),
        )
      )?.sessions.find((s) => s.sessionId === SESSION_ID)?.controllable,
    ).toBe(false);
  }, 60_000);
});
