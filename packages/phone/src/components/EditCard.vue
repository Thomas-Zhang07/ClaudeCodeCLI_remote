<script setup lang="ts">
import { computed, ref } from 'vue';

import { basename } from '@/lib/format';
import type { EditEvent } from '@/types';

const props = defineProps<{ event: EditEvent }>();

// Collapsed by default: a diff is a lot of vertical space on a phone.
const open = ref(false);

interface DiffLine {
  kind: 'add' | 'del' | 'meta' | 'context';
  /** The proofreader's mark in the margin — the diff's primary channel. */
  mark: string;
  text: string;
  key: number;
}

const lines = computed<DiffLine[]>(() => {
  const patch = props.event.patch;
  if (!patch) return [];
  return patch.split('\n').map((raw, key) => {
    let kind: DiffLine['kind'] = 'context';
    // A leading `+`/`-` on a `+++`/`---` header is a filename, not a change.
    if (raw.startsWith('@@') || raw.startsWith('+++') || raw.startsWith('---')) kind = 'meta';
    else if (raw.startsWith('+')) kind = 'add';
    else if (raw.startsWith('-')) kind = 'del';
    const marked = kind === 'add' || kind === 'del';
    return {
      kind,
      mark: kind === 'add' ? '+' : kind === 'del' ? '−' : ' ',
      text: marked ? raw.slice(1) : raw,
      key,
    };
  });
});

const hasDiff = computed(() => lines.value.length > 0);

const fileLabel = computed(() => basename(props.event.filePath));
const dirLabel = computed(() => {
  const parts = props.event.filePath.split('/').filter(Boolean);
  parts.pop();
  return parts.length > 0 ? `${parts.join('/')}/` : '';
});

/**
 * Only the tools that change the shape of the file get a word. A plain `Edit`
 * is the default and says nothing.
 */
const toolNote = computed(() => {
  if (props.event.created) return 'new file';
  if (props.event.tool === 'Edit') return null;
  return props.event.tool === 'NotebookEdit' ? 'notebook' : 'whole file';
});

const addedLabel = computed(() => (props.event.added ? `+${props.event.added}` : null));
const removedLabel = computed(() => (props.event.removed ? `−${props.event.removed}` : null));
</script>

<template>
  <div class="edit">
    <button class="head" type="button" :aria-expanded="open" @click="open = !open">
      <span class="caret" :class="{ open }" aria-hidden="true">›</span>

      <span class="paths">
        <span class="file">{{ fileLabel }}</span>
        <span v-if="dirLabel" class="dir">{{ dirLabel }}</span>
      </span>

      <span v-if="toolNote" class="note">{{ toolNote }}</span>

      <span class="counts">
        <span v-if="addedLabel" class="count add">{{ addedLabel }}</span>
        <span v-if="removedLabel" class="count del">{{ removedLabel }}</span>
      </span>
    </button>

    <div v-if="open" class="body">
      <p v-if="!hasDiff" class="quiet">
        No diff was published for this edit. That happens on a whole-file write, or when the patch
        was cut at the source.
      </p>
      <pre v-else class="diff"><code><span
            v-for="line in lines"
            :key="line.key"
            class="line"
            :class="line.kind"
          ><span class="mark" aria-hidden="true">{{ line.mark }}</span>{{ line.text }}</span></code></pre>
    </div>
  </div>
</template>

<style scoped>
.edit {
  max-width: var(--measure);
}

.head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  width: 100%;
  min-height: var(--tap);
  padding: 4px 0;
  background: none;
  border: none;
  text-align: left;
  cursor: pointer;
}

.caret {
  align-self: center;
  flex: none;
  font-size: 16px;
  line-height: 1;
  color: var(--ink-2);
  transition: transform 0.15s ease;
}

.caret.open {
  transform: rotate(90deg);
}

.paths {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0 6px;
  min-width: 0;
}

.file {
  font-family: var(--mono);
  font-size: 13px;
  color: var(--ink);
  overflow-wrap: anywhere;
}

.dir {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--ink-2);
  overflow-wrap: anywhere;
}

.note {
  font-family: var(--mono);
  font-size: 10px;
  color: var(--ink-2);
  white-space: nowrap;
}

.counts {
  margin-left: auto;
  display: flex;
  gap: 8px;
  flex: none;
  font-family: var(--mono);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.count.add {
  color: var(--add-ink);
}

.count.del {
  color: var(--fault);
}

.body {
  margin-top: 2px;
  border-left: 2px solid var(--rule);
  padding-left: 8px;
}

.quiet {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--ink-2);
}

.diff {
  max-height: 46vh;
  overflow: auto;
  font-size: 12px;
  line-height: 1.55;
}

.line {
  display: block;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--ink-2);
}

/* The mark in the margin is what tells a line apart; the tint only helps. */
.mark {
  color: var(--rule-strong);
}

.line.add {
  color: var(--ink);
  background: color-mix(in srgb, var(--add-ink) 10%, transparent);
}

.line.add .mark {
  color: var(--add-ink);
}

.line.del {
  color: var(--ink-2);
  background: color-mix(in srgb, var(--fault) 10%, transparent);
}

.line.del .mark {
  color: var(--fault);
}

.line.meta {
  opacity: 0.7;
}
</style>
