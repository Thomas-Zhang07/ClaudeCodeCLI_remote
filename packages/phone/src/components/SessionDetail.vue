<script setup lang="ts">
import { computed } from 'vue';

import { basename, formatDurationMs, relativeTime } from '@/lib/format';
import { useNow } from '@/lib/now';
import { closeSession, refreshDetail, relay } from '@/stores/relay';

import CostPanel from './CostPanel.vue';
import PromptComposer from './PromptComposer.vue';
import StatusPill from './StatusPill.vue';
import SubagentTree from './SubagentTree.vue';
import Timeline from './Timeline.vue';

const props = defineProps<{ sessionId: string }>();
const emit = defineEmits<{ back: [] }>();

const now = useNow(5_000);

const detail = computed(() => (relay.detail?.sessionId === props.sessionId ? relay.detail : null));

/**
 * The head is the session's own status file; the cached copy is a fallback for
 * the moment before the first load resolves, and for after a failed one.
 */
const head = computed(() => detail.value?.head ?? relay.heads[props.sessionId] ?? null);

const title = computed(() => {
  const h = head.value;
  if (h?.title) return h.title;
  if (h?.project) return basename(h.project);
  return props.sessionId.slice(0, 8);
});

const waiting = computed(() => head.value?.status === 'waiting');
const controllable = computed(() => head.value?.controllable === true);
/**
 * Strictly true only when the PC says so. An index written before the field
 * existed, or one that failed to parse, must not be read as permission.
 */
const injectionEnabled = computed(() => relay.index?.injectionEnabled === true);

const lastEventAt = computed(() => detail.value?.summary.lastEventTs ?? null);

const errorAttention = computed(() => {
  const attention = detail.value?.summary.latestAttention;
  if (!attention || attention.level !== 'error') return null;
  return attention;
});

function goBack(): void {
  closeSession();
  emit('back');
}
</script>

<template>
  <div class="detail">
    <div class="head">
      <button class="back" type="button" @click="goBack">‹ Sessions</button>
      <button class="refresh" type="button" :disabled="detail?.loading" @click="refreshDetail()">
        {{ detail?.loading ? 'Refreshing…' : 'Refresh' }}
      </button>
    </div>

    <div class="title-row">
      <h1>{{ title }}</h1>
      <StatusPill :status="head?.status ?? 'unknown'" />
    </div>
    <p class="sub muted">
      {{ head?.project ?? props.sessionId }}
      <template v-if="head?.gitBranch"> · {{ head.gitBranch }}</template>
    </p>

    <!-- The "should I go back to my desk" signal: deliberately the loudest thing
         on the screen. -->
    <section v-if="waiting" class="attention-banner">
      <span class="attention-label">Waiting for you</span>
      <p class="attention-text">{{ head?.waitingFor || 'The session needs input.' }}</p>
    </section>

    <p v-if="errorAttention" class="banner error">
      <strong>error</strong> {{ errorAttention.text }}
      <span class="muted"> · {{ relativeTime(errorAttention.ts, now) }}</span>
    </p>

    <p v-if="detail?.resyncing" class="banner warn">
      Resyncing — a chunk could not be read cleanly. Showing everything before the break; the next
      poll will refetch it.
    </p>

    <p v-else-if="detail?.gap" class="banner error">
      Stream gap after event #{{ detail.gap.afterSeq }} ({{ detail.gap.reason }}). Later events are
      withheld rather than shown out of order.
    </p>

    <!-- Catching up after the phone was asleep: many chunks are missing at once,
         so they are fetched a few at a time rather than in one burst. Ordinary,
         and only shown while more than the newest chunk is outstanding. -->
    <p v-else-if="detail?.inFlight" class="banner neutral">
      Loading {{ detail.pendingChunks.length }} more chunks — a few at a time, so a catch-up does
      not trip the API's rate limit.
    </p>

    <!-- Retention, not damage: deliberately styled apart from a gap. -->
    <p v-if="detail?.pruned" class="banner info">
      Earlier history not retained.
      <template v-if="detail.pruned.droppedEvents > 0">
        The relay keeps a rolling window, and {{ detail.pruned.droppedEvents }} earlier event(s) have
        been dropped.
      </template>
      The stream is complete from here on.
    </p>

    <p v-if="detail?.error" class="banner error">{{ detail.error }}</p>

    <!-- Activity strip -->
    <section class="card strip">
      <div class="cell">
        <span class="label">model</span>
        <span class="value">{{ head?.model ?? detail?.summary.model ?? '—' }}</span>
      </div>
      <div class="cell">
        <span class="label">status</span>
        <span class="value">{{ head?.status ?? 'unknown' }}</span>
      </div>
      <div class="cell">
        <span class="label">last event</span>
        <span class="value">{{ lastEventAt ? relativeTime(lastEventAt, now) : '—' }}</span>
      </div>
      <div class="cell">
        <span class="label">last turn</span>
        <span class="value">
          <template v-if="detail?.summary.lastTurnEnd">
            {{ formatDurationMs(detail.summary.lastTurnEnd.durationMs) }} ·
            {{ detail.summary.lastTurnEnd.messageCount }} msg
          </template>
          <template v-else>—</template>
        </span>
      </div>
      <div class="cell">
        <span class="label">chunks</span>
        <span class="value">
          {{ detail?.chunksLoaded ?? 0 }}<template v-if="(detail?.chunksTotal ?? 0) > 0">/{{ detail?.chunksTotal }}</template>
          <template v-if="(detail?.pendingChunks.length ?? 0) > 0">
            · {{ detail?.pendingChunks.length }} pending
          </template>
        </span>
      </div>
      <div class="cell">
        <span class="label">events</span>
        <span class="value">{{ detail?.events.length ?? 0 }}</span>
      </div>
    </section>

    <Timeline
      v-if="detail"
      :events="detail.events"
      :now="now"
      :gaps-after-seq="detail.gap ? detail.gap.afterSeq : null"
    />

    <SubagentTree v-if="detail && detail.subagents.length > 0" :nodes="detail.subagents" />

    <CostPanel :cost="head?.cost" />

    <PromptComposer
      :session-id="props.sessionId"
      :controllable="controllable"
      :injection-enabled="injectionEnabled"
    />
  </div>
</template>

<style scoped>
.detail {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}

.head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.back,
.refresh {
  min-height: var(--tap);
  padding: 8px 14px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: var(--surface);
  cursor: pointer;
  font-size: 14px;
}

.refresh {
  margin-left: auto;
}

.title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

h1 {
  font-size: 19px;
  margin: 0;
  overflow-wrap: anywhere;
}

.sub {
  margin: -6px 0 0;
  font-size: 12px;
  overflow-wrap: anywhere;
}

.attention-banner {
  border-radius: var(--radius);
  padding: 14px;
  border: 1px solid var(--wait);
  background: color-mix(in srgb, var(--wait) 18%, var(--surface));
}

.attention-label {
  display: inline-block;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--wait);
  font-weight: 700;
}

.attention-text {
  margin: 4px 0 0;
  font-size: 16px;
  font-weight: 600;
  overflow-wrap: anywhere;
}

.banner {
  margin: 0;
  font-size: 13px;
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  overflow-wrap: anywhere;
}

.banner.warn {
  border: 1px solid color-mix(in srgb, var(--wait) 45%, var(--border));
  color: var(--wait);
  background: color-mix(in srgb, var(--wait) 10%, transparent);
}

.banner.error {
  border: 1px solid color-mix(in srgb, var(--danger) 45%, var(--border));
  color: var(--danger);
  background: color-mix(in srgb, var(--danger) 10%, transparent);
}

/* Not a warning: something is still in flight, and it will resolve itself. */
.banner.neutral {
  border: 1px solid var(--border);
  color: var(--muted);
  background: var(--surface-2);
}

/* Retention, which is a plain fact rather than a fault — kept visually distinct
   from the red of a sequence gap. */
.banner.info {
  border: 1px solid color-mix(in srgb, var(--info) 40%, var(--border));
  color: var(--info);
  background: color-mix(in srgb, var(--info) 10%, transparent);
}

.strip {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px 12px;
  padding: 12px;
}

@media (min-width: 480px) {
  .strip {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

.cell {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.label {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--muted);
}

.value {
  font-size: 13px;
  overflow-wrap: anywhere;
}
</style>
