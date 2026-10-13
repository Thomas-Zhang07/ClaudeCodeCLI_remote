import { mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { IPty } from 'node-pty';

import {
  controlPipePath,
  isProcessAlive,
  readControlled,
  registerControlled,
  sendControlMessage,
  startControlServer,
  unregisterControlled,
} from '../src/control.js';
import { handleControlMessage, parseCcrArgs } from '../src/cli.js';
import { loadConfig, type BridgeConfig } from '../src/config.js';
import { PtySession } from '../src/pty.js';

let stateDir: string;

/** A pty stand-in that records writes and reports a fixed pid. */
function fakePty(pid = 4242): { impl: IPty; writes: string[] } {
  const writes: string[] = [];
  const impl = {
    pid,
    write: (data: string) => {
      writes.push(data);
    },
    resize: () => {},
    kill: () => {},
    onData: () => ({ dispose: () => {} }),
    onExit: () => ({ dispose: () => {} }),
  };
  return { impl: impl as unknown as IPty, writes };
}

function sessionWith(pid = 4242): { session: PtySession; writes: string[] } {
  const { impl, writes } = fakePty(pid);
  const session = new PtySession({
    command: 'claude',
    args: [],
    cwd: process.cwd(),
    spawn: () => impl,
  });
  session.start();
  return { session, writes };
}

function testConfig(over: Partial<BridgeConfig> = {}): BridgeConfig {
  return { ...loadConfig({}), stateDir, allowInjection: false, ...over };
}

/** A pipe name unique to this run, so parallel test files cannot collide. */
function uniquePipe(): string {
  return controlPipePath(900_000 + Math.floor(Math.random() * 90_000));
}

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'ccr-control-'));
});

describe('registration', () => {
  const info = {
    pid: process.pid,
    sessionId: null,
    pipe: 'pipe-name',
    cwd: 'E:\\project',
    startedAt: '2026-10-13T10:00:00.000Z',
  };

  it('round-trips a controlled session', async () => {
    await registerControlled(stateDir, info);
    const found = await readControlled(stateDir);

    expect(found).toHaveLength(1);
    expect(found[0]!.pid).toBe(process.pid);
    expect(found[0]!.cwd).toBe('E:\\project');
  });

  it('forgets a session once it unregisters', async () => {
    await registerControlled(stateDir, info);
    await unregisterControlled(stateDir, process.pid);
    expect(await readControlled(stateDir)).toEqual([]);
  });

  it('ignores and clears a registration for a dead process', async () => {
    // A crash or a kill leaves the file behind. Reporting it would mark a
    // session controllable that nothing is listening for.
    await registerControlled(stateDir, { ...info, pid: 999_999_999 });

    expect(await readControlled(stateDir)).toEqual([]);
    expect(existsSync(join(stateDir, 'ccr', '999999999.json'))).toBe(false);
  });

  it('returns an empty list when nothing has ever registered', async () => {
    expect(await readControlled(stateDir)).toEqual([]);
  });

  it('survives a malformed registration file', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(join(stateDir, 'ccr'), { recursive: true });
    await writeFile(join(stateDir, 'ccr', 'broken.json'), '{not json');

    expect(await readControlled(stateDir)).toEqual([]);
  });

  it('reports the current process as alive', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });
});

describe('control channel', () => {
  it('delivers a message and returns the reply', async () => {
    const pipe = uniquePipe();
    const server = await startControlServer(pipe, (message) =>
      message.type === 'ping' ? { type: 'pong' } : { type: 'rejected', reason: 'nope' },
    );

    try {
      expect(await sendControlMessage(pipe, { type: 'ping' })).toEqual({ type: 'pong' });
      expect(await sendControlMessage(pipe, { type: 'prompt', text: 'x' })).toEqual({
        type: 'rejected',
        reason: 'nope',
      });
    } finally {
      await server.close();
    }
  });

  it('answers a malformed line rather than dropping it', async () => {
    const pipe = uniquePipe();
    const server = await startControlServer(pipe, () => ({ type: 'pong' }));

    try {
      const { connect } = await import('node:net');
      const reply = await new Promise<string>((resolve) => {
        const socket = connect(pipe);
        let buffer = '';
        socket.setEncoding('utf8');
        socket.on('connect', () => socket.write('this is not json\n'));
        socket.on('data', (chunk: string) => {
          buffer += chunk;
          if (buffer.includes('\n')) {
            socket.destroy();
            resolve(buffer);
          }
        });
      });

      expect(JSON.parse(reply.trim())).toEqual({ type: 'rejected', reason: 'malformed' });
    } finally {
      await server.close();
    }
  });

  it('returns null instead of throwing when nothing is listening', async () => {
    expect(await sendControlMessage(controlPipePath(999_999_998), { type: 'ping' }, 500)).toBeNull();
  });
});

describe('handleControlMessage', () => {
  it('answers a ping without touching the session', async () => {
    const { session, writes } = sessionWith();
    const reply = await handleControlMessage({ type: 'ping' }, session, testConfig());
    expect(reply).toEqual({ type: 'pong' });
    expect(writes).toEqual([]);
  });

  it('refuses to inject unless injection is enabled', async () => {
    const { session, writes } = sessionWith();
    const reply = await handleControlMessage(
      { type: 'prompt', promptId: 'p1', text: 'run the tests' },
      session,
      testConfig({ allowInjection: false }),
    );

    expect(reply).toEqual({ type: 'rejected', promptId: 'p1', reason: 'injection-disabled' });
    expect(writes).toEqual([]);
  });

  it('injects when enabled, and says only that it reached the terminal', async () => {
    const { session, writes } = sessionWith();
    const reply = await handleControlMessage(
      { type: 'prompt', promptId: 'p1', text: 'run the tests' },
      session,
      testConfig({ allowInjection: true }),
    );

    // 'accepted', not 'delivered': only the transcript can confirm execution.
    expect(reply).toEqual({ type: 'accepted', promptId: 'p1' });
    expect(writes.join('')).toContain('run the tests');
    expect(writes.at(-1)).toBe('\r');
  });

  it('refuses an empty prompt', async () => {
    const { session } = sessionWith();
    const reply = await handleControlMessage(
      { type: 'prompt', promptId: 'p1', text: '   \n ' },
      session,
      testConfig({ allowInjection: true }),
    );
    expect(reply).toEqual({ type: 'rejected', promptId: 'p1', reason: 'empty' });
  });

  it('refuses to write to a session that has ended', async () => {
    const { session } = sessionWith();
    const cfg = testConfig({ allowInjection: true });

    // No real exit event is needed: the promise never settles for a fake pty, so
    // reach into the same check by killing the child first.
    const ended = Object.create(session) as PtySession;
    Object.defineProperty(ended, 'exited', { get: () => true });

    const reply = await handleControlMessage(
      { type: 'prompt', promptId: 'p1', text: 'hello' },
      ended,
      cfg,
    );
    expect(reply).toEqual({ type: 'rejected', promptId: 'p1', reason: 'session-ended' });
  });

  it('rejects an unknown message type', async () => {
    const { session } = sessionWith();
    const reply = await handleControlMessage(
      { type: 'nonsense' } as unknown as { type: 'ping' },
      session,
      testConfig(),
    );
    expect(reply).toEqual({ type: 'rejected', reason: 'unknown-message' });
  });
});

describe('resolveExecutable', () => {
  it('resolves a bare command name to a real path', async () => {
    // ConPTY resolves relative names through its own PATH lookup, which fails
    // where the shell succeeds — so this has to happen before spawning.
    const { resolveExecutable } = await import('../src/pty.js');
    const node = resolveExecutable('node');
    expect(node).not.toBe('node');
    expect(existsSync(node)).toBe(true);
  });

  it('leaves an absolute path alone', async () => {
    const { resolveExecutable } = await import('../src/pty.js');
    const absolute = process.execPath;
    expect(resolveExecutable(absolute)).toBe(absolute);
  });

  it('returns the original name when nothing matches, so the error names it', async () => {
    const { resolveExecutable } = await import('../src/pty.js');
    expect(resolveExecutable('definitely-not-a-real-command-xyz')).toBe(
      'definitely-not-a-real-command-xyz',
    );
  });
});

describe('parseCcrArgs', () => {
  it('passes every argument through to Claude Code', () => {
    // Flags this file has never heard of must survive; parsing them here would
    // silently drop whatever a future release adds.
    const opts = parseCcrArgs(['--resume', 'abc', '--model', 'opus', '--some-future-flag'], {});
    expect(opts.args).toEqual(['--resume', 'abc', '--model', 'opus', '--some-future-flag']);
  });

  it('defaults to the claude binary, and honours an override', () => {
    expect(parseCcrArgs([], {}).command).toBe('claude');
    expect(parseCcrArgs([], { CCR_CLAUDE_BIN: 'C:\\bin\\claude.exe' }).command).toBe(
      'C:\\bin\\claude.exe',
    );
  });
});
