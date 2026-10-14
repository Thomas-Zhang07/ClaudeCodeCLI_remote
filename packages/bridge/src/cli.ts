#!/usr/bin/env node
/**
 * `ccr` — launch Claude Code in a session that can be driven from the phone.
 *
 * The contract with the user is that this is indistinguishable from running
 * `claude`: same TUI, same keys, same exit code. Everything it adds is
 * invisible unless a prompt arrives from the relay.
 *
 * It does three things a plain session does not:
 *   1. runs Claude Code under a pty it owns, so input can be written by someone
 *      other than the person at the keyboard
 *   2. registers itself, which is how the bridge learns a session is
 *      controllable rather than merely observable
 *   3. listens on a named pipe for prompts the bridge wants delivered
 *
 * And, since a controllable session with no bridge behind it is watched by
 * nobody and reachable from nowhere — while looking exactly like a working one
 * — it starts a bridge if there is not one, and stops the one it started when
 * the session ends. See `ensureBridge`.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  controlPipePath,
  readControlled,
  registerControlled,
  startControlServer,
  unregisterControlled,
  type ControlMessage,
  type ControlReply,
} from './control.js';
import { bootstrapConfig, type BridgeConfig } from './config.js';
import { injectPrompt } from './inject.js';
import { lockIsLive, lockPath, readLock } from './lock.js';
import { attachTerminal, PtySession, resolveExecutable } from './pty.js';
import { clearStopRequest, writeStopRequest } from './stop-request.js';

/**
 * How long to let a bridge finish before killing it.
 *
 * It has to notice the request (within a tick), read the registry, seal its
 * chunks and push — a push being the slow part, and the one that has to complete,
 * because it is what tells the phone the session ended. Generous because the
 * alternative is a relay left claiming a finished session is live; bounded
 * because this is time the terminal sits at a shell after Claude Code has gone.
 */
const STOP_GRACE_MS = 15_000;

export interface CcrOptions {
  /** Arguments passed straight through to Claude Code. */
  args: string[];
  cwd: string;
  /** The Claude Code executable. */
  command: string;
}

export function parseCcrArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): CcrOptions {
  // Everything after `ccr` belongs to Claude Code, including flags this file has
  // never heard of. Parsing them here would mean silently dropping the ones
  // added by a future release.
  return {
    args: [...argv],
    cwd: process.cwd(),
    command: env['CCR_CLAUDE_BIN'] ?? 'claude',
  };
}

export interface CcrRuntime {
  session: PtySession;
  stateDir: string;
  config: BridgeConfig;
}

/**
 * Where a bridge started by `ccr` writes its output.
 *
 * A bridge started from a shell inherits that terminal and needs no file. One
 * started by `ccr` has nowhere to go: the terminal is about to be taken over by
 * Claude Code's interface, and a line printed into it mid-render corrupts the
 * display. So it goes to a file under the state directory, which is already
 * gitignored and is where the rest of the runtime state lives.
 */
export function bridgeLogPath(stateDir: string): string {
  return join(stateDir, 'logs', 'bridge.log');
}

/** The bridge entry point, which sits beside this file once built. */
function bridgeEntry(): string {
  return fileURLToPath(new URL('./index.js', import.meta.url));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait for the bridge to take the lock.
 *
 * It acquires the lock in the first moments of `start()`, before it scans
 * anything, so this normally returns in well under the timeout. Running the
 * whole timeout out means it never got that far — worth one line, because it is
 * said while there is still a screen to say it on, and the alternative is a
 * session that looks healthy and is watched by nobody.
 */
async function waitForLock(
  stateDir: string,
  pid: number | undefined,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const lock = await readLock(stateDir);
    if (lock !== null && (pid === undefined || lock.pid === pid)) return true;
    if (Date.now() >= deadline) return false;
    await delay(100);
  }
}

/** Wait for a child to exit, reporting whether it did so within the timeout. */
function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);

  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/**
 * Start a bridge, unless one is already running.
 *
 * Requiring a bridge to be started separately meant two things to remember and
 * an easy way to end up with a controllable session that is neither watched nor
 * reachable from the phone — indistinguishable, from the terminal, from one that
 * is working.
 *
 * @returns the process this call started, or null when a bridge was already
 *   running. **Only ever the process this call started is stopped again**: one
 *   that was already up belongs to whoever started it, very possibly the user
 *   from a shell they are still watching.
 */
export async function ensureBridge(
  config: BridgeConfig,
  log: (message: string) => void,
): Promise<ChildProcess | null> {
  const lock = await readLock(config.stateDir);

  // The same rule the bridge applies to itself — see `lock.ts` for why the two
  // must agree rather than each deciding separately.
  if (lockIsLive(lock, config.lockStaleMs)) {
    log(`bridge already running (pid ${lock?.pid ?? 'unknown'})`);
    return null;
  }

  if (lock !== null) log('the bridge lock on record is stale; starting a bridge');

  const logFile = bridgeLogPath(config.stateDir);
  await mkdir(dirname(logFile), { recursive: true });

  // Opened rather than inherited, so nothing the bridge prints can land in the
  // middle of Claude Code's display.
  const fd = openSync(logFile, 'a');
  let child: ChildProcess;
  try {
    child = spawn(process.execPath, [bridgeEntry()], {
      stdio: ['ignore', fd, fd],
      windowsHide: true,
    });
  } finally {
    // The child holds its own descriptor; closing ours cannot cut the log short.
    closeSync(fd);
  }

  const pid = child.pid;
  child.on('error', (error) => log(`could not start the bridge: ${String(error)}`));

  if (await waitForLock(config.stateDir, pid, 1_500)) {
    log(`bridge started (pid ${pid ?? 'unknown'}), logging to ${logFile}`);
  } else {
    log(`the bridge did not come up; see ${logFile}`);
  }

  return child;
}

/**
 * Stop the bridge this session started, unless another session still needs it.
 *
 * The other-session check exists because two `ccr` sessions share one bridge: the
 * second finds the first's lock and starts nothing of its own, so without this
 * check the first to exit would take the bridge down underneath the session that
 * is still running. It also closes a race that asking the bridge to stop on its
 * own could not: the check happens before the request is written, so a second
 * `ccr` that has started but not yet registered still counts as `others`.
 *
 * The stop is a **request**, not a signal — see `stop-request.ts` for why. The
 * bridge answers it by reading the registry one last time, sealing its chunks,
 * writing a final head and index, and publishing, which is the only way the
 * phone ever learns the session ended.
 */
async function stopOwnedBridge(
  child: ChildProcess | null,
  config: BridgeConfig,
  log: (message: string) => void,
): Promise<void> {
  const pid = child?.pid;
  if (child === null || pid === undefined) return;

  const others = (await readControlled(config.stateDir)).filter(
    (session) => session.pid !== process.pid,
  );
  if (others.length > 0) {
    log(`leaving the bridge running: ${others.length} other ccr session(s) still open`);
    return;
  }

  // A leftover request names an older bridge and is ignored by the one running
  // now, but overwriting is not the same as relying on that: the file should
  // describe this stop and nothing else.
  await clearStopRequest(config.stateDir);
  await writeStopRequest(config.stateDir, pid).catch(() => {});

  const stopped = await waitForExit(child, STOP_GRACE_MS);
  if (!stopped) {
    log(`the bridge (pid ${pid}) has not stopped after ${Math.round(STOP_GRACE_MS / 1000)}s`);
    child.kill();
  }

  await clearStopRequest(config.stateDir);

  // A forced kill cannot run the bridge's shutdown, so its lock is left behind —
  // and the next `ccr` would read that as a live bridge within `lockStaleMs` and
  // decline to start one, leaving a session nobody is watching, which is the
  // whole thing this is here to prevent. So the lock goes when the process does.
  //
  // Nothing is lost by the abrupt exit: an unsealed chunk is recovered from the
  // file on the next open, which is the same path a crash takes.
  if (!stopped && !(await waitForExit(child, 3_000))) {
    log(`the bridge (pid ${pid}) has not exited; it will be taken over once its lock goes stale`);
  }

  const lock = await readLock(config.stateDir);
  if (lock?.pid === pid) await rm(lockPath(config.stateDir), { force: true }).catch(() => {});
}

/**
 * Run a controllable session to completion.
 *
 * Returns the child's exit code so the shell sees what Claude Code exited with,
 * not what the wrapper did.
 */
export async function runCcr(
  options: CcrOptions,
  config: BridgeConfig,
  terminal = { stdin: process.stdin, stdout: process.stdout },
): Promise<number> {
  await mkdir(config.stateDir, { recursive: true });

  /**
   * Nothing may be written once Claude Code owns the terminal: a stray line
   * mid-render corrupts the display. Everything that needs saying is said
   * before the pty is attached, and again after it is detached.
   */
  let quiet = false;
  const log = (message: string): void => {
    if (quiet) return;
    process.stderr.write(`[ccr] ${message}\n`);
  };

  const bridge = await ensureBridge(config, log);

  try {
    const session = new PtySession({
      // Resolved before spawning: ConPTY cannot find a bare command name.
      command: resolveExecutable(options.command),
      args: options.args,
      cwd: options.cwd,
      cols: terminal.stdout.columns ?? 120,
      rows: terminal.stdout.rows ?? 30,
    });

    session.start();
    const pid = session.pid;
    if (pid === null) throw new Error('the pty did not start');

    const pipe = controlPipePath(pid);
    const server = await startControlServer(pipe, (message) =>
      handleControlMessage(message, session, config),
    );

    await registerControlled(config.stateDir, {
      pid,
      // Not known here: the session id is assigned by Claude Code and appears in
      // its own registry, which the bridge matches on pid.
      sessionId: null,
      pipe,
      cwd: options.cwd,
      startedAt: new Date().toISOString(),
    });

    const detach = attachTerminal(session, terminal);
    quiet = true;

    const exit = await new Promise<number>((resolve) => {
      session.onExit(({ exitCode }) => resolve(exitCode));

      const stop = (): void => {
        session.kill();
      };
      process.once('SIGTERM', stop);
      process.once('SIGHUP', stop);
    });

    // Tidy up in an order that cannot leave the bridge talking to a dead pipe, or
    // a stale registration pointing at a process that no longer exists.
    detach();
    quiet = false;
    await server.close().catch(() => {});
    await unregisterControlled(config.stateDir, pid).catch(() => {});

    return exit;
  } finally {
    // Whether the session ended cleanly, threw, or never started at all: the
    // bridge this call started must not outlive it.
    quiet = false;
    await stopOwnedBridge(bridge, config, log);
  }
}

/**
 * Decide what to do with a message from the bridge.
 *
 * Injection is off unless explicitly enabled. `accepted` means the text reached
 * the terminal — not that Claude Code acted on it, which only the transcript can
 * confirm.
 */
export async function handleControlMessage(
  message: ControlMessage,
  session: PtySession,
  config: BridgeConfig,
): Promise<ControlReply> {
  if (message.type === 'ping') return { type: 'pong' };
  if (message.type !== 'prompt') return { type: 'rejected', reason: 'unknown-message' };

  const promptId = message.promptId;
  const text = message.text;

  if (typeof text !== 'string' || text.trim().length === 0) {
    return { type: 'rejected', ...(promptId ? { promptId } : {}), reason: 'empty' };
  }
  if (!config.allowInjection) {
    return {
      type: 'rejected',
      ...(promptId ? { promptId } : {}),
      // Surfaced to the phone, so a disabled setting reads as a policy rather
      // than as a mysterious failure.
      reason: 'injection-disabled',
    };
  }
  if (session.exited) {
    return { type: 'rejected', ...(promptId ? { promptId } : {}), reason: 'session-ended' };
  }

  try {
    await injectPrompt(session, text);
    return { type: 'accepted', ...(promptId ? { promptId } : {}) };
  } catch (error) {
    return {
      type: 'rejected',
      ...(promptId ? { promptId } : {}),
      reason: `inject-failed: ${String(error)}`,
    };
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  // Same resolution as the bridge: `ccr` registers itself in the state
  // directory, and the bridge has to look in the same one.
  const config = bootstrapConfig();
  const options = parseCcrArgs(argv);

  try {
    const code = await runCcr(options, config);
    process.exit(code);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // The overwhelmingly common cause is a missing native module, which has a
    // specific fix worth naming rather than leaving as a stack trace.
    if (/node-pty|Cannot find module/.test(message)) {
      process.stderr.write(
        `ccr: could not load node-pty (${message})\n` +
          '  node-pty ships prebuilt binaries; if none match this Node version and\n' +
          '  no C++ toolchain is installed, install @lydell/node-pty instead.\n',
      );
    } else {
      process.stderr.write(`ccr: ${message}\n`);
    }
    process.exit(1);
  }
}

const invokedDirectly = process.argv[1]?.replace(/\\/g, '/').endsWith('/dist/cli.js');
if (invokedDirectly) {
  void main();
}
