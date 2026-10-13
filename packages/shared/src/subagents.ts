/**
 * Subagent tree assembly.
 *
 * Three separate sources have to be joined, and none of them is sufficient
 * alone:
 *
 *   1. An assistant `tool_use` named Agent/Task  — proves an agent was spawned
 *   2. `<sessionId>/subagents/agent-<id>.meta.json` — the agent's type, its
 *      spawning `toolUseId`, and crucially `parentAgentId`
 *   3. `<sessionId>/subagents/agent-<id>.jsonl` — its transcript
 *
 * Nesting comes from `parentAgentId`. It is **not** encoded in the directory
 * layout: every agent sits flat in one `subagents/` directory no matter how deep
 * it is, so walking paths would produce a flat list and silently lose the tree.
 */

import type { SubagentMeta, SubagentNode, SubagentStatus } from './types.js';

/**
 * Parse an `agent-<id>.meta.json` file.
 *
 * The `agentId` is taken from the filename when the file omits it — the bridge
 * knows it from the path and the file has been observed without the field.
 */
export function parseSubagentMeta(raw: unknown, agentIdFromPath: string): SubagentMeta | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;

  const agentId = str(o['agentId']) ?? agentIdFromPath;
  if (!agentId) return null;

  return {
    agentId,
    agentType: str(o['agentType']) ?? 'unknown',
    description: str(o['description']) ?? '',
    toolUseId: str(o['toolUseId']) ?? '',
    parentAgentId: str(o['parentAgentId']),
    spawnDepth: num(o['spawnDepth']) ?? 1,
    ...(str(o['requestShape']) ? { requestShape: str(o['requestShape'])! } : {}),
  };
}

/** Extract the agent id from a `agent-<id>.jsonl` or `agent-<id>.meta.json` filename. */
export function agentIdFromFilename(filename: string): string | null {
  const m = /^agent-([A-Za-z0-9_-]+)\.(?:jsonl|meta\.json)$/.exec(filename);
  return m?.[1] ?? null;
}

export interface BuildTreeOptions {
  sessionId: string;
  /** Status per agentId, when known from the transcript or a hand-back. */
  statuses?: Map<string, SubagentStatus>;
  models?: Map<string, string>;
}

/**
 * Nest a flat list of agent metadata into a forest.
 *
 * An agent whose `parentAgentId` is missing from the list is promoted to a root
 * rather than dropped: the parent may still be running, may have been pruned, or
 * may belong to a different session after a `--resume`. Losing a running agent
 * from the view is worse than showing it one level too high.
 */
export function buildSubagentTree(
  metas: readonly SubagentMeta[],
  options: BuildTreeOptions,
): SubagentNode[] {
  const nodes = new Map<string, SubagentNode>();

  for (const meta of metas) {
    nodes.set(meta.agentId, {
      ...meta,
      sessionId: options.sessionId,
      status: options.statuses?.get(meta.agentId) ?? 'running',
      children: [],
      ...(options.models?.get(meta.agentId) ? { model: options.models.get(meta.agentId)! } : {}),
    });
  }

  const roots: SubagentNode[] = [];

  for (const node of nodes.values()) {
    const parentId = node.parentAgentId;

    // Self-parenting or a cycle would make the render recurse forever.
    if (parentId && parentId !== node.agentId) {
      const parent = nodes.get(parentId);
      if (parent && !createsCycle(nodes, node.agentId, parentId)) {
        parent.children.push(node);
        continue;
      }
    }
    roots.push(node);
  }

  sortRecursively(roots);
  return roots;
}

/**
 * Guard against a malformed parent chain.
 *
 * Guards against a cycle that would make rendering recurse forever. Walks up
 * from the proposed parent; if it reaches the child, the link must be dropped.
 */
function createsCycle(
  nodes: Map<string, SubagentNode>,
  childId: string,
  parentId: string,
): boolean {
  const seen = new Set<string>();
  let cursor: string | null = parentId;

  while (cursor) {
    if (cursor === childId) return true;
    if (seen.has(cursor)) return true;
    seen.add(cursor);
    cursor = nodes.get(cursor)?.parentAgentId ?? null;
  }
  return false;
}

function sortRecursively(nodes: SubagentNode[]): void {
  nodes.sort((a, b) => {
    if (a.spawnDepth !== b.spawnDepth) return a.spawnDepth - b.spawnDepth;
    return (a.startedAt ?? '').localeCompare(b.startedAt ?? '');
  });
  for (const node of nodes) sortRecursively(node.children);
}

/** Flatten a tree back to a list, depth-first. */
export function flattenTree(roots: readonly SubagentNode[]): SubagentNode[] {
  const out: SubagentNode[] = [];
  const walk = (nodes: readonly SubagentNode[]): void => {
    for (const n of nodes) {
      out.push(n);
      walk(n.children);
    }
  };
  walk(roots);
  return out;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
