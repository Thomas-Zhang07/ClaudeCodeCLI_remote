<script setup lang="ts">
import { computed, ref } from 'vue';

import { formatDurationMs } from '@/lib/format';
import type { SubagentNode } from '@/types';

const props = defineProps<{ node: SubagentNode; depth: number }>();

// Expansion is per node, so each branch owns its own state. Children are nested
// by `children`, not by `spawnDepth` — depth is only used for the indent.
const open = ref(props.depth === 0);

const children = computed<SubagentNode[]>(() => (Array.isArray(props.node.children) ? props.node.children : []));
</script>

<template>
  <li class="node">
    <button
      class="row"
      type="button"
      :disabled="children.length === 0"
      :aria-expanded="children.length > 0 ? open : undefined"
      :class="node.status"
      @click="open = !open"
    >
      <span v-if="children.length > 0" class="caret" :class="{ open }" aria-hidden="true">›</span>
      <span v-else class="bulb" aria-hidden="true"></span>

      <span class="body">
        <span class="line1">
          <span class="type">{{ node.agentType || 'agent' }}</span>
          <span class="status">{{ node.status }}</span>
          <span v-if="node.model" class="extra">{{ node.model.replace(/^claude-/, '') }}</span>
          <!-- Only when there is one. A running agent has no duration yet, and
               `formatDurationMs` answers `—`, which is a reading rather than a
               missing one — so every running agent rendered as a row of dashes. -->
          <span v-if="node.durationMs !== undefined" class="extra">
            {{ formatDurationMs(node.durationMs) }}
          </span>
          <span v-if="children.length > 0" class="extra">{{ children.length }} spawned</span>
        </span>
        <span class="desc">{{ node.description || node.agentId }}</span>
      </span>
    </button>

    <ul v-if="open && children.length > 0" class="children">
      <SubagentBranch
        v-for="child in children"
        :key="child.agentId || child.toolUseId"
        :node="child"
        :depth="depth + 1"
      />
    </ul>
  </li>
</template>

<style scoped>
.node {
  list-style: none;
}

.row {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  width: 100%;
  min-height: var(--tap);
  padding: 5px 0 5px 4px;
  border: none;
  border-left: 2px solid var(--rule);
  background: none;
  text-align: left;
  cursor: pointer;
}

.row:disabled {
  cursor: default;
}

.row:not(:disabled):hover {
  border-left-color: var(--ink-2);
}

/* Running is the one state a reader is waiting on, so it gets the ink. */
.row.running {
  border-left-color: var(--ink);
}

.row.failed {
  border-left-color: var(--fault);
}

.caret {
  align-self: center;
  flex: none;
  font-size: 15px;
  line-height: 1;
  color: var(--ink-2);
  transition: transform 0.15s ease;
}

.caret.open {
  transform: rotate(90deg);
}

.bulb {
  align-self: center;
  flex: none;
  width: 5px;
  height: 5px;
  margin: 0 5px;
  border: 1px solid var(--rule-strong);
}

.body {
  display: flex;
  flex-direction: column;
  min-width: 0;
  padding-left: 6px;
  gap: 1px;
  flex: 1;
}

.line1 {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
  min-width: 0;
}

.type {
  font-family: var(--mono);
  font-size: 12px;
  color: var(--ink);
  overflow-wrap: anywhere;
}

.status {
  font-family: var(--mono);
  font-size: 10px;
  color: var(--ink-2);
}

.row.running .status {
  color: var(--ink);
}

.row.failed .status {
  color: var(--fault);
}

.extra {
  font-family: var(--mono);
  font-size: 10px;
  color: var(--ink-2);
  white-space: nowrap;
}

.desc {
  font-size: 13px;
  line-height: 1.5;
  color: var(--ink-2);
  overflow-wrap: anywhere;
}

/* The fork is drawn, not boxed: one hairline per level, nothing else. */
.children {
  margin: 0 0 0 12px;
  padding: 0;
  border-left: 1px solid var(--rule);
}
</style>
