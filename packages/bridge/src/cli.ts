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
 */

import { mkdir } from 'node:fs/promises';

import {
  controlPipePath,
  registerControlled,
  startControlServer,
  unregisterControlled,
  type ControlMessage,
  type ControlReply,
} from './control.js';
import { loadConfig, loadEnvFile, type BridgeConfig } from './config.js';
import { injectPrompt } from './inject.js';
import { attachTerminal, PtySession, resolveExecutable } from './pty.js';

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
  await server.close().catch(() => {});
  await unregisterControlled(config.stateDir, pid).catch(() => {});

  return exit;
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
  loadEnvFile();
  const config = loadConfig();
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
