<script setup lang="ts">
import { computed } from 'vue';

import { gitee } from '@/lib/gitee';
import { useNow } from '@/lib/now';
import { refreshNow, relay, throttledForMs } from '@/stores/relay';

const now = useNow(1000);

const backoffMs = computed(() => throttledForMs(now.value));

/**
 * Sticky while the last failure was a throttle: the backoff window can elapse
 * between polls, and reporting "offline" for a rate limit sends the user
 * hunting for a network problem that is not there.
 */
const isThrottled = computed(() => backoffMs.value > 0 || relay.errorKind === 'throttled');

const phaseLabel = computed(() => {
  if (isThrottled.value) return 'throttled';
  switch (relay.phase) {
    case 'loading':
      return 'loading';
    case 'error':
      return 'offline';
    case 'ready':
      return 'live';
    default:
      return 'idle';
  }
});

const tone = computed(() => {
  if (isThrottled.value) return 'warn';
  if (relay.phase === 'error') return 'error';
  if (relay.phase === 'ready') return 'ok';
  return 'muted';
});

const detail = computed(() => {
  if (backoffMs.value > 0) return `retry in ${Math.ceil(backoffMs.value / 1000)}s`;
  if (relay.errorKind === 'throttled') return relay.error ?? 'Gitee is throttling requests.';
  if (relay.error) return relay.error;
  if (!gitee.configured) return 'not configured';
  if (relay.empty) return 'no relay data yet';
  return 'up to date';
});
</script>

<template>
  <div class="bar" :class="tone">
    <span class="dot"></span>
    <span class="phase">{{ phaseLabel }}</span>
    <span class="detail">{{ detail }}</span>
    <button class="refresh" type="button" :disabled="relay.phase === 'loading'" @click="refreshNow()">
      ⟳
      <span class="sr-only">Refresh now</span>
    </button>
  </div>
</template>

<style scoped>
.bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
  font-size: 12px;
  color: var(--muted);
  position: sticky;
  top: 0;
  z-index: 10;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--muted);
  flex: none;
}

.bar.ok .dot {
  background: var(--accent);
}

.bar.warn .dot {
  background: var(--wait);
}

.bar.error .dot {
  background: var(--danger);
}

.phase {
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-size: 10px;
}

.detail {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.refresh {
  width: var(--tap);
  height: 32px;
  border: none;
  background: none;
  color: var(--muted);
  font-size: 16px;
  cursor: pointer;
}

.bar.warn .detail {
  color: var(--wait);
}

.bar.error .detail {
  color: var(--danger);
}

:deep(.sr-only),
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
}
</style>
