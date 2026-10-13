<script setup lang="ts">
import { computed } from 'vue';

import { formatDurationMs, formatTokens, formatUSD } from '@/lib/format';
import type { CostState } from '@/types';

const props = defineProps<{ cost: CostState | undefined }>();

interface ModelRow {
  name: string;
  short: string;
  input: number;
  output: number;
  cache: number;
  cost: number;
}

const rows = computed<ModelRow[]>(() => {
  const models = props.cost?.models ?? {};
  return Object.entries(models)
    .map(([name, usage]) => ({
      name,
      short: name.replace(/^claude-/, '').replace(/-\d{8}$/, ''),
      input: usage?.inputTokens ?? 0,
      output: usage?.outputTokens ?? 0,
      cache: usage?.cacheReadInputTokens ?? 0,
      cost: usage?.costUSD ?? 0,
    }))
    .sort((a, b) => b.cost - a.cost);
});
</script>

<template>
  <section class="card">
    <header class="head">
      <h2>Cost</h2>
      <span class="total">{{ formatUSD(cost?.totalCostUSD) }}</span>
    </header>

    <p v-if="!cost" class="muted empty">No usage reported for this session.</p>

    <template v-else>
      <dl class="facts">
        <div>
          <dt>API time</dt>
          <dd>{{ formatDurationMs(cost.totalAPIDurationMs) }}</dd>
        </div>
        <div>
          <dt>Tool time</dt>
          <dd>{{ formatDurationMs(cost.totalToolDurationMs) }}</dd>
        </div>
        <div>
          <dt>Lines</dt>
          <dd>
            <span class="add">+{{ cost.totalLinesAdded ?? 0 }}</span>
            <span class="del"> −{{ cost.totalLinesRemoved ?? 0 }}</span>
          </dd>
        </div>
      </dl>

      <table v-if="rows.length > 0" class="models">
        <thead>
          <tr>
            <th scope="col">Model</th>
            <th scope="col">In</th>
            <th scope="col">Out</th>
            <th scope="col">Cache</th>
            <th scope="col">Cost</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.name">
            <td class="model" :title="row.name">{{ row.short }}</td>
            <td>{{ formatTokens(row.input) }}</td>
            <td>{{ formatTokens(row.output) }}</td>
            <td>{{ formatTokens(row.cache) }}</td>
            <td>{{ formatUSD(row.cost) }}</td>
          </tr>
        </tbody>
      </table>
    </template>
  </section>
</template>

<style scoped>
.head {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

h2 {
  font-size: 13px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--muted);
  margin: 0;
}

.total {
  margin-left: auto;
  font-size: 17px;
  font-weight: 600;
}

.empty {
  font-size: 13px;
  margin: 6px 0 0;
}

.facts {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  margin: 10px 0 0;
}

.facts dt {
  font-size: 11px;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.facts dd {
  margin: 2px 0 0;
  font-size: 14px;
}

.add {
  color: var(--add);
}

.del {
  color: var(--del);
}

.models {
  width: 100%;
  border-collapse: collapse;
  margin-top: 12px;
  font-size: 12px;
}

.models th {
  text-align: right;
  color: var(--muted);
  font-weight: 500;
  padding-bottom: 4px;
}

.models th:first-child {
  text-align: left;
}

.models td {
  text-align: right;
  padding: 4px 0;
  border-top: 1px solid var(--border);
  white-space: nowrap;
}

.models td.model {
  text-align: left;
  font-family: var(--mono);
  max-width: 40vw;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
