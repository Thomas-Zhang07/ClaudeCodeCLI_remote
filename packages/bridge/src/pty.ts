/**
 * Running Claude Code inside a pseudo-terminal.
 *
 * A normal `claude` session reads its input from its own stdin, and nothing
 * outside that process can type into it — the transcript is a record of what
 * happened, not a channel into it. Spawning it under a pty that *we* own is what
 * makes a session controllable: we hold the master side, so writing to it is
 * indistinguishable from the user typing.
 *
 * The pty also has to be invisible. The whole point is that `ccr` looks and
 * behaves like `claude`, so bytes are passed through untouched in both
 * directions and the terminal's size is forwarded rather than guessed at.
 */

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';

import type { IPty } from 'node-pty';

/**
 * This package is ESM, so a bare `require` does not exist. `createRequire`
 * restores one for the single place where a synchronous load is wanted: the
 * native pty module, which must not be pulled in by merely importing this file.
 */
const requireNative = createRequire(import.meta.url);

/** Bytes are forwarded as-is; nothing here interprets them. */
export type PtyDataHandler = (data: string) => void;

export interface PtyExit {
  exitCode: number;
  signal?: number;
}

export interface PtySessionOptions {
  command: string;
  args: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  cols?: number;
  rows?: number;
  /**
   * Injected lazily so tests can supply a fake terminal without importing
   * node-pty, which loads a native binary.
   */
  spawn?: (file: string, args: string[], options: Record<string, unknown>) => IPty;
}

/**
 * A Claude Code session running under our pty.
 *
 * Deliberately thin: it owns the child and the byte pipe, and nothing about
 * policy. Whether a prompt is allowed to be injected is decided elsewhere.
 */
export class PtySession {
  readonly #options: PtySessionOptions;
  #term: IPty | null = null;
  #dataHandlers = new Set<PtyDataHandler>();
  #exitHandlers = new Set<(e: PtyExit) => void>();
  #exited = false;
  #exitCode: number | null = null;

  constructor(options: PtySessionOptions) {
    this.#options = options;
  }

  get pid(): number | null {
    return this.#term?.pid ?? null;
  }

  get exited(): boolean {
    return this.#exited;
  }

  /** Exit code once the child has finished, otherwise null. */
  get exitCode(): number | null {
    return this.#exitCode;
  }

  onData(handler: PtyDataHandler): () => void {
    this.#dataHandlers.add(handler);
    return () => this.#dataHandlers.delete(handler);
  }

  onExit(handler: (e: PtyExit) => void): () => void {
    this.#exitHandlers.add(handler);
    return () => this.#exitHandlers.delete(handler);
  }

  start(): void {
    if (this.#term) throw new Error('PtySession.start() called twice');

    const spawnImpl = this.#options.spawn ?? defaultSpawn();

    this.#term = spawnImpl(this.#options.command, [...this.#options.args], {
      name: 'xterm-256color',
      cols: this.#options.cols ?? 120,
      rows: this.#options.rows ?? 30,
      cwd: this.#options.cwd,
      // A pty needs a real environment; Claude Code reads configuration from it.
      env: { ...(this.#options.env ?? process.env) },
      // ConPTY is the Windows implementation and is required for the TUI to
      // render at all.
      useConpty: true,
    });

    this.#term.onData((data) => {
      for (const handler of this.#dataHandlers) handler(data);
    });

    this.#term.onExit(({ exitCode, signal }) => {
      this.#exited = true;
      this.#exitCode = exitCode;
      for (const handler of this.#exitHandlers) {
        handler(signal === undefined ? { exitCode } : { exitCode, signal });
      }
    });
  }

  /** Forward input — keystrokes from the user, or an injected prompt. */
  write(data: string): void {
    if (!this.#term || this.#exited) return;
    this.#term.write(data);
  }

  /** Forward a terminal resize. */
  resize(cols: number, rows: number): void {
    if (!this.#term || this.#exited) return;
    if (cols <= 0 || rows <= 0) return;
    try {
      this.#term.resize(cols, rows);
    } catch {
      // ConPTY can reject a resize during teardown; losing one is harmless.
    }
  }

  kill(signal?: string): void {
    if (!this.#term || this.#exited) return;
    try {
      this.#term.kill(signal);
    } catch {
      // Already gone.
    }
  }
}

/**
 * Turn a command name into a path node-pty can actually start.
 *
 * ConPTY resolves a relative filename through its own PATH lookup, which
 * frequently fails where the shell succeeds — `node` and `claude` both hit this.
 * Resolving here keeps the failure at a layer we control, and makes the error
 * message name the command rather than reporting an empty path.
 *
 * Claude Code installs itself to `~/.local/bin`, which is often absent from the
 * PATH a spawned process inherits, so that directory is searched too.
 */
export function resolveExecutable(command: string, env: NodeJS.ProcessEnv = process.env): string {
  if (isAbsolute(command)) return command;

  // Windows spells this variable both ways depending on the parent process.
  const pathValue = env['PATH'] ?? env['Path'] ?? '';
  const searchDirs = [
    ...pathValue.split(delimiter).filter(Boolean),
    join(homedir(), '.local', 'bin'),
  ];

  const suffixes = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];

  for (const dir of searchDirs) {
    for (const suffix of suffixes) {
      const candidate = join(dir, command + suffix);
      if (existsSync(candidate)) return candidate;
    }
  }

  // Nothing found: hand back the original so the error names what was asked for.
  return command;
}

/**
 * Load node-pty on demand.
 *
 * It is a native module; importing it at module load would make everything that
 * merely imports this file — including tests — depend on the binary being
 * present and loadable.
 */
function defaultSpawn(): (file: string, args: string[], options: Record<string, unknown>) => IPty {
  return (file, args, options) => {
    const pty = requireNative('node-pty') as typeof import('node-pty');
    return pty.spawn(file, args, options as Parameters<typeof pty.spawn>[2]);
  };
}

// ---------------------------------------------------------------------------
// Terminal passthrough
// ---------------------------------------------------------------------------

export interface TerminalLike {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
}

/**
 * Wire a pty to the real terminal, in both directions.
 *
 * Returns a teardown that restores the terminal. Raw mode matters in both
 * directions: without it the terminal would line-buffer our keystrokes and
 * translate Ctrl-C into a signal instead of letting the TUI see it.
 */
export function attachTerminal(
  session: PtySession,
  terminal: TerminalLike = { stdin: process.stdin, stdout: process.stdout },
): () => void {
  const { stdin, stdout } = terminal;
  const wasRaw = stdin.isRaw ?? false;

  const onInput = (chunk: Buffer | string): void => {
    session.write(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
  };

  const offData = session.onData((data) => {
    stdout.write(data);
  });

  const onResize = (): void => {
    session.resize(stdout.columns ?? 120, stdout.rows ?? 30);
  };

  if (stdin.isTTY) stdin.setRawMode?.(true);
  stdin.resume();
  stdin.on('data', onInput);

  // Node emits 'resize' on stdout; there is no SIGWINCH on Windows.
  stdout.on?.('resize', onResize);
  onResize();

  return () => {
    offData();
    stdin.off('data', onInput);
    stdout.off?.('resize', onResize);
    if (stdin.isTTY) stdin.setRawMode?.(wasRaw);
    stdin.pause();
  };
}
