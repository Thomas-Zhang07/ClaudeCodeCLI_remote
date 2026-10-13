/**
 * The seam between the bridge and a `ccr` session.
 *
 * They are separate processes: the bridge reads transcripts and talks to the
 * relay, while `ccr` owns the pty. Only the process holding the pty can type
 * into a session, so the bridge has to reach across.
 *
 * Two mechanisms, deliberately split:
 *
 *  - **Registration** — a small file per session, discovered by the bridge. This
 *    is how a session becomes known as *controllable*, and it costs nothing when
 *    nothing is running. Claude Code keeps its own registry in exactly this
 *    shape (`~/.claude/sessions/<pid>.json`, including a `messagingSocketPath`),
 *    which is a good sign the approach fits the problem.
 *  - **A named pipe** — the live channel, used only when a prompt actually has
 *    to be delivered.
 *
 * Files rather than a single shared service, because a bridge that is not
 * running must not prevent `ccr` from starting, and a `ccr` that crashes must
 * not leave the bridge waiting on it.
 */

import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';

export interface ControlledSession {
  pid: number;
  /** Filled in once the session's transcript is identified. */
  sessionId: string | null;
  /** Named pipe `ccr` is listening on. */
  pipe: string;
  cwd: string;
  startedAt: string;
}

export interface ControlMessage {
  type: 'prompt' | 'ping';
  promptId?: string;
  text?: string;
}

export interface ControlReply {
  type: 'accepted' | 'rejected' | 'pong';
  promptId?: string;
  reason?: string;
}

const CCR_DIR = 'ccr';

export function ccrDir(stateDir: string): string {
  return join(stateDir, CCR_DIR);
}

/**
 * The pipe a `ccr` process listens on.
 *
 * A named pipe on Windows, a unix socket elsewhere. Namespaced by pid so two
 * sessions cannot collide.
 */
export function controlPipePath(pid: number): string {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\ccr-${pid}`
    : join(process.env['TMPDIR'] ?? '/tmp', `ccr-${pid}.sock`);
}

export async function registerControlled(
  stateDir: string,
  info: ControlledSession,
): Promise<void> {
  await mkdir(ccrDir(stateDir), { recursive: true });
  await writeFile(join(ccrDir(stateDir), `${info.pid}.json`), `${JSON.stringify(info, null, 2)}\n`);
}

export async function unregisterControlled(stateDir: string, pid: number): Promise<void> {
  await rm(join(ccrDir(stateDir), `${pid}.json`), { force: true });
}

/**
 * Read the registration files.
 *
 * A file for a process that no longer exists is stale — `ccr` removes its own on
 * exit, but a crash or a kill leaves one behind, so existence is checked rather
 * than trusted.
 */
export async function readControlled(stateDir: string): Promise<ControlledSession[]> {
  let names: string[];
  try {
    names = await readdir(ccrDir(stateDir));
  } catch {
    return [];
  }

  const out: ControlledSession[] = [];

  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const path = join(ccrDir(stateDir), name);

    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as ControlledSession;
      if (typeof parsed?.pid !== 'number') continue;

      if (!isProcessAlive(parsed.pid)) {
        // Left behind by a crash; clean it up rather than reporting a phantom.
        await rm(path, { force: true }).catch(() => {});
        continue;
      }
      out.push(parsed);
    } catch {
      // Mid-write or malformed; it will be readable next poll.
    }
  }

  return out;
}

/**
 * Whether a process is still running.
 *
 * Signal 0 performs the permission check without delivering anything. On Windows
 * this throws for a pid that exists but is not ours, so an error is treated as
 * "alive" — the conservative answer, since declaring a live session dead would
 * silently drop its controllability.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'EPERM';
  }
}

export interface ControlServer {
  close(): Promise<void>;
  readonly pipe: string;
}

/**
 * Listen for messages from the bridge.
 *
 * Line-delimited JSON, because a pipe is a byte stream and framing has to be
 * explicit. Each connection is short-lived: the bridge connects, sends one
 * message, reads one reply, disconnects.
 */
export async function startControlServer(
  pipe: string,
  onMessage: (message: ControlMessage) => ControlReply | Promise<ControlReply>,
): Promise<ControlServer> {
  const server: Server = createServer({ allowHalfOpen: false }, (socket) => {
    let buffer = '';

    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;

      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');

        if (!line) continue;
        void handleLine(line, socket, onMessage);
      }
    });

    socket.on('error', () => {
      // The bridge hung up; nothing to do.
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(pipe, () => {
      server.off('error', reject);
      resolve();
    });
  });

  return {
    pipe,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        // close() waits for existing connections; nothing here holds one open,
        // but a stray socket must not hang shutdown.
        setTimeout(resolve, 250).unref?.();
      }),
  };
}

async function handleLine(
  line: string,
  socket: NodeJS.ReadWriteStream,
  onMessage: (message: ControlMessage) => ControlReply | Promise<ControlReply>,
): Promise<void> {
  let reply: ControlReply;
  try {
    const message = JSON.parse(line) as ControlMessage;
    reply = await onMessage(message);
  } catch {
    reply = { type: 'rejected', reason: 'malformed' };
  }
  try {
    socket.write(`${JSON.stringify(reply)}\n`);
  } catch {
    // The peer is gone.
  }
}

/**
 * Send one message to a `ccr` session and read its reply.
 *
 * Returns null when the session cannot be reached — a dead pipe means the
 * session is gone, not that something is broken.
 */
export async function sendControlMessage(
  pipe: string,
  message: ControlMessage,
  timeoutMs = 5_000,
): Promise<ControlReply | null> {
  const { connect } = await import('node:net');

  return new Promise((resolve) => {
    let settled = false;
    const done = (value: ControlReply | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };

    const socket = connect(pipe);
    const timer = setTimeout(() => done(null), timeoutMs);

    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify(message)}\n`));
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      try {
        done(JSON.parse(buffer.slice(0, newline)) as ControlReply);
      } catch {
        done(null);
      }
    });
    socket.on('error', () => done(null));
    socket.on('close', () => done(null));
  });
}
