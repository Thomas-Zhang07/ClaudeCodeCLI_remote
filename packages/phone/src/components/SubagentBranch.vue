<script setup lang="ts">
import { computed, ref } from 'vue';

import { formatDurationMs } from '@/lib/format';
import type { SubagentNode } from '@/types';

const props = defineProps<{ node: SubagentNode; depth: number }>();

// Expansion is per node, so each branch owns its own state. Children are nested
// by `children`, not by `spawnDepth` — depth is only used for the indent.
const open = ref(props.depth === 0);

const children = computed<SubagentNode[]>(() => (Array.isArray(props.node.children) ? props.node.children : []));
const statusClass = computed(() => props.node.status);
</script>

<template>
  <li class="node">
    <button
      class="row"
      type="button"
      :disabled="children.length === 0"
      :aria-expanded="open"
      @click="open = !open"
    >
      <span v-if="children.length > 0" class="chevron" :class="{ open }">›</span>
      <span v-else class="dot">•</span>

      <span class="body">
        <span class="line1">
          <span class="type">{{ node.agentType || 'agent' }}</span>
          <span class="status" :class="statusClass">{{ node.status }}</span>
          <span v-if="node.model" class="model">{{ node.model }}</span>
          <span class="duration">{{ formatDurationMs(node.durationMs) }}</span>
        </span>
        <span class="desc">{{ node.description || node.agentId }}</span>
      </span>

      <span v-if="children.length > 0" class="count">{{ children.length }}</span>
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
  padding: 6px 8px;
  background: none;
  border: none;
  text-align: left;
  cursor: pointer;
}

.row:disabled {
  cursor: default;
  opacity: 1;
}

.row:active:not(:disabled) {
  background: var(--surface-2);
}

.chevron {
  color: var(--muted);
  font-size: 18px;
  line-height: 22px;
  transition: transform 0.15s ease;
}

.chevron.open {
  transform: rotate(90deg);
}

.dot {
  color: var(--border);
  line-height: 22px;
}

.body {
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.line1 {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.type {
  font-family: var(--mono);
  font-size: 12px;
}

.status {
  font-size: 11px;
  border-radius: 999px;
  padding: 0 6px;
  border: 1px solid var(--border);
  color: var(--muted);
}

.status.running {
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
}

.status.failed {
  color: var(--danger);
  border-color: color-mix(in srgb, var(--danger) 45%, var(--border));
}

.model,
.duration {
  font-size: 11px;
  color: var(--muted);
}

.desc {
  font-size: 13px;
  color: var(--text);
  overflow-wrap: anywhere;
}

.count {
  margin-left: auto;
  font-size: 11px;
  color: var(--muted);
}

.children {
  margin: 0;
  padding: 0 0 0 14px;
  border-left: 1px solid var(--border);
  margin-left: 14px;
}
</style>
