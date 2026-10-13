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
  /** Share of the session's cost, for the proportion rail. */
  share: number;
  /** One step of the same ramp, darker the more it cost. */
  tone: number;
}

const rows = computed<ModelRow[]>(() => {
  const models = props.cost?.models ?? {};
  const parsed = Object.entries(models).map(([name, usage]) => ({
    name,
    short: name.replace(/^claude-/, '').replace(/-\d{8}$/, ''),
    input: usage?.inputTokens ?? 0,
    output: usage?.outputTokens ?? 0,
    cache: usage?.cacheReadInputTokens ?? 0,
    cost: usage?.costUSD ?? 0,
    share: 0,
    tone: 0,
  }));

  parsed.sort((a, b) => b.cost - a.cost);

  const total = parsed.reduce((sum, row) => sum + row.cost, 0);
  for (const [index, row] of parsed.entries()) {
    row.share = total > 0 ? row.cost / total : 0;
    // One hue, stepped down by rank: the order is already carried by the table
    // underneath, so the rail needs no hues of its own.
    row.tone = Math.max(0.2, 1 - index * 0.22);
  }
  return parsed;
});

/** A rail of one segment says nothing that the total does not. */
const showRail = computed(() => rows.value.length > 1);

const added = computed(() => props.cost?.totalLinesAdded ?? 0);
const removed = computed(() => props.cost?.totalLinesRemoved ?? 0);
</script>

<template>
  <section class="ledger">
    <header class="head">
      <h2>cost</h2>
      <span class="total">{{ formatUSD(cost?.totalCostUSD) }}</span>
    </header>

    <p v-if="!cost" class="quiet">
      This session has not reported any usage. The PC publishes cost as each turn ends.
    </p>

    <template v-else>
      <div v-if="showRail" class="rail" aria-hidden="true">
        <span
          v-for="row in rows"
          :key="row.name"
          class="share"
          :style="{ flexGrow: row.share, opacity: row.tone }"
        ></span>
      </div>

      <table v-if="rows.length > 0" class="models">
        <thead>
          <tr>
            <th scope="col">model</th>
            <th scope="col">in</th>
            <th scope="col">out</th>
            <th scope="col">cache</th>
            <th scope="col">cost</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.name">
            <td class="model" :title="row.name">{{ row.short }}</td>
            <td>{{ formatTokens(row.input) }}</td>
            <td>{{ formatTokens(row.output) }}</td>
            <td>{{ formatTokens(row.cache) }}</td>
            <td class="money">{{ formatUSD(row.cost) }}</td>
          </tr>
        </tbody>
      </table>

      <!-- Inscribed along the foot, the way a receipt totals its columns. -->
      <p class="foot">
        <span class="pair"><span class="k">api</span> {{ formatDurationMs(cost.totalAPIDurationMs) }}</span>
        <span class="pair"><span class="k">tools</span> {{ formatDurationMs(cost.totalToolDurationMs) }}</span>
        <span class="pair">
          <span class="add">+{{ added }}</span>
          <span class="del">−{{ removed }}</span>
        </span>
      </p>
    </template>
  </section>
</template>

<style scoped>
.ledger {
  margin-top: 24px;
  padding-top: 12px;
  border-top: 1px solid var(--rule-strong);
}

.head {
  display: flex;
  align-items: baseline;
  gap: 12px;
}

h2 {
  margin: 0;
  font-family: var(--mono);
  font-size: 10px;
  font-weight: 400;
  color: var(--ink-2);
}

.total {
  margin-left: auto;
  font-family: var(--mono);
  font-size: 20px;
  font-variant-numeric: tabular-nums slashed-zero;
  letter-spacing: -0.01em;
  color: var(--ink);
}

.quiet {
  margin: 6px 0 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--ink-2);
  max-width: var(--measure);
}

/* Part-to-whole, one hue stepped by rank. The table below is its legend and its
   table view, so identity is never carried by the rail alone. */
.rail {
  display: flex;
  gap: 2px;
  height: 6px;
  margin: 10px 0 0;
  border-radius: 2px;
  overflow: hidden;
}

.share {
  flex-basis: 0;
  min-width: 3px;
  background: var(--ink);
}

.models {
  width: 100%;
  margin-top: 12px;
  border-collapse: collapse;
  font-family: var(--mono);
  font-size: 11px;
  font-variant-numeric: tabular-nums slashed-zero;
}

.models th {
  padding: 0 0 5px;
  text-align: right;
  font-weight: 400;
  font-size: 10px;
  color: var(--ink-2);
}

.models th:first-child {
  text-align: left;
}

.models td {
  padding: 5px 0;
  text-align: right;
  border-top: 1px solid var(--rule);
  white-space: nowrap;
  color: var(--ink-2);
}

.models td.model {
  text-align: left;
  color: var(--ink);
  max-width: 38vw;
  overflow: hidden;
  text-overflow: ellipsis;
}

.models td.money {
  color: var(--ink);
}

.foot {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 16px;
  margin: 12px 0 0;
  padding-top: 8px;
  border-top: 1px solid var(--rule);
  font-family: var(--mono);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--ink);
}

.pair .k {
  color: var(--ink-2);
}

.add {
  color: var(--add-ink);
}

.del {
  color: var(--fault);
}
</style>
