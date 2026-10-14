<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';

import { formatDurationMs, parseTs, relativeTime } from '@/lib/format';
import { stickyScroller } from '@/lib/stick';
import type { EventKind, NormalizedEvent } from '@/types';

import EditCard from './EditCard.vue';
import MarkdownText from './MarkdownText.vue';

/**
 * The session, as a conversation.
 *
 * This was a chart recorder: every event on a numbered roll with a time scale in
 * the margin and a channel rule down the side. It was honest about the data and
 * useless to read — the two things a person opens a session for are what they
 * said and what came back, and both were buried in the apparatus around them.
 *
 * What it is now is a chat. Your prompts are yours and sit on the right; the
 * agent's replies are the machine's and sit on the left. Everything that was
 * *about* the record rather than part of the conversation — the counter, the
 * clock margin, the turn markers, the running commentary on turn durations —
 * either went with the frame or moved into the session panel, which is where the
 * readings live now.
 *
 * What is kept is what a reader acts on: a hole in the record is still drawn,
 * because a missing stretch of conversation that reads as continuous is a lie;
 * and a long silence still gets a time mark, because "when was this" is a real
 * question that a chat makes invisible.
 */

const props = defineProps<{
  /** Opening a different session is a different conversation, and resets the feed. */
  sessionId: string;
  events: NormalizedEvent[];
  now: number;
  /** Whether the subagents' own output is part of the conversation. */
  showSubagentActivity: boolean;
  /** Events dropped by rolling retention, so the feed can say where it begins. */
  droppedEvents?: number;
}>();

const PAGE = 150;
/** Longer than this between two messages and the reader is told when. */
const SEPARATOR_GAP_MS = 10 * 60 * 1000;

/**
 * Lifecycle entries are *about* an agent, not produced by one.
 *
 * On `subagent_start`/`subagent_stop` the `agentId` names the agent the entry
 * belongs to, so filtering on `agentId === null` hid exactly the two kinds that
 * mark an agent beginning and ending. Spawning and finishing an agent left no
 * trace on the main thread unless agent activity was on, which is the opposite
 * of what the main thread is for.
 */
const LIFECYCLE_KINDS: ReadonlySet<EventKind> = new Set<EventKind>(['subagent_start', 'subagent_stop']);

/**
 * Kinds that are machinery rather than conversation.
 *
 * A turn boundary says nothing the replies either side of it do not, and a title
 * change is already the title at the top of the screen. Both were drawn as
 * notches on the strip; in a chat they read as interruptions.
 */
const SILENT_KINDS: ReadonlySet<EventKind> = new Set<EventKind>(['turn_start', 'turn_end', 'title']);

const limit = ref(PAGE);
/** The one entry that has just landed, so only it animates. */
const arriving = ref<number | null>(null);
let arrivalTimer: ReturnType<typeof setTimeout> | null = null;

const root = ref<HTMLElement | null>(null);
let scroller: ReturnType<typeof stickyScroller> | null = null;

const visibleEvents = computed<NormalizedEvent[]>(() =>
  props.events.filter((event) => {
    if (SILENT_KINDS.has(event.kind)) return false;
    if (props.showSubagentActivity) return true;
    return event.agentId === null || LIFECYCLE_KINDS.has(event.kind);
  }),
);

const slice = computed(() => visibleEvents.value.slice(-limit.value));
const hiddenCount = computed(() => Math.max(0, visibleEvents.value.length - slice.value.length));

/**
 * Where the record itself is torn, keyed by the event it tears after.
 *
 * Derived from every event rather than from the rows: the feed hides subagent
 * traffic by default, and a run of hidden events is not a hole — reading tears
 * off the filtered list would draw one at every gap the filter made. The events
 * arrive in sequence order, so adjacency is the test.
 */
const tears = computed(() => {
  const marks = new Map<number, number>();
  const all = props.events;

  for (let i = 1; i < all.length; i++) {
    const previous = all[i - 1]!;
    const current = all[i]!;
    if (current.seq <= previous.seq + 1) continue;
    marks.set(previous.seq, current.seq - previous.seq - 1);
  }

  return marks;
});

interface TimeMark {
  kind: 'time';
  key: string;
  at: string;
}

interface TearMark {
  kind: 'tear';
  key: string;
  missing: number;
  afterSeq: number;
}

interface Message {
  kind: 'message';
  key: string;
  event: NormalizedEvent;
}

type Item = TimeMark | TearMark | Message;

/**
 * The feed, oldest first, with the marks a reader needs to place it in time.
 *
 * A timestamp on every message is noise and on none of them the conversation has
 * no anchor, so time appears once per quiet stretch — and always at the top, so
 * the feed opens with a date rather than leaving the reader to guess.
 */
const items = computed<Item[]>(() => {
  const out: Item[] = [];
  const list = slice.value;

  for (const [index, event] of list.entries()) {
    const previous = index > 0 ? list[index - 1] : null;
    const at = parseTs(event.ts);
    const before = previous ? parseTs(previous.ts) : null;

    if (
      previous === null ||
      (at !== null && before !== null && at - before >= SEPARATOR_GAP_MS)
    ) {
      out.push({ kind: 'time', key: `t-${event.seq}`, at: event.ts });
    }

    out.push({ kind: 'message', key: `m-${event.agentId ?? 'main'}-${event.seq}`, event });

    const missing = tears.value.get(event.seq);
    if (missing !== undefined) {
      out.push({ kind: 'tear', key: `x-${event.seq}`, missing, afterSeq: event.seq });
    }
  }

  return out;
});

/**
 * Follow the conversation while the reader is at the end of it.
 *
 * The count is the trigger rather than the content: a session that only updates
 * a timestamp is not something to scroll for, and re-running this on every
 * reactive change would fight the reader's own scrolling.
 */
watch(
  () => visibleEvents.value.length,
  (next, previous) => {
    if (next <= previous) return;

    const follow = scroller?.atEnd() ?? false;
    const newest = visibleEvents.value[next - 1];
    if (!newest || SILENT_KINDS.has(newest.kind)) return;

    arriving.value = newest.seq;
    if (arrivalTimer !== null) clearTimeout(arrivalTimer);
    arrivalTimer = setTimeout(() => {
      arriving.value = null;
      arrivalTimer = null;
    }, 900);

    if (follow) scroller?.toEnd('smooth');
  },
);

/**
 * A different session is a different conversation.
 *
 * What was read in the last one has nothing to do with where this one should
 * open, and the feed opens at the newest end: the question a session is opened
 * to answer is what just happened.
 */
watch(
  () => props.sessionId,
  () => {
    limit.value = PAGE;
    arriving.value = null;
    void nextTick(() => scroller?.toEnd());
  },
);

onMounted(() => {
  scroller = stickyScroller(root.value);
  // Two frames of grace: the first renders the feed, and the scroll box only has
  // its final height after the images and code blocks inside it have settled.
  void nextTick(() => {
    scroller?.toEnd();
    requestAnimationFrame(() => scroller?.toEnd());
  });
});

onUnmounted(() => {
  if (arrivalTimer !== null) clearTimeout(arrivalTimer);
  scroller?.release();
  scroller = null;
});

/** Older history prepends, so the reader's place in the conversation is held. */
function showOlder(): void {
  scroller?.preservingPosition(() => {
    limit.value += PAGE;
  });
}

function agentLabel(agentId: string | null): string {
  return agentId ? agentId.slice(0, 6) : 'main';
}
</script>

<template>
  <section ref="root" class="chat">
    <!-- Retention, and the far end of the record, both belong above: the feed
         runs oldest to newest, so the beginning of what is held is the top. -->
    <p v-if="droppedEvents && droppedEvents > 0" class="pruned">
      The relay keeps a rolling window, so {{ droppedEvents }} earlier event{{
        droppedEvents === 1 ? '' : 's'
      }}
      were dropped. The conversation is complete from here on.
    </p>

    <button v-if="hiddenCount > 0" class="more" type="button" @click="showOlder">
      show {{ Math.min(PAGE, hiddenCount) }} older, {{ hiddenCount }} held back
    </button>

    <p v-if="items.length === 0" class="quiet">
      {{
        events.length === 0
          ? 'Nothing has been recorded yet. The PC publishes a chunk once it is sealed.'
          : 'Nothing on the main thread yet, and agent activity is off.'
      }}
    </p>

    <ol v-else class="feed">
      <template v-for="item in items" :key="item.key">
        <!-- A silence, dated. One of these replaces a timestamp on every line. -->
        <li v-if="item.kind === 'time'" class="time">
          <span class="rule" aria-hidden="true"></span>
          <span class="when">{{ relativeTime(item.at, now) }}</span>
          <span class="rule" aria-hidden="true"></span>
        </li>

        <li v-else-if="item.kind === 'tear'" class="tear">
          {{ item.missing === 1 ? 'One event is' : `${item.missing} events are` }} missing from
          the record after #{{ item.afterSeq }}.
        </li>

        <!-- Your own voice: a solid block on the right, so your turns are the
             landmarks the conversation is scanned by. No hue — the accent is
             spent on the machine asking for a person. -->
        <li
          v-else-if="item.event.kind === 'user_prompt'"
          class="turn mine"
          :class="{ arriving: arriving === item.event.seq }"
        >
          <div class="said">
            <span v-if="item.event.injected" class="byline">written on this phone</span>
            <MarkdownText class="utterance" :text="item.event.text" />
          </div>
        </li>

        <li
          v-else-if="item.event.kind === 'assistant_text'"
          class="turn theirs"
          :class="{ arriving: arriving === item.event.seq }"
        >
          <span v-if="item.event.agentId" class="byline">{{ agentLabel(item.event.agentId) }}</span>
          <MarkdownText class="prose" :text="item.event.text" />
        </li>

        <li v-else-if="item.event.kind === 'edit'" class="turn theirs">
          <EditCard :event="item.event" />
        </li>

        <li v-else-if="item.event.kind === 'attention'" class="turn notice" :class="item.event.level">
          <span class="notice-kind">{{ item.event.level }}</span>
          <p class="notice-text">{{ item.event.text }}</p>
        </li>

        <li
          v-else-if="item.event.kind === 'injection'"
          class="turn notice"
          :class="`inj-${item.event.state}`"
        >
          <span class="notice-kind">{{ item.event.state }}</span>
          <p class="notice-text">
            <span class="mono">{{ item.event.promptId.slice(0, 8) }}</span>
            <template v-if="item.event.detail"> {{ item.event.detail }}</template>
          </p>
        </li>

        <li v-else-if="item.event.kind === 'subagent_start'" class="turn aside">
          <span class="aside-kind">spawned</span>
          <span class="mono">{{ item.event.agentType }}</span>
          <span>{{ item.event.description }}</span>
        </li>

        <li v-else-if="item.event.kind === 'subagent_stop'" class="turn aside">
          <span class="aside-kind">{{ item.event.status }}</span>
          <span class="mono">{{ agentLabel(item.event.agentId) }}</span>
          <span v-if="item.event.durationMs" class="mono">
            {{ formatDurationMs(item.event.durationMs) }}
          </span>
        </li>
      </template>
    </ol>
  </section>
</template>

<style scoped>
.chat {
  margin-top: 14px;
  min-width: 0;
}

/* --- the feed ------------------------------------------------------------- */

.feed {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}

.turn {
  display: flex;
  flex-direction: column;
  min-width: 0;
  max-width: 100%;
}

/* Air between turns, and almost none between the parts of one: a reply and the
   edits it made are the same utterance. */
.turn + .turn {
  margin-top: 14px;
}

.turn.theirs + .turn.theirs {
  margin-top: 8px;
}

.mine {
  align-items: flex-end;
}

.theirs {
  align-items: flex-start;
}

/* --- your own prompts ----------------------------------------------------- */

.said {
  background: var(--ink);
  color: var(--paper);
  border-radius: var(--radius);
  padding: 9px 11px 10px;
  /* Not the full width: the gap on the left is what makes it yours. */
  max-width: min(var(--measure), 88%);
}

.byline {
  display: block;
  margin-bottom: 2px;
  font-family: var(--mono);
  font-size: 10px;
  color: var(--ink-2);
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

/* --- the machine's own words ---------------------------------------------- */

.prose {
  max-width: var(--measure);
  min-width: 0;
  font-size: 15px;
  line-height: 1.55;
}

/* An edit is part of the reply it belongs to, and hangs off the same edge. */
.turn.theirs :deep(.edit) {
  max-width: 100%;
}

/* --- time ----------------------------------------------------------------- */

.time {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 14px 0 10px;
}

.time:first-child {
  margin-top: 0;
}

.time .rule {
  flex: 1;
  height: 1px;
  background: var(--rule);
}

.when {
  font-family: var(--mono);
  font-size: 10px;
  color: var(--ink-2);
  white-space: nowrap;
}

/* --- the record is torn --------------------------------------------------- */

.tear {
  margin: 10px 0;
  padding: 4px 0 4px 9px;
  border-left: 2px dashed var(--fault);
  max-width: var(--measure);
  font-size: 13px;
  line-height: 1.5;
  color: var(--fault);
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
  margin-left: 9px;
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

/* --- ends of the held record ---------------------------------------------- */

.more {
  display: block;
  width: 100%;
  margin: 0 0 14px;
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

.pruned,
.quiet {
  margin: 0 0 12px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--ink-2);
  max-width: var(--measure);
}

.pruned {
  padding-left: 9px;
  border-left: 2px solid var(--rule-strong);
}

/* --- arrival -------------------------------------------------------------- */

.turn.arriving {
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

@media (prefers-reduced-motion: reduce) {
  .turn.arriving {
    animation: none;
  }
}
</style>
