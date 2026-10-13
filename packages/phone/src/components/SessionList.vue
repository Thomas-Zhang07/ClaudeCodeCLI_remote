<script setup lang="ts">
import { computed } from 'vue';

import { basename, formatUSD, relativeTime } from '@/lib/format';
import { useNow } from '@/lib/now';
import { relay, sessions } from '@/stores/relay';
import type { SessionRow } from '@/stores/relay';

import StatusMark from './StatusMark.vue';

const emit = defineEmits<{ open: [sessionId: string] }>();

const now = useNow(15_000);

const hasAny = computed(() => sessions.value.length > 0);

/** The only thing on this screen that ever needs a person. */
const waiting = computed(() => sessions.value.filter((row) => status(row) === 'waiting'));

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
  // The last path segment carries the identity; the rest is a directory the
  // reader already knows they are in.
  const directory = project ? basename(project) : null;
  // An untitled session falls back to its directory, which must not then be
  // printed twice in the same row.
  if (directory && directory !== title(row)) return directory;
  return row.sessionId.slice(0, 8);
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
</script>

<template>
  <div class="list">
    <!-- Waiting is the one state worth interrupting the list for, and a session
         that has been waiting a while is not necessarily near the top. -->
    <!-- Not `.waiting`: a scoped class also lands on a child component's root
         element, and `StatusMark` already publishes `waiting` as a state. -->
    <section v-if="waiting.length > 0" class="needs-you">
      <p class="needs-you-head">waiting on you</p>
      <ul>
        <li v-for="row in waiting" :key="row.sessionId">
          <button type="button" @click="emit('open', row.sessionId)">{{ title(row) }}</button>
        </li>
      </ul>
    </section>

    <p v-if="!hasAny" class="empty">
      <template v-if="!relay.indexLoaded">Reading the relay…</template>
      <template v-else-if="relay.phase === 'error'">
        The relay could not be read, so there is nothing to list.
        {{ relay.error ?? 'The last request failed.' }}
      </template>
      <template v-else>
        Nothing is being relayed yet. Start a session on the PC with <code>ccr</code>, then refresh.
      </template>
    </p>

    <template v-else>
      <p class="tally">
        <span>{{ sessions.length }} session{{ sessions.length === 1 ? '' : 's' }}</span>
      </p>

      <ul class="rows">
        <li v-for="row in sessions" :key="row.sessionId">
          <button class="entry" type="button" @click="emit('open', row.sessionId)">
            <StatusMark class="state" :status="status(row)" />
            <span class="title">{{ title(row) }}</span>
            <span class="age">{{ relativeTime(updatedAt(row), now) }}</span>
            <span class="where">{{ subtitle(row) }}</span>
            <span class="cost mono">{{ cost(row) !== undefined ? formatUSD(cost(row)) : '' }}</span>
          </button>
        </li>
      </ul>
    </template>
  </div>
</template>

<style scoped>
.list {
  display: flex;
  flex-direction: column;
}

/* --- waiting band --------------------------------------------------------- */

.needs-you {
  margin: 12px 0 4px;
  padding: 10px 12px 12px;
  background: var(--plate);
  border-left: 3px solid var(--signal);
}

.needs-you-head {
  margin: 0;
  font-family: var(--mono);
  font-size: 11px;
  font-weight: 600;
  color: var(--signal);
}

.needs-you ul {
  list-style: none;
  margin: 4px 0 0;
  padding: 0;
}

.needs-you button {
  display: block;
  width: 100%;
  min-height: 44px;
  padding: 4px 0;
  border: none;
  background: none;
  text-align: left;
  font-size: 16px;
  color: var(--ink);
  cursor: pointer;
  overflow-wrap: anywhere;
}

.waiting button:hover {
  text-decoration: underline;
  text-underline-offset: 3px;
}

/* --- the roll ------------------------------------------------------------- */

.tally {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 14px 0 0;
  font-family: var(--mono);
  font-size: 10px;
  color: var(--ink-2);
}

.tally::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--rule);
}

.rows {
  list-style: none;
  margin: 0;
  padding: 0;
}

.rows > li + li {
  border-top: 1px solid var(--rule);
}

/* No card: a row on ruled stock. The numerals stack into two clean columns on
   the right so a scan down the list is one straight edge. */
.entry {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: baseline;
  column-gap: 10px;
  width: 100%;
  min-height: var(--tap);
  padding: 11px 8px 12px;
  border: none;
  background: none;
  text-align: left;
  cursor: pointer;
}

.entry:hover,
.entry:active {
  background: var(--plate);
}

.state {
  grid-row: 1;
  grid-column: 1;
}

.title {
  grid-row: 1;
  grid-column: 2;
  font-size: 16px;
  line-height: 1.35;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.age {
  grid-row: 1;
  grid-column: 3;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--ink-2);
  white-space: nowrap;
}

.where {
  grid-row: 2;
  grid-column: 2;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--ink-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cost {
  grid-row: 2;
  grid-column: 3;
  font-size: 12px;
  color: var(--ink-2);
  text-align: right;
  white-space: nowrap;
}

.empty {
  margin: 16px 0 0;
  font-size: 14px;
  color: var(--ink-2);
  max-width: var(--measure);
}

.empty code {
  color: var(--ink);
}

@media (min-width: 480px) {
  .title {
    font-size: 17px;
  }
}
</style>
