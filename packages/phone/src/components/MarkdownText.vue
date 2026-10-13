<script setup lang="ts">
import { computed } from 'vue';

import { parseBlocks, type Block, type Inline } from '@/lib/markdown';

/**
 * Renders a transcript excerpt.
 *
 * The component renders its own children, so it takes three shapes of input:
 * `text` is a whole message and is parsed here, `blocks` is an already-parsed
 * nested list (a quote's body, a list item's body) and `inline` is a set of
 * spans inside one paragraph. Exactly one is supplied.
 *
 * Everything becomes Vue text nodes and elements — never `v-html` — so a
 * transcript containing `<script>` or `<img onerror=…>` renders as those
 * characters and nothing else. The only transcript value that reaches an
 * attribute is a link's `href`, which the parser has already screened.
 */
const props = defineProps<{
  text?: string;
  blocks?: Block[];
  inline?: Inline[];
}>();

const blocks = computed<Block[]>(() => props.blocks ?? parseBlocks(props.text ?? ''));
const nodes = computed<Inline[] | null>(() => props.inline ?? null);
</script>

<template>
  <div v-if="nodes === null" class="md">
    <template v-for="block in blocks" :key="block.id">
      <pre v-if="block.type === 'code'" class="code"><code>{{ block.value }}</code></pre>

      <component :is="`h${block.level}`" v-else-if="block.type === 'heading'" class="heading">
        <MarkdownText :inline="block.inline" />
      </component>

      <hr v-else-if="block.type === 'rule'" class="rule" />

      <blockquote v-else-if="block.type === 'quote'" class="quote">
        <MarkdownText :blocks="block.blocks" />
      </blockquote>

      <ul v-else-if="block.type === 'list' && !block.ordered" class="list">
        <li v-for="item in block.items" :key="item.id" class="item">
          <MarkdownText :blocks="item.blocks" />
        </li>
      </ul>

      <ol v-else-if="block.type === 'list'" class="list" :start="block.start">
        <li v-for="item in block.items" :key="item.id" class="item">
          <MarkdownText :blocks="item.blocks" />
        </li>
      </ol>

      <p v-else class="para">
        <!-- Rendered as text nodes: transcripts are untrusted input and are
             never inserted as markup. -->
        <MarkdownText :inline="block.inline" />
      </p>
    </template>
  </div>

  <!-- Inline spans, rendered without a wrapper so they can sit inside the
       element their parent chose (`<strong>`, `<a>`, `<p>`). -->
  <template v-else>
    <template v-for="(node, index) in nodes" :key="index">
      <code v-if="node.type === 'code'" class="inline-code">{{ node.value }}</code>
      <strong v-else-if="node.type === 'strong'"><MarkdownText :inline="node.children" /></strong>
      <em v-else-if="node.type === 'em'"><MarkdownText :inline="node.children" /></em>
      <a
        v-else-if="node.type === 'link'"
        class="link"
        :href="node.href"
        target="_blank"
        rel="noopener noreferrer"
      ><MarkdownText :inline="node.children" /></a>
      <template v-else>{{ node.value }}</template>
    </template>
  </template>
</template>

<style scoped>
.md {
  min-width: 0;
}

/* Space every block apart, whatever kind it is. `:not(:first-child)` rather
   than `* + *` so this outranks the per-block `margin: 0` below. */
.md > :not(:first-child) {
  margin-top: 9px;
}

.para {
  margin: 0;
  /* Newlines matter in a transcript. */
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.heading {
  margin: 0;
  font-weight: 600;
  line-height: 1.35;
  overflow-wrap: anywhere;
}

h1.heading {
  font-size: 1.3em;
}

h2.heading {
  font-size: 1.18em;
}

h3.heading {
  font-size: 1.08em;
}

h4.heading,
h5.heading,
h6.heading {
  font-size: 1em;
  color: var(--ink-2);
}

.rule {
  margin: 0;
  border: none;
  border-top: 1px solid var(--rule);
}

.quote {
  margin: 0;
  padding: 1px 0 1px 9px;
  border-left: 2px solid var(--rule-strong);
  color: var(--ink-2);
}

.list {
  margin: 0;
  padding-left: 20px;
}

.item + .item {
  margin-top: 4px;
}

.code {
  margin: 0;
  background: var(--plate);
  border: 1px solid var(--rule);
  border-radius: var(--radius);
  padding: 8px 10px;
  line-height: 1.5;
  white-space: pre;
  overflow-x: auto;
}

.inline-code {
  background: var(--plate);
  border: 1px solid var(--rule);
  border-radius: 2px;
  padding: 0 3px;
  overflow-wrap: anywhere;
}

.link {
  overflow-wrap: anywhere;
}
</style>
