<script setup lang="ts">
import { computed } from 'vue';

import { basename, formatUSD, relativeTime } from '@/lib/format';
import { useNow } from '@/lib/now';
import { relay, sessions } from '@/stores/relay';
import type { SessionRow } from '@/stores/relay';

import StatusPill from './StatusPill.vue';

const emit = defineEmits<{ open: [sessionId: string] }>();

const now = useNow(15_000);

const hasAny = computed(() => sessions.value.length > 0);

// A row is rendered from the index alone. `row.head` is filled in only for a
// session that has been opened, and is preferred when present because it is
// strictly fresher — it costs no request either way.
function title(row: SessionRow): string {
  const fromHead = row.head?.title;
  if (fromHead) return fromHead;
  if (row.title) return row.title;
  if (row.project) return basename(row.project);
  return row.sessionId.slice(0, 8);
}

function subtitle(row: SessionRow): string {
  const project = row.head?.project ?? row.project;
  if (project) return project;
  return row.sessionId;
}

function status(row: SessionRow): SessionRow['status'] {
  return row.head?.status ?? row.status;
}

function cost(row: SessionRow): number | undefined {
  return row.head?.cost?.totalCostUSD ?? row.costUSD;
}

function updatedAt(row: SessionRow): string {
  return row.head?.updatedAt ?? row.updatedAt;
}

function controllable(row: SessionRow): boolean {
  return row.head?.controllable ?? row.controllable;
}
</script>

<template>
  <div class="list">
    <p v-if="!hasAny" class="empty card">
      <template v-if="relay.indexLoaded">No sessions are being relayed yet.</template>
      <template v-else>Loading sessions…</template>
    </p>

    <ul v-else>
      <li v-for="row in sessions" :key="row.sessionId">
        <button class="row" type="button" @click="emit('open', row.sessionId)">
          <span class="top">
            <span class="title">{{ title(row) }}</span>
            <StatusPill :status="status(row)" />
          </span>

          <span class="sub">{{ subtitle(row) }}</span>

          <span class="bottom">
            <span v-if="controllable(row)" class="control" title="This session accepts prompts">
              ● controllable
            </span>
            <span class="spacer"></span>
            <span v-if="cost(row) !== undefined" class="cost">{{ formatUSD(cost(row)) }}</span>
            <span class="time">{{ relativeTime(updatedAt(row), now) }}</span>
          </span>
        </button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.empty {
  text-align: center;
  color: var(--muted);
  font-size: 14px;
}

ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.row {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
  min-height: var(--tap);
  padding: 12px;
  text-align: left;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  cursor: pointer;
}

.row:active {
  background: var(--surface-2);
}

.top {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.title {
  font-size: 15px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.sub {
  font-size: 12px;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bottom {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--muted);
}

.control {
  color: var(--accent);
  font-size: 11px;
}

.spacer {
  flex: 1;
}

.cost {
  font-variant-numeric: tabular-nums;
}

.time {
  white-space: nowrap;
}
</style>
