<script setup lang="ts">
import { computed } from 'vue';

import { useNow } from '@/lib/now';
import { isConfigured } from '@/lib/settings';
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

/**
 * Two tones, and only two. A recorder is either bringing in the record or it is
 * not; which of the several ways it is failing belongs in the sentence beside
 * the mark.
 */
const tone = computed(() => {
  if (isThrottled.value || relay.phase === 'error') return 'fault';
  if (relay.phase === 'ready') return 'ok';
  return 'neutral';
});

const detail = computed(() => {
  if (backoffMs.value > 0) return `retry in ${Math.ceil(backoffMs.value / 1000)}s`;
  if (relay.errorKind === 'throttled') return relay.error ?? 'Gitee is throttling requests.';
  if (relay.error) return relay.error;
  // `settings`, not the client: the client's fields are private and invisible to
  // reactivity, so reading them here caches the first answer forever.
  if (!isConfigured.value) return 'no relay configured';
  if (relay.empty) return 'nothing published yet';
  return 'up to date';
});
</script>

<template>
  <div class="bar" :class="tone">
    <span class="mark" aria-hidden="true"></span>
    <span class="phase">{{ phaseLabel }}</span>
    <span class="detail" :title="detail">{{ detail }}</span>
    <button class="refresh" type="button" :disabled="relay.phase === 'loading'" @click="refreshNow()">
      <span aria-hidden="true">⟳</span>
      <span class="sr-only">Refresh now</span>
    </button>
  </div>
</template>

<style scoped>
.bar {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--ink-2);
  min-width: 0;
}

/* A square, not a dot: the mark belongs to a machine register. */
.mark {
  width: 7px;
  height: 7px;
  border: 1px solid var(--ink-2);
  flex: none;
}

.bar.ok .mark {
  background: var(--ink);
  border-color: var(--ink);
}

.bar.fault .mark {
  background: var(--fault);
  border-color: var(--fault);
}

.phase {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--ink);
  white-space: nowrap;
}

.bar.fault .phase {
  color: var(--fault);
}

.detail {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bar.fault .detail {
  color: var(--fault);
}

.refresh {
  width: 40px;
  height: var(--tap);
  flex: none;
  border: none;
  background: none;
  color: var(--ink-2);
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
}

.refresh:hover:not(:disabled) {
  color: var(--ink);
}

.refresh:disabled {
  opacity: 0.4;
  cursor: default;
}
</style>
