import { describe, expect, it } from 'vitest';

import { SessionAggregator } from '../src/session.js';
import type { RegistryEntry } from '@ccr/shared';

const TS = '2026-10-13T10:00:00.000Z';

const line = (o: Record<string, unknown>): string => JSON.stringify({ timestamp: TS, ...o });

function assistantText(text: string): string {
  return line({
    type: 'assistant',
    message: { role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text }] },
  });
}

describe('SessionAggregator', () => {
  it('assigns strictly increasing sequence numbers', () => {
    const agg = new SessionAggregator('sess-1');
    const a = agg.ingest(assistantText('one'));
    const b = agg.ingest(assistantText('two'));

    const seqs = [...a.events, ...b.events].map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it('resumes sequencing from a restored position', () => {
    const agg = new SessionAggregator('sess-1', 100);
    expect(agg.ingest(assistantText('x')).events[0]!.seq).toBe(100);
  });

  describe('last-wins routing', () => {
    it('keeps cost out of the timeline', () => {
      const agg = new SessionAggregator('sess-1');
      const r = agg.ingest(
        line({ type: 'cost-state', totalCostUSD: 1.5, totalLinesAdded: 10, modelUsage: {} }),
      );

      expect(r.events).toEqual([]);
      expect(r.state.cost?.totalCostUSD).toBe(1.5);
      expect(r.stateDirty).toBe(true);
    });

    it('emits a title event only when the title actually changes', () => {
      const agg = new SessionAggregator('sess-1');

      const first = agg.ingest(line({ type: 'ai-title', aiTitle: 'Fix the build' }));
      expect(first.events.filter((e) => e.kind === 'title')).toHaveLength(1);

      // ai-title re-fires constantly with the same value in real transcripts.
      const second = agg.ingest(line({ type: 'ai-title', aiTitle: 'Fix the build' }));
      expect(second.events.filter((e) => e.kind === 'title')).toHaveLength(0);

      const third = agg.ingest(line({ type: 'ai-title', aiTitle: 'Fix the flaky build' }));
      expect(third.events.filter((e) => e.kind === 'title')).toHaveLength(1);
    });

    it('stamps a synthesized title event with the entry time, not the epoch', () => {
      // The title entry produces no parsed events, so a naive implementation
      // leaves the timestamp at its initial value and dates the event to 1970.
      const agg = new SessionAggregator('sess-1');
      const r = agg.ingest(line({ type: 'ai-title', aiTitle: 'Fresh' }));

      const title = r.events.find((e) => e.kind === 'title');
      expect(title?.ts).toBe(TS);
      expect(r.state.updatedAt).toBe(TS);
    });

    it('defers a title event when the entry carries no timestamp at all', () => {
      // Real ai-title entries look like {"type":"ai-title","aiTitle":"..."} with
      // no timestamp field, so there is genuinely no time to stamp the event.
      const agg = new SessionAggregator('sess-1');
      const first = agg.ingest(JSON.stringify({ type: 'ai-title', aiTitle: 'Untimed' }));

      expect(first.events.filter((e) => e.kind === 'title')).toHaveLength(0);
      expect(agg.state.title).toBe('Untimed'); // state is still correct

      // The next timestamped line releases it.
      const second = agg.ingest(assistantText('hello'));
      const titles = second.events.filter((e) => e.kind === 'title');
      expect(titles).toHaveLength(1);
      expect(titles[0]!.ts).toBe(TS);
    });

    it('never emits an epoch-stamped event for an untimed title', () => {
      const agg = new SessionAggregator('sess-1');
      const r = agg.ingest(JSON.stringify({ type: 'ai-title', aiTitle: 'Untimed' }));
      expect(JSON.stringify(r.events)).not.toContain('1970-01-01');
    });

    it('never moves last-activity backwards', () => {
      const agg = new SessionAggregator('sess-1', 0, { updatedAt: '2030-01-01T00:00:00.000Z' });
      agg.ingest(line({ type: 'ai-title', aiTitle: 'Older entry' }));
      expect(agg.state.updatedAt).toBe('2030-01-01T00:00:00.000Z');
    });

    it('does not re-emit a title restored from persisted state', () => {
      const agg = new SessionAggregator('sess-1', 0, { title: 'Existing' });
      const r = agg.ingest(line({ type: 'ai-title', aiTitle: 'Existing' }));
      expect(r.events.filter((e) => e.kind === 'title')).toHaveLength(0);
    });
  });

  describe('subagents', () => {
    const spawnResult = line({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1' }] },
      toolUseResult: {
        isAsync: true,
        agentId: 'agent-abc',
        description: 'Check the docs',
        resolvedModel: 'claude-haiku-5-5',
      },
    });

    it('emits subagent_start once per agent', () => {
      const agg = new SessionAggregator('sess-1');
      const first = agg.ingest(spawnResult);
      const starts = first.events.filter((e) => e.kind === 'subagent_start');
      expect(starts).toHaveLength(1);

      const second = agg.ingest(spawnResult);
      expect(second.events.filter((e) => e.kind === 'subagent_start')).toHaveLength(0);
    });

    it('closes an agent on a hand-back, which is how completion arrives', () => {
      const agg = new SessionAggregator('sess-1');
      agg.ingest(spawnResult);

      const r = agg.ingest(
        line({
          type: 'user',
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c2' }] },
          toolUseResult: {
            content: '<agent-message from="agent-abc" from-name="worker">done</agent-message>',
          },
        }),
      );

      const stop = r.events.find((e) => e.kind === 'subagent_stop');
      expect(stop).toBeDefined();
      if (stop?.kind === 'subagent_stop') expect(stop.agentId).toBe('agent-abc');
    });

    it('nests the tree from meta files, not from directory layout', () => {
      const agg = new SessionAggregator('sess-1');
      agg.registerSubagentMeta({ agentType: 'Explore', spawnDepth: 1 }, 'parent1');
      agg.registerSubagentMeta(
        { agentType: 'Plan', parentAgentId: 'parent1', spawnDepth: 2 },
        'child1',
      );

      const tree = agg.subagentTree();
      expect(tree).toHaveLength(1);
      expect(tree[0]!.agentId).toBe('parent1');
      expect(tree[0]!.children[0]!.agentId).toBe('child1');
    });

    it('reports no change when meta is re-read identically', () => {
      const agg = new SessionAggregator('sess-1');
      expect(agg.registerSubagentMeta({ agentType: 'Plan' }, 'a')).toBe(true);
      expect(agg.registerSubagentMeta({ agentType: 'Plan' }, 'a')).toBe(false);
    });

    it('tags events from a subagent transcript with the agent id', () => {
      const agg = new SessionAggregator('sess-1');
      const r = agg.ingest(assistantText('from the subagent'), 'agent-xyz');
      expect(r.events[0]!.agentId).toBe('agent-xyz');
    });
  });

  describe('registry liveness', () => {
    const entry: RegistryEntry = {
      pid: 1516,
      sessionId: 'sess-1',
      cwd: 'E:\\CCCLI_remote',
      kind: 'interactive',
      entrypoint: 'cli',
      rawStatus: 'waiting',
      waitingFor: 'input needed',
      name: 'cccli-remote-91',
      messagingSocketPath: '\\\\.\\pipe\\cc-msg-x',
      peerProtocol: 1,
    };

    it('takes status and attention from the registry, not from the transcript', () => {
      const agg = new SessionAggregator('sess-1');
      expect(agg.applyRegistry(entry, true)).toBe(true);
      expect(agg.state.status).toBe('waiting');
      expect(agg.state.waitingFor).toBe('input needed');
      expect(agg.state.project).toBe('E:\\CCCLI_remote');
      expect(agg.state.controllable).toBe(true);
      expect(agg.state.cost).toBeUndefined();
    });

    it('reports no change when nothing moved', () => {
      const agg = new SessionAggregator('sess-1');
      agg.applyRegistry(entry, true);
      expect(agg.applyRegistry(entry, true)).toBe(false);
    });

    it('marks an untracked session as ended', () => {
      const agg = new SessionAggregator('sess-1');
      agg.applyRegistry(entry, true);
      agg.applyRegistry(null, false);
      expect(agg.state.status).toBe('ended');
      expect(agg.state.controllable).toBe(false);
    });
  });

  it('reports idle time from the last event', () => {
    const agg = new SessionAggregator('sess-1');
    expect(agg.idleFor()).toBe(Number.POSITIVE_INFINITY);

    agg.ingest(assistantText('hello'));
    expect(agg.idleFor()).toBeLessThan(1_000);
  });
});
