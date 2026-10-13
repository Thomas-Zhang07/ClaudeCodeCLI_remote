import { describe, expect, it } from 'vitest';
import {
  agentIdFromFilename,
  buildSubagentTree,
  flattenTree,
  parseSubagentMeta,
} from '../src/subagents.js';
import type { SubagentMeta, SubagentStatus } from '../src/types.js';

function meta(over: Partial<SubagentMeta> & { agentId: string }): SubagentMeta {
  return {
    agentType: 'general-purpose',
    description: 'a task',
    toolUseId: `call_${over.agentId}`,
    parentAgentId: null,
    spawnDepth: 1,
    ...over,
  };
}

describe('parseSubagentMeta', () => {
  it('reads the fields the tree depends on', () => {
    const m = parseSubagentMeta(
      {
        agentType: 'Explore',
        description: 'Verify Node facts',
        toolUseId: 'call_02_xyz',
        spawnDepth: 1,
        requestShape: 'background',
      },
      'a37e52e46881f9769',
    );

    expect(m?.agentId).toBe('a37e52e46881f9769');
    expect(m?.agentType).toBe('Explore');
    expect(m?.parentAgentId).toBeNull();
  });

  it('reads parentAgentId, which is what actually encodes nesting', () => {
    const m = parseSubagentMeta(
      { agentType: 'general-purpose', parentAgentId: 'ae9f18a44905910f3', spawnDepth: 2 },
      'child123',
    );
    expect(m?.parentAgentId).toBe('ae9f18a44905910f3');
    expect(m?.spawnDepth).toBe(2);
  });

  it('falls back to the filename when the file omits agentId', () => {
    expect(parseSubagentMeta({ agentType: 'Plan' }, 'frompath')?.agentId).toBe('frompath');
  });

  it('rejects junk', () => {
    expect(parseSubagentMeta(null, 'x')).toBeNull();
    expect(parseSubagentMeta([], 'x')).toBeNull();
  });
});

describe('agentIdFromFilename', () => {
  it('extracts the id from both file kinds', () => {
    expect(agentIdFromFilename('agent-a694847ec0fba52f8.jsonl')).toBe('a694847ec0fba52f8');
    expect(agentIdFromFilename('agent-afe22574158c72525.meta.json')).toBe('afe22574158c72525');
  });

  it('returns null for unrelated names', () => {
    expect(agentIdFromFilename('events-0001.jsonl')).toBeNull();
    expect(agentIdFromFilename('state.json')).toBeNull();
  });
});

describe('buildSubagentTree', () => {
  const opts = { sessionId: 'sess-1' };

  it('nests depth-2 agents under their parent, not flat', () => {
    const roots = buildSubagentTree(
      [
        meta({ agentId: 'parent1' }),
        meta({ agentId: 'child1', parentAgentId: 'parent1', spawnDepth: 2 }),
      ],
      opts,
    );

    expect(roots).toHaveLength(1);
    expect(roots[0]!.agentId).toBe('parent1');
    expect(roots[0]!.children).toHaveLength(1);
    expect(roots[0]!.children[0]!.agentId).toBe('child1');
  });

  it('keeps concurrent depth-1 agents as siblings', () => {
    const roots = buildSubagentTree(
      [meta({ agentId: 'a' }), meta({ agentId: 'b' }), meta({ agentId: 'c' })],
      opts,
    );
    expect(roots.map((r) => r.agentId)).toEqual(['a', 'b', 'c']);
  });

  it('promotes an orphan to a root rather than dropping a running agent', () => {
    const roots = buildSubagentTree(
      [meta({ agentId: 'orphan', parentAgentId: 'never-seen', spawnDepth: 2 })],
      opts,
    );
    expect(roots.map((r) => r.agentId)).toEqual(['orphan']);
  });

  it('survives a parent cycle without recursing forever', () => {
    const roots = buildSubagentTree(
      [
        meta({ agentId: 'x', parentAgentId: 'y' }),
        meta({ agentId: 'y', parentAgentId: 'x' }),
      ],
      opts,
    );
    // Both become roots; the important property is that this terminates.
    expect(flattenTree(roots).map((n) => n.agentId).sort()).toEqual(['x', 'y']);
  });

  it('ignores a self-parent link', () => {
    const roots = buildSubagentTree([meta({ agentId: 'self', parentAgentId: 'self' })], opts);
    expect(roots).toHaveLength(1);
    expect(roots[0]!.children).toHaveLength(0);
  });

  it('applies known statuses and defaults the rest to running', () => {
    const statuses = new Map<string, SubagentStatus>([['a', 'completed']]);
    const roots = buildSubagentTree([meta({ agentId: 'a' }), meta({ agentId: 'b' })], {
      ...opts,
      statuses,
    });

    const byId = new Map(flattenTree(roots).map((n) => [n.agentId, n.status]));
    expect(byId.get('a')).toBe('completed');
    expect(byId.get('b')).toBe('running');
  });

  it('tags every node with the session id, from the parent session', () => {
    const roots = buildSubagentTree([meta({ agentId: 'a' })], opts);
    expect(roots[0]!.sessionId).toBe('sess-1');
  });

  it('handles an empty agent list', () => {
    expect(buildSubagentTree([], opts)).toEqual([]);
  });
});
