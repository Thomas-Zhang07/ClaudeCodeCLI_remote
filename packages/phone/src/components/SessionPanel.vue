<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';

import { countAgents } from '@/lib/agents';
import { formatDurationMs, relativeTime } from '@/lib/format';
import { useNow } from '@/lib/now';
import type { DetailState } from '@/stores/relay';
import type { SessionHead } from '@/types';

import CostPanel from './CostPanel.vue';
import StatusMark from './StatusMark.vue';
import SubagentTree from './SubagentTree.vue';

/**
 * Everything about a session that is not the conversation.
 *
 * These readings used to sit above the chat, in a fixed rail at the top of the
 * screen: sequence number, last activity, turn duration, cost. Two problems with
 * that. It is the wrong thing to open on — a session is opened to read what was
 * said, and the first screenful was apparatus. And four readings is not a
 * summary, it is a dashboard, and a dashboard with nowhere to put the fifth
 * reading grows a sixth.
 *
 * As a drawer they cost nothing until asked for, and the things that were
 * already true but had no home — the subagent tree, the full path, how much of
 * the record is held — are in here with them.
 *
 * It is a dialog rather than a second screen because the conversation must stay
 * behind it: the question being answered is "what is this session doing", and
 * that is a question about the thing underneath.
 */
const props = defineProps<{
  open: boolean;
  sessionId: string;
  head: SessionHead | null;
  detail: DetailState | null;
  showSubagentActivity: boolean;
}>();

const emit = defineEmits<{
  close: [];
  'update:showSubagentActivity': [value: boolean];
}>();

const now = useNow(5_000);
const closeButton = ref<HTMLButtonElement | null>(null);

const nodes = computed(() => props.detail?.subagents ?? []);
const agentCount = computed(() => countAgents(nodes.value).total);

const model = computed(() => {
  const raw = props.head?.model ?? props.detail?.summary.model ?? null;
  if (!raw) return null;
  return raw.replace(/^claude-/, '').replace(/-\d{8}$/, '');
});

const seq = computed(() => props.head?.lastSeq ?? props.detail?.events.length ?? 0);
const lastEventAt = computed(() => props.detail?.summary.lastEventTs ?? null);
const lastTurn = computed(() => props.detail?.summary.lastTurnEnd ?? null);
const dropped = computed(() => props.detail?.pruned?.droppedEvents ?? 0);
const waitingFor = computed(() => (props.head?.status === 'waiting' ? props.head.waitingFor : null));

/**
 * The keyboard way out, and the only one that works without aiming.
 *
 * Bound to the document rather than the panel, because focus can be anywhere in
 * the app while this is open and an `Esc` that only works once you have clicked
 * inside is an `Esc` that appears broken.
 */
function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && props.open) {
    event.stopPropagation();
    emit('close');
  }
}

watch(
  () => props.open,
  (open) => {
    if (open) {
      document.addEventListener('keydown', onKeydown, true);
      // Focus lands on the way out rather than on the first reading: this is a
      // panel to read, and the first thing a keyboard needs is a way back.
      void nextTick(() => closeButton.value?.focus());
    } else {
      document.removeEventListener('keydown', onKeydown, true);
    }
  },
);

onUnmounted(() => document.removeEventListener('keydown', onKeydown, true));
</script>

<template>
  <div v-if="open" class="drawer">
    <div class="scrim" @click="emit('close')"></div>

    <aside
      class="panel"
      role="dialog"
      aria-modal="true"
      aria-label="Session details and agents"
    >
      <header class="head">
        <h2>session</h2>
        <button ref="closeButton" class="close" type="button" aria-label="Close" @click="emit('close')">
          <span aria-hidden="true">✕</span>
        </button>
      </header>

      <div class="body">
        <!-- --- agents -------------------------------------------------------- -->
        <section class="block">
          <!-- The tree brings its own heading, which counts the agents and says
               how many are still running; a second one here would say it twice. -->
          <template v-if="agentCount > 0">
            <SubagentTree :nodes="nodes" />
          </template>
          <template v-else>
            <p class="block-head">agents</p>
            <p class="quiet">No agents have run in this session.</p>
          </template>

          <!-- The control for whether the agents' own output joins the chat sits
               with the agents, not with the chat: it is a statement about them. -->
          <button
            v-if="agentCount > 0"
            class="toggle"
            type="button"
            :aria-pressed="showSubagentActivity"
            @click="emit('update:showSubagentActivity', !showSubagentActivity)"
          >
            agent activity in chat {{ showSubagentActivity ? 'on' : 'off' }}
          </button>
        </section>

        <!-- --- readings ----------------------------------------------------- -->
        <section class="block">
          <p class="block-head">state</p>

          <p class="line">
            <StatusMark :status="head?.status ?? 'unknown'" />
            <span v-if="model" class="mono muted">{{ model }}</span>
          </p>

          <p v-if="waitingFor" class="line waiting">
            waiting for: <span>{{ waitingFor }}</span>
          </p>

          <p v-if="head?.project" class="path mono" :title="head.project">{{ head.project }}</p>
          <p v-if="head?.gitBranch" class="path mono muted">{{ head.gitBranch }}</p>
        </section>

        <!-- --- the record --------------------------------------------------- -->
        <section class="block">
          <p class="block-head">record</p>

          <dl class="readings">
            <div>
              <dt>seq</dt>
              <dd>{{ seq }}</dd>
            </div>
            <div>
              <dt>last</dt>
              <dd :class="{ quiet: !lastEventAt }">
                {{ lastEventAt ? relativeTime(lastEventAt, now) : '—' }}
              </dd>
            </div>
            <div>
              <dt>turn</dt>
              <dd :class="{ quiet: !lastTurn }">
                {{ lastTurn ? formatDurationMs(lastTurn.durationMs) : '—' }}
              </dd>
            </div>
            <div>
              <dt>chunks</dt>
              <dd :class="{ quiet: !detail }">
                {{ detail ? `${detail.chunksLoaded}/${detail.chunksTotal}` : '—' }}
              </dd>
            </div>
          </dl>

          <p v-if="detail?.inFlight" class="note">
            Fetching {{ detail.pendingChunks.length }} more chunks a few at a time, so a catch-up
            does not trip Gitee's rate limit.
          </p>

          <p v-if="dropped > 0" class="note">
            {{ dropped }} earlier event{{ dropped === 1 ? '' : 's' }} were dropped by the relay's
            rolling window.
          </p>
        </section>

        <!-- --- cost --------------------------------------------------------- -->
        <CostPanel :cost="head?.cost" />
      </div>
    </aside>
  </div>
</template>

<style scoped>
/* The overlay escapes the page's own scroll box: nothing here should move when
   the conversation behind it does. */
.drawer {
  position: fixed;
  inset: 0;
  z-index: 20;
}

/* `touch-action: none` is load-bearing. The page's scrolling box is an ancestor
   of this overlay, so a drag on the scrim would scroll the conversation behind
   it — the panel would look modal and the page underneath would still move. */
.scrim {
  position: absolute;
  inset: 0;
  background: color-mix(in srgb, var(--paper) 62%, transparent);
  touch-action: none;
}

.panel {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  display: flex;
  flex-direction: column;
  width: min(340px, 88vw);
  background: var(--paper);
  border-left: 1px solid var(--rule-strong);
  padding: 0 var(--page-pad) env(safe-area-inset-bottom, 0px);
  animation: slide 180ms ease-out;
}

@keyframes slide {
  from {
    transform: translateX(12px);
    opacity: 0;
  }
  to {
    transform: none;
    opacity: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .panel {
    animation: none;
  }
}

.head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
  padding-top: env(safe-area-inset-top, 0px);
  border-bottom: 1px solid var(--rule-strong);
}

h2 {
  margin: 0;
  font-family: var(--mono);
  font-size: 10px;
  font-weight: 400;
  color: var(--ink-2);
}

.close {
  margin-left: auto;
  width: var(--tap);
  height: var(--tap);
  border: none;
  background: none;
  color: var(--ink-2);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
}

.close:hover {
  color: var(--ink);
}

.body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding-bottom: 32px;
}

.block {
  margin-top: 18px;
}

.block-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 0 0 8px;
  font-family: var(--mono);
  font-size: 10px;
  color: var(--ink-2);
}

.quiet {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--ink-2);
  max-width: var(--measure);
}

.toggle {
  margin-top: 10px;
  padding: 0;
  min-height: 32px;
  border: none;
  border-bottom: 1px solid var(--rule);
  background: none;
  cursor: pointer;
  font-family: var(--mono);
  font-size: 10px;
  color: var(--ink-2);
}

.toggle:hover {
  color: var(--ink);
}

.toggle[aria-pressed='true'] {
  color: var(--ink);
  border-bottom-color: var(--ink);
}

.line {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin: 0 0 6px;
  font-size: 13px;
}

.line.waiting {
  color: var(--signal);
}

.path {
  margin: 2px 0 0;
  font-size: 11px;
  overflow-wrap: anywhere;
}

/* The readings, laid out as the receipt they are. */
.readings {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  margin: 0;
  border-top: 1px solid var(--rule);
}

.readings > div {
  display: flex;
  align-items: baseline;
  gap: 7px;
  min-width: 0;
  padding: 7px 0;
  border-bottom: 1px solid var(--rule);
}

.readings > div:nth-child(even) {
  padding-left: 12px;
  border-left: 1px solid var(--rule);
}

dt {
  font-family: var(--mono);
  font-size: 10px;
  color: var(--ink-2);
  flex: none;
}

dd {
  margin: 0;
  font-family: var(--mono);
  font-size: 14px;
  font-variant-numeric: tabular-nums slashed-zero;
  letter-spacing: -0.01em;
  color: var(--ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

dd.quiet {
  color: var(--ink-2);
  opacity: 0.6;
}

.note {
  margin: 10px 0 0;
  padding-left: 9px;
  border-left: 2px solid var(--rule-strong);
  font-size: 12px;
  line-height: 1.5;
  color: var(--ink-2);
  max-width: var(--measure);
}

/* The tree brings its own top rule and margin, which reads as a section divider
   here rather than as the start of a page section. */
.block :deep(.tree) {
  margin-top: 0;
  padding-top: 0;
  border-top: none;
}
</style>
