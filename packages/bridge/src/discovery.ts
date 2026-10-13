/**
 * Finding sessions on disk.
 *
 * Two independent sources, deliberately kept separate:
 *
 *  - the **transcript tree** (`projects/<slug>/<sessionId>.jsonl`), which is the
 *    content
 *  - the **session registry** (`sessions/<pid>.json`), which is the truth about
 *    what is currently running
 *
 * Neither is sufficient. Transcripts outlive their processes, so the tree alone
 * cannot tell a live session from one that ended last week; and the registry
 * says nothing about what happened.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { agentIdFromFilename, parseRegistryEntry, type RegistryEntry } from '@ccr/shared';

export interface DiscoveredSession {
  sessionId: string;
  transcriptPath: string;
  /** Directory holding this session's subagent transcripts, if any. */
  sessionDir: string;
}

export interface DiscoveredAgent {
  agentId: string;
  jsonlPath: string;
  metaPath: string;
}

/**
 * Walk the transcript tree.
 *
 * Directory names are the cwd slug, which is lossy — `E--a-b` and `E:\a\b` map to
 * the same slug — so nothing here derives a path from a slug. The slug is kept
 * only as a label; the authoritative directory comes from the transcript or the
 * registry.
 */
export async function scanProjects(projectsDir: string): Promise<DiscoveredSession[]> {
  const found: DiscoveredSession[] = [];

  let slugs: string[];
  try {
    slugs = (await readdir(projectsDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return found;
  }

  for (const slug of slugs) {
    const dir = join(projectsDir, slug);
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const sessionId = entry.name.replace(/\.jsonl$/, '');
      // Session directories are named after the session id and sit alongside.
      found.push({
        sessionId,
        transcriptPath: join(dir, entry.name),
        sessionDir: join(dir, sessionId),
      });
    }
  }

  return found;
}

/** List a session's subagent artifacts. */
export async function scanAgents(sessionDir: string): Promise<DiscoveredAgent[]> {
  const subagentsDir = join(sessionDir, 'subagents');

  let names: string[];
  try {
    names = await readdir(subagentsDir);
  } catch {
    return [];
  }

  const byId = new Map<string, Partial<DiscoveredAgent>>();
  for (const name of names) {
    const agentId = agentIdFromFilename(name);
    if (!agentId) continue;

    const record = byId.get(agentId) ?? { agentId };
    if (name.endsWith('.jsonl')) record.jsonlPath = join(subagentsDir, name);
    else record.metaPath = join(subagentsDir, name);
    byId.set(agentId, record);
  }

  return [...byId.values()].filter(
    (a): a is DiscoveredAgent => Boolean(a.jsonlPath && a.metaPath),
  );
}

/**
 * Read the live session registry.
 *
 * A malformed or half-written entry is skipped rather than thrown: the harness
 * writes these as sessions start and stop, so catching one mid-write is normal.
 */
export async function readRegistry(sessionsDir: string): Promise<RegistryEntry[]> {
  const out: RegistryEntry[] = [];

  let names: string[];
  try {
    names = await readdir(sessionsDir);
  } catch {
    return out;
  }

  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const raw: unknown = JSON.parse(await readFile(join(sessionsDir, name), 'utf8'));
      const entry = parseRegistryEntry(raw);
      if (entry) out.push(entry);
    } catch {
      // Mid-write or malformed; it will be readable next poll.
    }
  }

  return out;
}

/** Read and parse a JSON file, or null if it is missing or unreadable. */
export async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

/** True when the path exists and is a regular file. */
export async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
