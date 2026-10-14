/**
 * Bridge configuration.
 *
 * Read once at startup and passed down explicitly rather than reached for
 * globally, so tests can construct a config without touching the environment.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Port the hook receiver listens on until told otherwise.
 *
 * Kept below 32768 so it sits under the ephemeral range on both Windows (49152)
 * and Linux (32768), where a transient outbound connection could otherwise be
 * holding it. `scripts/install-hooks.mjs` writes the same value into `.env`, and
 * a test asserts the two have not drifted apart.
 */
export const DEFAULT_HOOK_PORT = 27182;

export interface BridgeConfig {
  /** Root of the Claude Code transcript store. */
  projectsDir: string;
  /** Live session registry, authoritative for liveness and attention state. */
  sessionsDir: string;
  /** Where tail offsets and session state are persisted. */
  stateDir: string;
  /** Where normalized chunks are written. Local until the sync layer exists. */
  outDir: string;

  repoUrl: string | null;
  repoToken: string | null;
  /**
   * Branch the bridge publishes to.
   *
   * Separate from the inbound branch because publishing amends a single commit
   * and force-pushes — which would destroy an un-fetched prompt if the two
   * shared a branch. Outbound history is disposable; inbound history is not.
   */
  outBranch: string;
  /** Append-only branch the phone writes prompts to. Never rewritten. */
  inBranch: string;
  secret: string | null;

  /**
   * Minimum gap between publishes.
   *
   * Not a polling interval: publishing is driven by turn boundaries and
   * attention signals, and this only coalesces the bursts those produce. Push
   * frequency is the binding constraint on repository growth — see
   * docs/RELAY-DESIGN.md — so this is a floor, never a schedule.
   */
  pushMinIntervalMs: number;
  /** How often the bridge checks for prompts written by the phone. */
  pollIntervalMs: number;

  /** Bytes retained per session. Oldest chunks are deleted past this. */
  retainBytes: number;
  /** Sessions kept in the relay index. */
  maxSessions: number;
  /** Chunks retained per session, bounding file count rather than bytes. */
  maxChunksPerSession: number;
  /**
   * How long without a heartbeat before another bridge may take the lock.
   *
   * Detects a live writer regardless of which process started it, which a pid
   * cannot: an orphaned bridge survives its parent and keeps writing.
   */
  lockStaleMs: number;

  /**
   * Port the hook receiver listens on, loopback only.
   *
   * Below both the Windows and the Linux ephemeral ranges (49152 / 32768), so a
   * transient outbound connection cannot already be holding it.
   */
  hookPort: number;
  /**
   * Shared secret every hook request must carry.
   *
   * Written by `scripts/install-hooks.mjs`. Null means the receiver accepts
   * unauthenticated requests from anything on this machine, and says so once at
   * startup — the endpoint only records state, but a forged `Stop` would clear
   * the dialog flag, so a local process could unlock injection.
   */
  hookToken: string | null;
  /**
   * How far the transcript may run ahead of the hook stream before hooks are
   * treated as having gone quiet. See `hooksCurrent`.
   */
  hookQuietMs: number;

  allowInjection: boolean;
  /** Prompts older than this are refused, bounding the value of a captured file. */
  promptMaxAgeMs: number;

  /** Bytes of tail window to replay when a session is seen for the first time. */
  coldStartBytes: number;
  /** How often known files are stat-polled for growth. */
  pollFilesMs: number;
  /** How often the transcript directory tree is rescanned for new sessions. */
  rescanMs: number;
}

/**
 * Where this installation lives.
 *
 * `dist/config.js` → the package root's parent, which is the checkout.
 */
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * Load `.env` and build the configuration from it.
 *
 * The single entry point both `ccr` and the bridge use, so they cannot disagree
 * about which state directory they are using — which would let `ccr` register
 * itself somewhere the bridge never looks.
 *
 * **Anchored to the installation, never the working directory.** `ccr` is a
 * global command and the bridge may be started from anywhere, so anything
 * derived from the shell's location produces a different state directory, a
 * different clone and a different `.env` for the same installation — silently,
 * and with config simply missing rather than reported.
 */
export function bootstrapConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const envDir =
    // The checkout's own configuration takes precedence...
    loadEnvFile(PACKAGE_ROOT, 1) ??
    // ...then a working directory that has one, for an unconventional layout...
    loadEnvFile(process.cwd()) ??
    // ...and failing both, a stable per-user location.
    homedir();

  return loadConfig(env, envDir);
}

function num(value: string | undefined, fallback: number): number {
  const n = value === undefined ? Number.NaN : Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function bool(value: string | undefined, fallback = false): boolean {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

/**
 * Find and load `.env`, searching upwards from the working directory.
 *
 * Searching upwards rather than checking only the current directory, the way
 * git finds `.git`: the bridge is commonly started from wherever the shell
 * happens to be, and a `.env` that is silently not found leaves it running
 * read-only with no relay, no token and no secret — and nothing says so.
 *
 * Uses the platform's own loader rather than a dependency. A missing or
 * malformed file is not an error: read-only monitoring needs no credentials.
 *
 * @returns the directory the file was found in, which relative paths in it are
 *   resolved against — so they mean the same thing from any working directory.
 */
export function loadEnvFile(startDir = process.cwd(), maxLevels = 6): string | null {
  let dir = resolve(startDir);

  for (let level = 0; level < maxLevels; level++) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) {
      try {
        const loader = (process as unknown as { loadEnvFile?: (p: string) => void }).loadEnvFile;
        if (typeof loader === 'function') loader.call(process, candidate);
      } catch {
        // A malformed .env should not stop the bridge from starting read-only.
      }
      return dir;
    }

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return null;
}

/**
 * @param baseDir what relative paths are resolved against — normally the
 *   directory holding `.env`, never the working directory. Resolving against the
 *   working directory means the same configuration produces a different state
 *   directory depending on where the shell was, which fragments tail offsets and
 *   clones, and lets two bridges run against one relay while each believes it is
 *   the only one.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  baseDir: string = process.cwd(),
): BridgeConfig {
  const claudeDir = join(homedir(), '.claude');
  const stateDir = resolve(baseDir, env['CCR_STATE_DIR'] ?? '.ccr-state');

  return {
    projectsDir: env['CCR_PROJECTS_DIR'] ?? join(claudeDir, 'projects'),
    sessionsDir: env['CCR_SESSIONS_DIR'] ?? join(claudeDir, 'sessions'),
    stateDir,
    outDir: resolve(baseDir, env['CCR_OUT_DIR'] ?? join(stateDir, 'out')),

    repoUrl: env['CCR_REPO_URL'] ?? null,
    repoToken: env['CCR_REPO_TOKEN'] ?? null,
    outBranch: env['CCR_OUT_BRANCH'] ?? 'relay-out',
    inBranch: env['CCR_IN_BRANCH'] ?? 'relay-in',
    secret: env['CCR_SECRET'] ?? null,

    pushMinIntervalMs: num(env['CCR_PUSH_MIN_MS'], 5_000),
    pollIntervalMs: num(env['CCR_POLL_MS'], 10_000),

    retainBytes: num(env['CCR_RETAIN_BYTES'], 10 * 1024 * 1024),
    maxSessions: num(env['CCR_MAX_SESSIONS'], 50),
    maxChunksPerSession: num(env['CCR_MAX_CHUNKS'], 300),
    lockStaleMs: num(env['CCR_LOCK_STALE_MS'], 20_000),

    hookPort: num(env['CCR_HOOK_PORT'], DEFAULT_HOOK_PORT),
    hookToken: env['CCR_HOOK_TOKEN'] ?? null,
    hookQuietMs: num(env['CCR_HOOK_QUIET_MS'], 120_000),

    allowInjection: bool(env['CCR_ALLOW_INJECTION']),
    promptMaxAgeMs: num(env['CCR_PROMPT_MAX_AGE_MS'], 10 * 60 * 1000),

    coldStartBytes: num(env['CCR_COLD_START_BYTES'], 256 * 1024),
    pollFilesMs: num(env['CCR_POLL_FILES_MS'], 400),
    rescanMs: num(env['CCR_RESCAN_MS'], 3_000),
  };
}
