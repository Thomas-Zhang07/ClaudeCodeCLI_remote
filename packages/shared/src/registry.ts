/**
 * The live session registry: `~/.claude/sessions/<pid>.json`.
 *
 * This is authoritative in a way the transcripts are not. A transcript records
 * what happened; the registry records what *is* — which sessions are running,
 * their real working directory, and whether one is blocked waiting on input.
 *
 * It is also the only reliable way to tell a session the bridge can inject into
 * (`ccr`-launched, stdin owned by us) from an ordinary `claude` session, which
 * must stay read-only.
 */

import type { SessionStatus } from './types.js';

export interface RegistryEntry {
  pid: number;
  sessionId: string;
  cwd: string | null;
  kind: string | null;
  entrypoint: string | null;
  /** Raw status string as recorded by the harness. */
  rawStatus: string | null;
  waitingFor: string | null;
  name: string | null;
  messagingSocketPath: string | null;
  peerProtocol: number | null;
}

export function parseRegistryEntry(raw: unknown): RegistryEntry | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;

  const sessionId = str(o['sessionId']);
  const pid = num(o['pid']);
  if (!sessionId || pid === null) return null;

  return {
    pid,
    sessionId,
    cwd: str(o['cwd']),
    kind: str(o['kind']),
    entrypoint: str(o['entrypoint']),
    rawStatus: str(o['status']),
    waitingFor: str(o['waitingFor']),
    name: str(o['name']),
    messagingSocketPath: str(o['messagingSocketPath']),
    peerProtocol: num(o['peerProtocol']),
  };
}

/**
 * Map the harness's own status vocabulary onto ours.
 *
 * Anything unrecognised becomes `idle` rather than `active`: over-reporting
 * activity would make the phone claim work is happening when it is not, which is
 * worse than a stale-looking session.
 */
export function toSessionStatus(entry: RegistryEntry): SessionStatus {
  const status = (entry.rawStatus ?? '').toLowerCase();
  const waiting = (entry.waitingFor ?? '').toLowerCase();

  if (waiting && waiting !== '') return 'waiting';
  if (status === 'waiting' || status === 'blocked') return 'waiting';
  if (status === 'active' || status === 'working' || status === 'busy') return 'active';
  if (status === 'ended' || status === 'exited' || status === 'stopped') return 'ended';
  return 'idle';
}

/** The waiting reason, if there is one, phrased for display. */
export function toWaitingFor(entry: RegistryEntry): string | null {
  const waiting = entry.waitingFor;
  if (!waiting) return null;
  return waiting;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
