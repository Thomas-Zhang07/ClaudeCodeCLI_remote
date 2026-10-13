<script setup lang="ts">
import { computed } from 'vue';

import type { SessionStatus } from '@/types';

const props = defineProps<{ status: SessionStatus | 'unknown' }>();

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
  <span class="pill" :class="status">{{ label }}</span>
</template>

<style scoped>
.pill {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.02em;
  border: 1px solid var(--border);
  background: var(--surface-2);
  color: var(--muted);
  white-space: nowrap;
}

.pill.active {
  border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 12%, var(--surface-2));
}

.pill.waiting {
  border-color: color-mix(in srgb, var(--wait) 55%, var(--border));
  color: var(--wait);
  background: color-mix(in srgb, var(--wait) 16%, var(--surface-2));
}

.pill.ended {
  opacity: 0.75;
}
</style>
