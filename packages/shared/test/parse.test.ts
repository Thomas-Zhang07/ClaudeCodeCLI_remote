import { describe, expect, it } from 'vitest';
import { parseTranscriptEntry, renderPatch } from '../src/parse.js';
import type { EventDraft } from '../src/types.js';

/** An edit before sequencing; the bridge assigns `seq`. */
type EditDraft = Extract<EventDraft, { kind: 'edit' }>;

const ctx = { sessionId: 'sess-1', agentId: null };
const TS = '2026-10-13T10:00:00.000Z';

/** Find the first event of a kind, or fail loudly. */
function only<K extends EventDraft['kind']>(
  events: EventDraft[],
  kind: K,
): Extract<EventDraft, { kind: K }> {
  const found = events.filter((e) => e.kind === kind);
  expect(found, `expected exactly one ${kind}`).toHaveLength(1);
  return found[0] as Extract<EventDraft, { kind: K }>;
}

describe('parseTranscriptEntry', () => {
  describe('robustness', () => {
    it('does not throw on malformed JSON', () => {
      const r = parseTranscriptEntry('{"broken":', ctx);
      expect(r.events).toEqual([]);
      expect(r.skipped).toBe('invalid-json');
    });

    it('ignores unknown entry types rather than guessing', () => {
      const r = parseTranscriptEntry({ type: 'some-future-type', timestamp: TS }, ctx);
      expect(r.events).toEqual([]);
    });

    it('ignores file-history entries', () => {
      const r = parseTranscriptEntry(
        { type: 'file-history-snapshot', timestamp: TS, snapshot: { huge: 'x'.repeat(1000) } },
        ctx,
      );
      expect(r.events).toEqual([]);
    });

    it('tolerates a BOM and NUL padding', () => {
      // Asserted on the extracted value rather than on events: the point is that
      // the line parsed at all, not what it produced.
      const line = '\uFEFF\u0000{"type":"ai-title","aiTitle":"Hi","sessionId":"sess-1"}';
      expect(parseTranscriptEntry(line, ctx).state.title).toBe('Hi');
    });
  });

  describe('assistant messages', () => {
    it('emits assistant text and records the model', () => {
      const r = parseTranscriptEntry(
        {
          type: 'assistant',
          timestamp: TS,
          message: {
            role: 'assistant',
            model: 'claude-sonnet-5-5',
            content: [{ type: 'text', text: 'Working on it.' }],
          },
        },
        ctx,
      );

      const ev = only(r.events, 'assistant_text');
      expect(ev.text).toBe('Working on it.');
      expect(ev.model).toBe('claude-sonnet-5-5');
      expect(r.state.model).toBe('claude-sonnet-5-5');
    });

    it('drops thinking blocks', () => {
      const r = parseTranscriptEntry(
        {
          type: 'assistant',
          timestamp: TS,
          message: {
            role: 'assistant',
            content: [{ type: 'thinking', thinking: 'internal reasoning' }],
          },
        },
        ctx,
      );
      expect(r.events).toEqual([]);
    });

    it('does not emit events for tool calls', () => {
      const r = parseTranscriptEntry(
        {
          type: 'assistant',
          timestamp: TS,
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'call_1',
                name: 'Bash',
                input: { command: 'ls -la' },
              },
            ],
          },
        },
        ctx,
      );
      expect(r.events).toEqual([]);
    });
  });

  describe('user prompts', () => {
    it('emits a prompt and opens a turn', () => {
      const r = parseTranscriptEntry(
        {
          type: 'user',
          timestamp: TS,
          uuid: 'u1',
          promptId: 'p1',
          origin: { kind: 'human' },
          message: { role: 'user', content: 'please fix the build' },
        },
        ctx,
      );

      expect(only(r.events, 'user_prompt').text).toBe('please fix the build');
      expect(only(r.events, 'turn_start').turnId).toBe('p1');
    });

    it('skips harness-injected reminder content posing as a user turn', () => {
      const r = parseTranscriptEntry(
        {
          type: 'user',
          timestamp: TS,
          message: { role: 'user', content: '<system-reminder>do not show me</system-reminder>' },
        },
        ctx,
      );
      expect(r.events).toEqual([]);
    });

    it('does not treat a tool result as a prompt', () => {
      const r = parseTranscriptEntry(
        {
          type: 'user',
          timestamp: TS,
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'output' }],
          },
        },
        ctx,
      );
      expect(r.events).toEqual([]);
    });
  });

  describe('edits', () => {
    const editResult = {
      type: 'user',
      timestamp: TS,
      sourceToolAssistantUUID: 'call_edit_1',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call_edit_1' }],
      },
      toolUseResult: {
        filePath: 'E:\\project\\src\\index.ts',
        oldString: 'const a = 1;',
        newString: 'const a = 2;',
        structuredPatch: [
          {
            oldStart: 10,
            oldLines: 1,
            newStart: 10,
            newLines: 1,
            lines: ['-const a = 1;', '+const a = 2;'],
          },
        ],
      },
    };

    it('renders a real unified diff from structuredPatch', () => {
      const r = parseTranscriptEntry(editResult, ctx);
      const ev = only(r.events, 'edit') as EditDraft;

      expect(ev.tool).toBe('Edit');
      expect(ev.filePath).toContain('index.ts');
      expect(ev.patch).toContain('@@ -10,1 +10,1 @@');
      expect(ev.patch).toContain('-const a = 1;');
      expect(ev.patch).toContain('+const a = 2;');
      expect(ev.added).toBe(1);
      expect(ev.removed).toBe(1);
    });

    it('recognises a Write as a file creation', () => {
      const r = parseTranscriptEntry(
        {
          type: 'user',
          timestamp: TS,
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c2' }] },
          toolUseResult: {
            filePath: 'E:\\project\\new.ts',
            content: 'export const x = 1;',
            originalFile: '',
            structuredPatch: [
              { oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ['+export const x = 1;'] },
            ],
          },
        },
        ctx,
      );

      const ev = only(r.events, 'edit') as EditDraft;
      expect(ev.tool).toBe('Write');
      expect(ev.created).toBe(true);
    });

    it('ignores a non-edit tool result such as a Read', () => {
      const r = parseTranscriptEntry(
        {
          type: 'user',
          timestamp: TS,
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c3' }] },
          toolUseResult: { file: { filePath: 'a.ts', numLines: 10, totalLines: 10 }, type: 'text' },
        },
        ctx,
      );
      expect(r.events).toEqual([]);
    });
  });

  describe('attachments', () => {
    it('drops prompt_snapshot, which embeds the whole system prompt', () => {
      const r = parseTranscriptEntry(
        {
          type: 'attachment',
          timestamp: TS,
          attachment: {
            type: 'prompt_snapshot',
            systemPrompt: 'x'.repeat(50_000),
            tools: new Array(100).fill({ huge: 'y'.repeat(2_000) }),
          },
        },
        ctx,
      );
      expect(r.events).toEqual([]);
      expect(r.state).toEqual({});
    });

    it('drops the other high-volume attachment subtypes', () => {
      for (const subtype of ['skill_listing', 'agent_listing_delta', 'deferred_tools_record']) {
        const r = parseTranscriptEntry(
          { type: 'attachment', timestamp: TS, attachment: { type: subtype, payload: 'z'.repeat(9000) } },
          ctx,
        );
        expect(r.events, subtype).toEqual([]);
      }
    });

    it('reads the working directory out of the environment snapshot', () => {
      const r = parseTranscriptEntry(
        {
          type: 'attachment',
          timestamp: TS,
          attachment: {
            type: 'environment',
            snapshot: { workingDirectory: 'E:\\project', isGitRepo: true },
          },
        },
        ctx,
      );
      expect(r.state.project).toBe('E:\\project');
    });
  });

  describe('state-only entries', () => {
    it('routes cost-state to state and never to the timeline', () => {
      const r = parseTranscriptEntry(
        {
          type: 'cost-state',
          timestamp: TS,
          totalCostUSD: 0.35284,
          totalAPIDuration: 47048,
          totalToolDuration: 20991,
          totalLinesAdded: 348,
          totalLinesRemoved: 12,
          modelUsage: {
            'claude-sonnet-5-5': {
              inputTokens: 63926,
              outputTokens: 8726,
              cacheReadInputTokens: 688640,
              costUSD: 0.35284,
            },
          },
        },
        ctx,
      );

      expect(r.events).toEqual([]);
      expect(r.state.cost?.totalCostUSD).toBeCloseTo(0.35284);
      expect(r.state.cost?.models['claude-sonnet-5-5']?.cacheReadInputTokens).toBe(688640);
      expect(r.state.cost?.totalLinesAdded).toBe(348);
    });

    it('records a title in state without emitting a timeline event', () => {
      // ai-title re-fires on nearly every turn, so the parser must not emit an
      // event per occurrence — the bridge publishes one only when it changes.
      const r = parseTranscriptEntry(
        { type: 'ai-title', timestamp: TS, aiTitle: 'ex5.tex template in lab5' },
        ctx,
      );
      expect(r.events).toEqual([]);
      expect(r.state.title).toBe('ex5.tex template in lab5');
    });

    it('emits a turn_end from turn_duration', () => {
      const r = parseTranscriptEntry(
        {
          type: 'system',
          subtype: 'turn_duration',
          timestamp: TS,
          uuid: 'e1',
          durationMs: 65355,
          messageCount: 57,
        },
        ctx,
      );
      const ev = only(r.events, 'turn_end');
      expect(ev.durationMs).toBe(65355);
      expect(ev.messageCount).toBe(57);
    });
  });

  describe('subagent signals', () => {
    it('reports an async agent launch with its agentId', () => {
      const r = parseTranscriptEntry(
        {
          type: 'user',
          timestamp: TS,
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c9' }] },
          toolUseResult: {
            isAsync: true,
            status: 'async_launched',
            agentId: 'afe22574158c72525',
            description: 'Check remote support',
            resolvedModel: 'claude-haiku-5-5',
          },
        },
        ctx,
      );

      expect(r.agents).toHaveLength(1);
      const sig = r.agents[0]!;
      expect(sig.kind).toBe('spawned');
      if (sig.kind === 'spawned') {
        expect(sig.agentId).toBe('afe22574158c72525');
        expect(sig.model).toBe('claude-haiku-5-5');
      }
    });

    it('reports a hand-back, which is how a subagent completion arrives', () => {
      const r = parseTranscriptEntry(
        {
          type: 'user',
          timestamp: TS,
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c10' }] },
          toolUseResult: {
            content: '<agent-message from="a82ef5db" from-name="worker">done: 3 files</agent-message>',
          },
        },
        ctx,
      );

      const sig = r.agents[0]!;
      expect(sig.kind).toBe('handback');
      if (sig.kind === 'handback') {
        expect(sig.agentId).toBe('a82ef5db');
        expect(sig.agentName).toBe('worker');
      }
    });
  });

  describe('redaction', () => {
    it('scrubs a credential before it can be published', () => {
      const r = parseTranscriptEntry(
        {
          type: 'user',
          timestamp: TS,
          origin: { kind: 'human' },
          message: { role: 'user', content: 'use sk-ant-abcdefghijklmnopqrstuvwxyz to auth' },
        },
        ctx,
      );
      const ev = only(r.events, 'user_prompt');
      expect(ev.text).not.toContain('sk-ant-');
      expect(ev.text).toContain('[redacted:');
    });
  });
});

describe('renderPatch', () => {
  it('renders multiple hunks', () => {
    const out = renderPatch([
      { oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [' context', '-old', '+new'] },
      { oldStart: 20, oldLines: 1, newStart: 20, newLines: 1, lines: ['-a', '+b'] },
    ]);
    expect(out.split('\n')).toEqual([
      '@@ -1,2 +1,2 @@',
      ' context',
      '-old',
      '+new',
      '@@ -20,1 +20,1 @@',
      '-a',
      '+b',
    ]);
  });

  it('returns empty for a missing or malformed patch', () => {
    expect(renderPatch(undefined)).toBe('');
    expect(renderPatch([])).toBe('');
    expect(renderPatch('not-an-array')).toBe('');
  });
});
