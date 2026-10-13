/**
 * Bridge configuration.
 *
 * Read once at startup and passed down explicitly rather than reached for
 * globally, so tests can construct a config without touching the environment.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

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

function num(value: string | undefined, fallback: number): number {
  const n = value === undefined ? Number.NaN : Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function bool(value: string | undefined, fallback = false): boolean {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

/**
 * Load `.env` if present.
 *
 * Uses the platform's own loader rather than a dependency. Failure is ignored:
 * a missing `.env` is the normal case for read-only monitoring, which needs no
 * relay credentials at all.
 */
export function loadEnvFile(path = '.env'): void {
  if (!existsSync(path)) return;
  try {
    const loader = (process as unknown as { loadEnvFile?: (p: string) => void }).loadEnvFile;
    if (typeof loader === 'function') loader.call(process, path);
  } catch {
    // A malformed .env should not stop the bridge from starting read-only.
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const claudeDir = join(homedir(), '.claude');
  const stateDir = resolve(env['CCR_STATE_DIR'] ?? '.ccr-state');

  return {
    projectsDir: env['CCR_PROJECTS_DIR'] ?? join(claudeDir, 'projects'),
    sessionsDir: env['CCR_SESSIONS_DIR'] ?? join(claudeDir, 'sessions'),
    stateDir,
    outDir: resolve(env['CCR_OUT_DIR'] ?? join(stateDir, 'out')),

    repoUrl: env['CCR_REPO_URL'] ?? null,
    repoToken: env['CCR_REPO_TOKEN'] ?? null,
    outBranch: env['CCR_OUT_BRANCH'] ?? 'relay-out',
    inBranch: env['CCR_IN_BRANCH'] ?? 'relay-in',
    secret: env['CCR_SECRET'] ?? null,

    pushMinIntervalMs: num(env['CCR_PUSH_MIN_MS'], 5_000),
    pollIntervalMs: num(env['CCR_POLL_MS'], 10_000),

    retainBytes: num(env['CCR_RETAIN_BYTES'], 10 * 1024 * 1024),
    maxSessions: num(env['CCR_MAX_SESSIONS'], 50),

    allowInjection: bool(env['CCR_ALLOW_INJECTION']),
    promptMaxAgeMs: num(env['CCR_PROMPT_MAX_AGE_MS'], 10 * 60 * 1000),

    coldStartBytes: num(env['CCR_COLD_START_BYTES'], 256 * 1024),
    pollFilesMs: num(env['CCR_POLL_FILES_MS'], 400),
    rescanMs: num(env['CCR_RESCAN_MS'], 3_000),
  };
}
