<script setup lang="ts">
import { computed, ref } from 'vue';

import { basename } from '@/lib/format';
import type { EditEvent } from '@/types';

const props = defineProps<{ event: EditEvent }>();

// Collapsed by default: a diff is a lot of vertical space on a phone.
const open = ref(false);

interface DiffLine {
  kind: 'add' | 'del' | 'meta' | 'context';
  text: string;
  key: number;
}

const lines = computed<DiffLine[]>(() => {
  const patch = props.event.patch;
  if (!patch) return [];
  return patch.split('\n').map((text, key) => {
    let kind: DiffLine['kind'] = 'context';
    if (text.startsWith('@@')) kind = 'meta';
    else if (text.startsWith('+++') || text.startsWith('---')) kind = 'meta';
    else if (text.startsWith('+')) kind = 'add';
    else if (text.startsWith('-')) kind = 'del';
    return { kind, text, key };
  });
});

const hasDiff = computed(() => lines.value.length > 0);

const fileLabel = computed(() => basename(props.event.filePath));
const dirLabel = computed(() => {
  const parts = props.event.filePath.split('/').filter(Boolean);
  parts.pop();
  return parts.length > 0 ? `${parts.join('/')}/` : '';
});
</script>

<template>
  <div class="edit card">
    <button class="head" type="button" :aria-expanded="open" @click="open = !open">
      <span class="chevron" :class="{ open }">›</span>
      <span class="paths">
        <span class="file">{{ fileLabel }}</span>
        <span v-if="dirLabel" class="dir">{{ dirLabel }}</span>
      </span>
      <span class="stats">
        <span v-if="event.created" class="badge new">new file</span>
        <span class="tool">{{ event.tool }}</span>
        <span v-if="event.added" class="add">+{{ event.added }}</span>
        <span v-if="event.removed" class="del">−{{ event.removed }}</span>
      </span>
    </button>

    <div v-if="open" class="body">
      <p v-if="!hasDiff" class="muted small">
        No diff was published for this edit (whole-file write, or truncated at the source).
      </p>
      <pre v-else class="diff"><code><span
            v-for="line in lines"
            :key="line.key"
            class="line"
            :class="line.kind"
          >{{ line.text }}</span></code></pre>
    </div>
  </div>
</template>

<style scoped>
.edit {
  padding: 0;
  overflow: hidden;
}

.head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: var(--tap);
  padding: 8px 10px;
  background: none;
  border: none;
  text-align: left;
  cursor: pointer;
}

.head:active {
  background: var(--surface-2);
}

.chevron {
  display: inline-block;
  color: var(--muted);
  transition: transform 0.15s ease;
  font-size: 20px;
  line-height: 1;
}

.chevron.open {
  transform: rotate(90deg);
}

.paths {
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.file {
  font-family: var(--mono);
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 52vw;
}

.dir {
  color: var(--muted);
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 52vw;
}

.stats {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  white-space: nowrap;
}

.tool {
  color: var(--muted);
}

.badge {
  border-radius: 999px;
  padding: 1px 6px;
  font-size: 11px;
  border: 1px solid var(--border);
}

.badge.new {
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
}

.add {
  color: var(--add);
}

.del {
  color: var(--del);
}

.body {
  border-top: 1px solid var(--border);
  padding: 8px 10px 10px;
}

.small {
  font-size: 13px;
  margin: 0;
}

.diff {
  max-height: 45vh;
  overflow: auto;
  font-size: 12px;
  line-height: 1.5;
}

.line {
  display: block;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.line.add {
  color: var(--add);
  background: color-mix(in srgb, var(--add) 10%, transparent);
}

.line.del {
  color: var(--del);
  background: color-mix(in srgb, var(--del) 10%, transparent);
}

.line.meta {
  color: var(--muted);
}

.line.context {
  color: var(--text);
  opacity: 0.75;
}
</style>
