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
const running = computed(() => flatten(props.nodes).filter((node) => node.status === 'running').length);

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
  <section class="tree">
    <p class="head">
      <span class="label">agents</span>
      <span class="count">{{ total }}</span>
      <span v-if="running > 0" class="live">{{ running }} still running</span>
    </p>

    <ul class="roots">
      <SubagentBranch v-for="node in roots" :key="node.agentId || node.toolUseId" :node="node" :depth="0" />
    </ul>
  </section>
</template>

<style scoped>
.tree {
  margin-top: 24px;
  padding-top: 12px;
  border-top: 1px solid var(--rule-strong);
}

.head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 0 0 2px;
  font-family: var(--mono);
  font-size: 10px;
  color: var(--ink-2);
}

.label {
  color: var(--ink-2);
}

.count {
  color: var(--ink);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.live {
  margin-left: auto;
  color: var(--ink);
}

.roots {
  margin: 0;
  padding: 0;
}
</style>
