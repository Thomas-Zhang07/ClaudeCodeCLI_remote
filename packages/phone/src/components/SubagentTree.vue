<script setup lang="ts">
import { computed } from 'vue';

import type { SubagentNode } from '@/types';

import SubagentBranch from './SubagentBranch.vue';

const props = defineProps<{ nodes: SubagentNode[] }>();

/**
 * Roots are the nodes nothing claims as a child. The published file is already a
 * forest, but a node whose `children` were dropped (truncation, an older bridge)
 * is recovered from `parentAgentId` rather than silently disappearing.
 */
const roots = computed<SubagentNode[]>(() => {
  const all = flatten(props.nodes);
  if (all.length === 0) return props.nodes;

  const childIds = new Set<string>();
  for (const node of all) {
    for (const child of node.children ?? []) {
      if (child?.agentId) childIds.add(child.agentId);
    }
  }

  return all.filter((node) => !node.parentAgentId || !childIds.has(node.agentId));
});

const total = computed(() => flatten(props.nodes).length);

function flatten(nodes: readonly SubagentNode[]): SubagentNode[] {
  const out: SubagentNode[] = [];
  const walk = (list: readonly SubagentNode[]): void => {
    for (const node of list) {
      if (!node || typeof node !== 'object') continue;
      out.push(node);
      if (Array.isArray(node.children)) walk(node.children);
    }
  };
  walk(nodes);
  return out;
}
</script>

<template>
  <section class="card tree">
    <header class="head">
      <h2>Agents</h2>
      <span class="muted count">{{ total }}</span>
    </header>
    <p v-if="total === 0" class="muted empty">No subagents in this session.</p>
    <ul v-else class="roots">
      <SubagentBranch v-for="node in roots" :key="node.agentId || node.toolUseId" :node="node" :depth="0" />
    </ul>
  </section>
</template>

<style scoped>
.tree {
  padding: 10px 8px;
}

.head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 0 4px 4px;
}

h2 {
  font-size: 13px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--muted);
  margin: 0;
}

.count {
  font-size: 12px;
}

.empty {
  font-size: 13px;
  margin: 4px;
}

.roots {
  margin: 0;
  padding: 0;
}
</style>
