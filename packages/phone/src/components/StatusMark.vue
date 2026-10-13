<script setup lang="ts">
import { computed } from 'vue';

import type { SessionStatus } from '@/types';

/**
 * A session's state as a mark and a word.
 *
 * The shape carries the state on its own — filled, hollow, or struck — so the
 * one hue that means "a person is needed" is never the only thing saying so.
 */
const props = defineProps<{ status: SessionStatus | 'unknown'; compact?: boolean }>();

const label = computed(() => {
  switch (props.status) {
    case 'active':
      return 'active';
    case 'waiting':
      return 'waiting';
    case 'idle':
      return 'idle';
    case 'ended':
      return 'ended';
    default:
      return 'unknown';
  }
});
</script>

<template>
  <span class="mark" :class="[status, { compact }]">
    <span class="glyph" aria-hidden="true"></span>
    <span class="word">{{ label }}</span>
  </span>
</template>

<style scoped>
.mark {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  white-space: nowrap;
  font-family: var(--mono);
  font-size: 11px;
  line-height: 1.2;
  color: var(--ink-2);
}

.glyph {
  width: 7px;
  height: 7px;
  border: 1px solid currentColor;
  flex: none;
}

/* Working: solid. */
.active {
  color: var(--ink);
}

.active .glyph {
  background: currentColor;
}

/* Needs a person: the one reserved hue, and a solid mark inside a louder
   outline so it survives the accent being indistinguishable from ink. */
.waiting {
  color: var(--signal);
  font-weight: 600;
}

/* The loudest mark on the page: bigger as well as warmer. */
.waiting .glyph {
  background: var(--signal);
  border-color: var(--signal);
  width: 9px;
  height: 9px;
}

/* Alive but not working: hollow. */
.idle {
  color: var(--ink-2);
}

/* Finished: struck through, the proofreader's mark for "closed". */
.ended .glyph {
  border: none;
  border-top: 1px solid currentColor;
  height: 1px;
  width: 9px;
  align-self: center;
}

.ended {
  color: var(--ink-2);
  opacity: 0.8;
}

.unknown {
  opacity: 0.7;
}

.compact .word {
  font-size: 10px;
}
</style>
