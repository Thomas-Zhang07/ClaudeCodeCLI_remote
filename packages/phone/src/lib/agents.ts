/**
 * Walking a published subagent forest.
 *
 * The forest arrives nested by `parentAgentId`, but a node whose `children` were
 * dropped — truncation, or a bridge too old to publish them — is still reachable
 * from `parentAgentId`, so anything counting or listing agents has to be able to
 * flatten rather than trust the shape.
 *
 * Shared rather than written three times: the session header asks "is anything
 * running?", the panel lists them, and the tree draws them, and those three
 * answers disagreeing is exactly the kind of bug nobody looks for.
 */

import type { SubagentNode } from '@/types';

export function flattenAgents(nodes: readonly SubagentNode[]): SubagentNode[] {
  const out: SubagentNode[] = [];

  const walk = (list: readonly SubagentNode[]): void => {
    for (const node of list) {
      // A malformed file is data from another process, not a guarantee.
      if (!node || typeof node !== 'object') continue;
      out.push(node);
      if (Array.isArray(node.children)) walk(node.children);
    }
  };

  walk(nodes);
  return out;
}

export function countAgents(nodes: readonly SubagentNode[]): { total: number; running: number } {
  const all = flattenAgents(nodes);
  return {
    total: all.length,
    running: all.filter((node) => node.status === 'running').length,
  };
}
