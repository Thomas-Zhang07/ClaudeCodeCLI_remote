/**
 * The synthesized/transcript split.
 *
 * Small, but load-bearing: this predicate is what the injection guard uses to
 * decide what the session's main thread last *did*. Getting it wrong is not a
 * display bug — it wedged sessions shut.
 */

import { describe, expect, it } from 'vitest';

import { SYNTHESIZED_KINDS, isTranscriptEvent, type EventKind } from '../src/types.js';

/** Every kind in the union, spelled out so a new one cannot be forgotten. */
const ALL_KINDS: EventKind[] = [
  'user_prompt',
  'assistant_text',
  'edit',
  'subagent_start',
  'subagent_stop',
  'turn_start',
  'turn_end',
  'title',
  'attention',
  'injection',
];

describe('isTranscriptEvent', () => {
  it('is false for exactly the kinds the bridge synthesizes', () => {
    const synthesized = ALL_KINDS.filter((kind) => !isTranscriptEvent(kind)).sort();
    expect(synthesized).toEqual([...SYNTHESIZED_KINDS].sort());
  });

  it('agrees with the set on every kind', () => {
    for (const kind of ALL_KINDS) {
      expect(isTranscriptEvent(kind)).toBe(!SYNTHESIZED_KINDS.has(kind));
    }
  });

  it('treats the three events the bridge writes about itself as not activity', () => {
    // `title` arrives between turns; `attention` is a note the bridge makes;
    // `injection` is the record of a prompt's fate — and recording a refusal is
    // itself an injection event, which is what made the lockout permanent.
    expect(isTranscriptEvent('title')).toBe(false);
    expect(isTranscriptEvent('attention')).toBe(false);
    expect(isTranscriptEvent('injection')).toBe(false);
  });

  it('treats real transcript activity as activity', () => {
    // The opposite error is the dangerous one: wrongly ignoring real activity
    // could let a prompt be typed mid-turn, into a permission dialog.
    expect(isTranscriptEvent('turn_end')).toBe(true);
    expect(isTranscriptEvent('user_prompt')).toBe(true);
    expect(isTranscriptEvent('assistant_text')).toBe(true);
    expect(isTranscriptEvent('edit')).toBe(true);
    expect(isTranscriptEvent('turn_start')).toBe(true);
  });

  it('treats an unrecognised kind as real activity', () => {
    // A denylist on purpose: a new kind from a newer Claude Code makes the
    // guard more reluctant, never less.
    expect(isTranscriptEvent('something_new' as EventKind)).toBe(true);
  });
});
