<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';

import { formatDurationMs, parseTs } from '@/lib/format';
import type { NormalizedEvent } from '@/types';

import EditCard from './EditCard.vue';
import MarkdownText from './MarkdownText.vue';

const props = defineProps<{
  events: NormalizedEvent[];
  now: number;
  gapsAfterSeq: number | null;
  /** Events dropped by rolling retention, so the strip can say where it begins. */
  droppedEvents?: number;
}>();

const PAGE = 150;
/** A recorder prints the time at intervals, not on every line. */
const STAMP_GAP_MS = 60_000;

/**
 * The margin's time scale.
 *
 * A chart recorder prints a terse time in the margin — the unit is the whole
 * word. The header's `last` reading spells it out once, so `7m` there and `7m`
 * here read the same.
 */
function marginTime(ts: string, now: number): string {
  const at = parseTs(ts);
  if (at === null) return '';
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 45) return 'now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  return `${Math.floor(days / 30)}mo`;
}

const showSubagentActivity = ref(false);
const limit = ref(PAGE);
/** The one entry that has just landed, so only it animates. */
const arriving = ref<number | null>(null);
let arrivalTimer: ReturnType<typeof setTimeout> | null = null;

const visibleEvents = computed<NormalizedEvent[]>(() =>
  showSubagentActivity.value
    ? props.events
    : props.events.filter((event) => event.agentId === null),
);

const slice = computed(() => visibleEvents.value.slice(-limit.value));
const hiddenCount = computed(() => Math.max(0, visibleEvents.value.length - slice.value.length));

/**
 * Entries, each knowing whether it carries a time mark.
 *
 * A timestamp on every line is noise; on none of them the strip cannot be read
 * against the clock. Marking roughly once a minute, on the first entry, and on
 * the newest one is what a chart recorder does and what a reader needs.
 */
const rows = computed(() => {
  const list = slice.value;
  return list.map((event, index) => {
    const previous = index > 0 ? list[index - 1] : null;
    const at = parseTs(event.ts);
    const before = previous ? parseTs(previous.ts) : null;
    const stamp =
      previous === null ||
      index === list.length - 1 ||
      event.kind === 'turn_start' ||
      (at !== null && before !== null && at - before >= STAMP_GAP_MS);
    return { event, stamp, key: `${event.agentId ?? 'main'}-${event.seq}` };
  });
});

// A new event should not yank the reading position, but switching sessions must
// start at the newest end.
watch(
  () => props.events.length,
  (next, previous) => {
    if (next < previous) {
      limit.value = PAGE;
      arriving.value = null;
      return;
    }
    if (next === previous) return;
    const newest = props.events[next - 1];
    if (!newest) return;
    // The strip is a recorder: when a tick lands, say so — once, briefly.
    arriving.value = newest.seq;
    if (arrivalTimer !== null) clearTimeout(arrivalTimer);
    arrivalTimer = setTimeout(() => {
      arriving.value = null;
      arrivalTimer = null;
    }, 900);
  },
);

onUnmounted(() => {
  if (arrivalTimer !== null) clearTimeout(arrivalTimer);
});

function agentLabel(agentId: string | null): string {
  if (!agentId) return 'main';
  return agentId.slice(0, 6);
}

/** Attention events carry their level as a class so shape and hue can differ. */
function flags(event: NormalizedEvent): (string | null)[] {
  return [event.kind, event.kind === 'attention' ? event.level : null];
}
</script>

<template>
  <section class="strip">
    <!-- Nothing to toggle when nothing is recorded. -->
    <div v-if="events.length > 0" class="strip-head">
      <button
        class="toggle"
        type="button"
        :aria-pressed="showSubagentActivity"
        @click="showSubagentActivity = !showSubagentActivity"
      >
        {{ showSubagentActivity ? 'agent activity on' : 'agent activity off' }}
      </button>
    </div>

    <!-- Retention, not damage: the strip simply starts later than event one. -->
    <p v-if="droppedEvents && droppedEvents > 0" class="pruned">
      The relay keeps a rolling window, so {{ droppedEvents }} earlier event{{
        droppedEvents === 1 ? '' : 's'
      }}
      were dropped. The record is complete from here on.
    </p>

    <button v-if="hiddenCount > 0" class="more" type="button" @click="limit += PAGE">
      show {{ Math.min(PAGE, hiddenCount) }} older, {{ hiddenCount }} held back
    </button>

    <p v-if="visibleEvents.length === 0" class="quiet">
      {{
        events.length === 0
          ? 'Nothing has been recorded yet. The PC publishes a chunk once it is sealed.'
          : 'Nothing on the main thread yet, and agent activity is off.'
      }}
    </p>

    <ol v-else class="roll">
      <template v-for="row in rows" :key="row.key">
        <li class="entry" :class="[...flags(row.event), { arriving: arriving === row.event.seq }]">
          <!-- The margin is the recorder's: the counter on top, the time scale
               under it. Nothing in the body has to announce when it happened. -->
          <span class="margin">
            <span class="seq">{{ row.event.seq }}</span>
            <span v-if="row.stamp" class="clock">{{ marginTime(row.event.ts, now) }}</span>
          </span>
          <i class="tick" aria-hidden="true"></i>

          <div class="body">
            <!-- The reader's own voice: a solid block, so their turns are the
                 landmarks the log is scanned by. No hue — the accent is spent
                 on the machine asking for a person. -->
            <div v-if="row.event.kind === 'user_prompt'" class="said">
              <span v-if="row.event.injected" class="byline">written on this phone</span>
              <MarkdownText class="utterance" :text="row.event.text" />
            </div>

            <div v-else-if="row.event.kind === 'assistant_text'" class="prose">
              <span v-if="row.event.agentId" class="byline">{{ agentLabel(row.event.agentId) }}</span>
              <MarkdownText :text="row.event.text" />
            </div>

            <EditCard v-else-if="row.event.kind === 'edit'" :event="row.event" />

            <div v-else-if="row.event.kind === 'turn_end'" class="seal">
              <span class="seal-rule" aria-hidden="true"></span>
              <span class="seal-label">{{ formatDurationMs(row.event.durationMs) }}</span>
              <span class="seal-note">{{ row.event.messageCount }} messages</span>
            </div>

            <div v-else-if="row.event.kind === 'turn_start'" class="notch">
              <span class="notch-rule" aria-hidden="true"></span>
              <span class="notch-label">turn</span>
            </div>

            <div v-else-if="row.event.kind === 'attention'" class="notice" :class="row.event.level">
              <span class="notice-kind">{{ row.event.level }}</span>
              <p class="notice-text">{{ row.event.text }}</p>
            </div>

            <div
              v-else-if="row.event.kind === 'injection'"
              class="notice"
              :class="`inj-${row.event.state}`"
            >
              <span class="notice-kind">{{ row.event.state }}</span>
              <p class="notice-text">
                <span class="mono">{{ row.event.promptId.slice(0, 8) }}</span>
                <template v-if="row.event.detail"> {{ row.event.detail }}</template>
              </p>
            </div>

            <div v-else-if="row.event.kind === 'subagent_start'" class="aside">
              <span class="aside-kind">spawned</span>
              <span class="mono">{{ row.event.agentType }}</span>
              <span>{{ row.event.description }}</span>
            </div>

            <div v-else-if="row.event.kind === 'subagent_stop'" class="aside">
              <span class="aside-kind">{{ row.event.status }}</span>
              <span class="mono">{{ agentLabel(row.event.agentId) }}</span>
              <span v-if="row.event.durationMs" class="mono">
                {{ formatDurationMs(row.event.durationMs) }}
              </span>
            </div>

            <div v-else-if="row.event.kind === 'title'" class="notch">
              <span class="notch-label">titled “{{ row.event.title }}” from {{ row.event.source }}</span>
            </div>
          </div>
        </li>

        <!-- A hole we cannot repair: the strip is torn, and the rule with it. -->
        <li v-if="gapsAfterSeq !== null && row.event.seq === gapsAfterSeq" class="tear">
          <span class="margin">
            <span class="seq">{{ gapsAfterSeq + 1 }}</span>
          </span>
          <i class="tick" aria-hidden="true"></i>
          <p>The strip is torn here: event #{{ gapsAfterSeq + 1 }} never arrived.</p>
        </li>
      </template>
    </ol>
  </section>
</template>

<style scoped>
/* The strip bleeds to the edges of its column: a recording is not inset. */
.strip {
  margin: 20px calc(var(--page-pad) * -1) 0;
  min-width: 0;
}

.strip-head {
  display: flex;
  justify-content: flex-end;
  padding: 0 var(--page-pad);
}

.toggle {
  min-height: var(--tap);
  padding: 0;
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

.pruned,
.quiet {
  margin: 12px var(--page-pad) 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--ink-2);
  max-width: var(--measure);
}

.pruned {
  padding-left: 9px;
  border-left: 2px solid var(--rule-strong);
}

.more {
  display: block;
  width: calc(100% - var(--page-pad) * 2);
  margin: 12px var(--page-pad) 0;
  min-height: var(--tap);
  border: 1px dashed var(--rule);
  border-radius: var(--radius);
  background: none;
  color: var(--ink-2);
  font-family: var(--mono);
  font-size: 11px;
  cursor: pointer;
}

.more:hover {
  border-color: var(--ink-2);
  color: var(--ink);
}

/* --- the roll ------------------------------------------------------------- */

.roll {
  position: relative;
  list-style: none;
  margin: 6px 0 0;
  padding: 0;
}

/* The channel: one continuous rule the whole length of the record. Every entry
   hangs off it, and where it is interrupted it means something. */
.roll::before {
  content: '';
  position: absolute;
  left: calc(var(--gutter) - 1px);
  top: 0;
  bottom: 0;
  width: 1px;
  /* One step darker than a panel divider: this one is the drawing, not a
     boundary, and a 1px hairline at --rule disappears on paper. */
  background: var(--rule-strong);
}

.entry,
.tear {
  position: relative;
  display: grid;
  grid-template-columns: var(--gutter) minmax(0, 1fr);
  padding: 7px var(--page-pad) 7px 0;
  min-width: 0;
}

.margin {
  grid-column: 1;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  padding-right: 9px;
  font-family: var(--mono);
  font-variant-numeric: tabular-nums slashed-zero;
}

.seq {
  font-size: 10px;
  line-height: 17px;
  color: var(--ink-2);
  opacity: 0.7;
}

.clock {
  font-size: 10px;
  line-height: 15px;
  color: var(--ink-2);
  opacity: 0.55;
}

/* Most entries carry no tick: prose is the trace, and the trace is continuous.
   A tick means the record did something discrete. */
.tick {
  display: none;
  position: absolute;
  left: calc(var(--gutter) - 3px);
  top: 11px;
  width: 7px;
  height: 7px;
  border: 1px solid var(--ink-2);
  background: var(--paper);
}

.entry.user_prompt .tick,
.entry.edit .tick,
.entry.turn_start .tick,
.entry.turn_end .tick,
.entry.attention .tick,
.entry.injection .tick,
.entry.subagent_start .tick,
.entry.subagent_stop .tick {
  display: block;
}

.entry.user_prompt .tick {
  background: var(--ink);
  border-color: var(--ink);
}

.entry.edit .tick {
  border-width: 2px;
  border-color: var(--ink);
}

.entry.subagent_start .tick,
.entry.subagent_stop .tick {
  width: 3px;
  height: 3px;
  top: 13px;
  left: calc(var(--gutter) - 1px);
  border: none;
  background: var(--ink-2);
}

.entry.turn_start .tick {
  width: 9px;
  height: 1px;
  top: 14px;
  left: calc(var(--gutter) - 4px);
  border: none;
  background: var(--ink-2);
}

.entry.turn_end .tick {
  width: 11px;
  height: 3px;
  top: 13px;
  left: calc(var(--gutter) - 5px);
  border: none;
  background: var(--ink);
}

.entry.attention .tick {
  width: 11px;
  height: 11px;
  top: 9px;
  left: calc(var(--gutter) - 5px);
}

.entry.attention.waiting .tick {
  background: var(--signal);
  border-color: var(--signal);
}

.entry.attention.error .tick {
  background: var(--fault);
  border-color: var(--fault);
}

.entry.injection .tick {
  border-radius: 50%;
}

.body {
  grid-column: 2;
  min-width: 0;
}

.stamp {
  display: block;
  margin-bottom: 3px;
  font-family: var(--mono);
  font-size: 10px;
  color: var(--ink-2);
  opacity: 0.75;
}

.byline {
  display: block;
  margin-bottom: 2px;
  font-family: var(--mono);
  font-size: 10px;
  color: var(--ink-2);
}

/* --- your own prompts ----------------------------------------------------- */

.said {
  background: var(--ink);
  color: var(--paper);
  border-radius: var(--radius);
  padding: 9px 11px 10px;
  max-width: var(--measure);
}

.said .byline {
  color: var(--paper);
  opacity: 0.7;
}

.said .utterance {
  font-size: 15px;
  line-height: 1.5;
  color: var(--paper);
}

.said :deep(.code),
.said :deep(.inline-code) {
  background: color-mix(in srgb, var(--paper) 16%, transparent);
  border-color: color-mix(in srgb, var(--paper) 30%, transparent);
  color: var(--paper);
}

.said :deep(.link) {
  color: var(--paper);
}

.said :deep(.quote) {
  border-left-color: color-mix(in srgb, var(--paper) 40%, transparent);
  color: var(--paper);
  opacity: 0.85;
}

.said :deep(.rule) {
  border-top-color: color-mix(in srgb, var(--paper) 30%, transparent);
}

/* --- the machine's own words --------------------------------------------- */

.prose {
  max-width: var(--measure);
  min-width: 0;
  font-size: 15px;
  line-height: 1.55;
}

/* --- markers -------------------------------------------------------------- */

.seal,
.notch {
  display: flex;
  align-items: baseline;
  gap: 8px;
  max-width: var(--measure);
}

.seal {
  padding: 5px 0;
}

.notch {
  padding: 2px 0;
}

.seal-rule,
.notch-rule {
  align-self: center;
  height: 1px;
  flex: none;
}

.seal-rule {
  width: 18px;
  background: var(--rule-strong);
}

.notch-rule {
  width: 8px;
  background: var(--rule);
}

.seal-label {
  font-family: var(--mono);
  font-size: 13px;
  color: var(--ink);
  font-variant-numeric: tabular-nums;
}

.seal-note {
  font-size: 12px;
  color: var(--ink-2);
}

.notch-label {
  font-family: var(--mono);
  font-size: 10px;
  color: var(--ink-2);
  overflow-wrap: anywhere;
}

/* --- notices on the record ------------------------------------------------ */

.notice {
  border-left: 2px solid var(--rule-strong);
  padding: 2px 0 2px 9px;
  max-width: var(--measure);
}

.notice-kind {
  font-family: var(--mono);
  font-size: 10px;
  color: var(--ink-2);
}

.notice-text {
  margin: 2px 0 0;
  font-size: 14px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.notice.waiting {
  border-left-color: var(--signal);
}

.notice.waiting .notice-kind,
.notice.waiting .notice-text {
  color: var(--signal);
}

.notice.error,
.notice.inj-dropped,
.notice.inj-rejected {
  border-left-color: var(--fault);
}

.notice.error .notice-kind,
.notice.error .notice-text,
.notice.inj-dropped .notice-kind,
.notice.inj-dropped .notice-text,
.notice.inj-rejected .notice-kind,
.notice.inj-rejected .notice-text {
  color: var(--fault);
}

.aside {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 8px;
  align-items: baseline;
  max-width: var(--measure);
  font-size: 13px;
  line-height: 1.5;
  color: var(--ink-2);
  overflow-wrap: anywhere;
}

.aside-kind {
  font-family: var(--mono);
  font-size: 10px;
}

/* --- the tear ------------------------------------------------------------- */

.tear .tick {
  display: block;
  width: 3px;
  height: 3px;
  top: 13px;
  left: calc(var(--gutter) - 1px);
  border: none;
  background: var(--fault);
}

.tear p {
  grid-column: 2;
  margin: 0;
  max-width: var(--measure);
  font-size: 13px;
  line-height: 1.5;
  color: var(--fault);
}

/* The rule is cut here: a dashed length of channel says the paper is torn. */
.tear::after {
  content: '';
  position: absolute;
  left: calc(var(--gutter) - 1px);
  top: 0;
  bottom: 0;
  width: 3px;
  background: repeating-linear-gradient(to bottom, var(--fault) 0 3px, var(--paper) 3px 6px);
}

/* --- arrival -------------------------------------------------------------- */

.entry.arriving {
  animation: land 320ms ease-out;
}

@keyframes land {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

.entry.arriving .tick {
  animation: tick-land 700ms ease-out;
}

@keyframes tick-land {
  0% {
    box-shadow: 0 0 0 0 var(--rule-strong);
  }
  25% {
    box-shadow: 0 0 0 4px var(--rule-strong);
  }
  100% {
    box-shadow: 0 0 0 0 transparent;
  }
}
</style>
