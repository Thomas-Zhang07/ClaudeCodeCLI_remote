<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import { formatDurationMs, relativeTime } from '@/lib/format';
import type { NormalizedEvent } from '@/types';

import EditCard from './EditCard.vue';
import MarkdownText from './MarkdownText.vue';

const props = defineProps<{ events: NormalizedEvent[]; now: number; gapsAfterSeq: number | null }>();

const PAGE = 150;

const showSubagentActivity = ref(false);
const limit = ref(PAGE);

const visibleEvents = computed<NormalizedEvent[]>(() =>
  showSubagentActivity.value
    ? props.events
    : props.events.filter((event) => event.agentId === null),
);

const slice = computed(() => visibleEvents.value.slice(-limit.value));
const hiddenCount = computed(() => Math.max(0, visibleEvents.value.length - slice.value.length));

// A new event should not yank the reading position, but switching sessions must
// start at the newest end.
watch(
  () => props.events.length,
  (next, previous) => {
    if (next < previous) limit.value = PAGE;
  },
);

function agentLabel(agentId: string | null): string {
  if (!agentId) return 'main';
  return agentId.slice(0, 6);
}
</script>

<template>
  <section class="timeline">
    <div class="controls">
      <button class="toggle" type="button" :aria-pressed="showSubagentActivity" @click="showSubagentActivity = !showSubagentActivity">
        {{ showSubagentActivity ? 'Hide agent activity' : 'Show agent activity' }}
      </button>
    </div>

    <p v-if="visibleEvents.length === 0" class="muted empty">
      {{
        events.length === 0
          ? 'No events yet. The PC publishes a chunk once it is sealed.'
          : 'Nothing on the main thread yet — try showing agent activity.'
      }}
    </p>

    <button v-if="hiddenCount > 0" class="more" type="button" @click="limit += PAGE">
      Show {{ Math.min(PAGE, hiddenCount) }} older ({{ hiddenCount }} hidden)
    </button>

    <ol class="list">
      <li v-for="event in slice" :key="`${event.agentId ?? 'main'}-${event.seq}`" class="item" :class="event.kind">
        <!-- User prompt: the phone's own side of the conversation, set apart. -->
        <div v-if="event.kind === 'user_prompt'" class="bubble user">
          <div class="bubble-meta">
            <span v-if="event.injected" class="tag">sent from phone</span>
            <span class="time">{{ relativeTime(event.ts, now) }}</span>
          </div>
          <MarkdownText :text="event.text" />
        </div>

        <!-- Assistant prose. -->
        <div v-else-if="event.kind === 'assistant_text'" class="bubble assistant">
          <div class="bubble-meta">
            <span v-if="event.agentId" class="tag agent">{{ agentLabel(event.agentId) }}</span>
            <span class="time">{{ relativeTime(event.ts, now) }}</span>
          </div>
          <MarkdownText :text="event.text" />
        </div>

        <EditCard v-else-if="event.kind === 'edit'" :event="event" />

        <div v-else-if="event.kind === 'turn_end'" class="divider">
          <span>turn done · {{ formatDurationMs(event.durationMs) }} · {{ event.messageCount }} messages</span>
        </div>

        <div v-else-if="event.kind === 'turn_start'" class="divider subtle">
          <span>turn started</span>
        </div>

        <div v-else-if="event.kind === 'attention'" class="chip" :class="`attention-${event.level}`">
          <strong>{{ event.level }}</strong>
          <span>{{ event.text }}</span>
          <span class="time">{{ relativeTime(event.ts, now) }}</span>
        </div>

        <div v-else-if="event.kind === 'injection'" class="chip" :class="`injection-${event.state}`">
          <strong>{{ event.state }}</strong>
          <span class="mono">{{ event.promptId.slice(0, 8) }}</span>
          <span v-if="event.detail">{{ event.detail }}</span>
        </div>

        <div v-else-if="event.kind === 'subagent_start'" class="chip subtle">
          <strong>spawned</strong>
          <span>{{ event.agentType }} — {{ event.description }}</span>
        </div>

        <div v-else-if="event.kind === 'subagent_stop'" class="chip subtle">
          <strong>{{ event.status }}</strong>
          <span class="mono">{{ agentLabel(event.agentId) }}</span>
          <span v-if="event.durationMs">{{ formatDurationMs(event.durationMs) }}</span>
        </div>

        <div v-else-if="event.kind === 'title'" class="divider subtle">
          <span>titled “{{ event.title }}” ({{ event.source }})</span>
        </div>

        <div v-if="gapsAfterSeq !== null && event.seq === gapsAfterSeq" class="gap">
          <span>⚠ stream gap after #{{ gapsAfterSeq }} — events may be missing</span>
        </div>
      </li>
    </ol>
  </section>
</template>

<style scoped>
.timeline {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.controls {
  display: flex;
  justify-content: flex-end;
}

.toggle {
  min-height: var(--tap);
  background: none;
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 6px 14px;
  font-size: 13px;
  color: var(--muted);
  cursor: pointer;
}

.more {
  min-height: var(--tap);
  background: var(--surface-2);
  border: 1px dashed var(--border);
  border-radius: var(--radius-sm);
  color: var(--muted);
  font-size: 13px;
  cursor: pointer;
}

.empty {
  font-size: 13px;
  padding: 12px 4px;
}

.list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}

.item {
  min-width: 0;
}

.bubble {
  border-radius: var(--radius);
  padding: 10px 12px;
  max-width: 94%;
  min-width: 0;
}

.bubble.user {
  margin-left: auto;
  background: color-mix(in srgb, var(--info) 14%, var(--surface));
  border: 1px solid color-mix(in srgb, var(--info) 35%, var(--border));
}

.bubble.assistant {
  background: var(--surface);
  border: 1px solid var(--border);
}

.bubble-meta {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 4px;
}

.tag {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--info);
}

.tag.agent {
  color: var(--muted);
  font-family: var(--mono);
}

.time {
  font-size: 11px;
  color: var(--muted);
  margin-left: auto;
  white-space: nowrap;
}

.divider {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--muted);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  padding: 2px 4px;
}

.divider::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--border);
}

.divider.subtle {
  opacity: 0.7;
}

.chip {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: baseline;
  font-size: 13px;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: var(--surface-2);
  overflow-wrap: anywhere;
}

.chip.subtle {
  color: var(--muted);
}

.chip strong {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.attention-waiting {
  border-color: color-mix(in srgb, var(--wait) 45%, var(--border));
  color: var(--wait);
}

.attention-error {
  border-color: color-mix(in srgb, var(--danger) 45%, var(--border));
  color: var(--danger);
}

.injection-delivered {
  border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
  color: var(--accent);
}

.injection-dropped,
.injection-rejected {
  border-color: color-mix(in srgb, var(--danger) 45%, var(--border));
  color: var(--danger);
}

.mono {
  font-family: var(--mono);
  font-size: 12px;
}

.gap {
  margin: 6px 0;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  border: 1px dashed color-mix(in srgb, var(--danger) 55%, var(--border));
  color: var(--danger);
  font-size: 13px;
}
</style>
