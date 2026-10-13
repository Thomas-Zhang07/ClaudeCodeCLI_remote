<script setup lang="ts">
import { computed } from 'vue';

import { parseBlocks } from '@/lib/markdown';

const props = defineProps<{ text: string }>();

const blocks = computed(() => parseBlocks(props.text));
</script>

<template>
  <div class="md">
    <template v-for="block in blocks" :key="block.id">
      <pre v-if="block.type === 'code'" class="code"><code>{{ block.value }}</code></pre>
      <p v-else class="para">
        <!-- Rendered as text nodes: transcripts are untrusted input and are
             never inserted as markup. -->
        <template v-for="(part, index) in block.inline" :key="index">
          <code v-if="part.type === 'code'" class="inline-code">{{ part.value }}</code>
          <template v-else>{{ part.value }}</template>
        </template>
      </p>
    </template>
  </div>
</template>

<style scoped>
.md {
  min-width: 0;
}

.para {
  margin: 0;
  /* Newlines matter in a transcript. */
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.para + .para,
.para + .code,
.code + .para,
.code + .code {
  margin-top: 8px;
}

.code {
  background: var(--surface-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 8px 10px;
  line-height: 1.45;
  white-space: pre;
}

.inline-code {
  background: var(--surface-3);
  border-radius: 4px;
  padding: 1px 4px;
  overflow-wrap: anywhere;
}
</style>
