<script setup lang="ts">
import { computed } from 'vue';

import { basename, formatDurationMs, formatUSD, relativeTime } from '@/lib/format';
import { useNow } from '@/lib/now';
import { injectionEnabled, relay } from '@/stores/relay';

import CostPanel from './CostPanel.vue';
import PromptComposer from './PromptComposer.vue';
import StatusMark from './StatusMark.vue';
import SubagentTree from './SubagentTree.vue';
import Timeline from './Timeline.vue';

const props = defineProps<{ sessionId: string }>();

const now = useNow(5_000);

const detail = computed(() => (relay.detail?.sessionId === props.sessionId ? relay.detail : null));

/**
 * The head is the session's own status file; the cached copy is a fallback for
 * the moment before the first load resolves, and for after a failed one.
 */
const head = computed(() => detail.value?.head ?? relay.heads[props.sessionId] ?? null);

const title = computed(() => {
  const h = head.value;
  if (h?.title) return h.title;
  if (h?.project) return basename(h.project);
  return props.sessionId.slice(0, 8);
});

const where = computed(() => {
  const project = head.value?.project;
  if (!project) return props.sessionId;
  return basename(project);
});

/** The counter, and the number a torn record is described by. */
const seq = computed(() => head.value?.lastSeq ?? detail.value?.events.length ?? 0);

/** `claude-sonnet-4-5-20250929` is a serial number, not a name. */
const model = computed(() => {
  const raw = head.value?.model ?? detail.value?.summary.model ?? null;
  if (!raw) return null;
  return raw.replace(/^claude-/, '').replace(/-\d{8}$/, '');
});

const lastEventAt = computed(() => detail.value?.summary.lastEventTs ?? null);

const waiting = computed(() => head.value?.status === 'waiting');
const controllable = computed(() => head.value?.controllable === true);
/**
 * Strictly true only when the PC says so, and read from the session's own head
 * before the index — a session opened directly has no index to consult. See
 * `injectionEnabled` in the store.
 */
const canSend = computed(() => injectionEnabled());
const canWrite = computed(() => controllable.value && canSend.value);

const errorAttention = computed(() => {
  const attention = detail.value?.summary.latestAttention;
  if (!attention || attention.level !== 'error') return null;
  return attention;
});

/**
 * An open permission dialog, when the record says so.
 *
 * `level: 'waiting'` attention is only ever produced for a permission
 * notification, so it is the one signal on the phone that identifies this case.
 *
 * It is required to be the *newest* entry as well. A dialog stops the session
 * dead, so nothing can be recorded after it while it is open — and once it is
 * answered, the next entry is what releases this and brings the button back.
 * Without that check the flag would latch forever from the first dialog a
 * session ever showed.
 */
const permissionDialog = computed(() => {
  const d = detail.value;
  if (!waiting.value || !d) return null;

  const attention = d.summary.latestAttention;
  const newest = d.events.at(-1);
  if (!attention || attention.level !== 'waiting') return null;
  return newest?.kind === 'attention' ? attention : null;
});

const dropped = computed(() => detail.value?.pruned?.droppedEvents ?? 0);

/**
 * Put the cursor in the composer.
 *
 * This used to scroll the page to the foot of it, which was the wrong end of a
 * long record when the machine was blocked on a person. The composer is pinned
 * to the bottom of the screen now, so it is already in view and the only thing
 * left to do is focus it.
 */
function toComposer(): void {
  document.getElementById('composer')?.querySelector('textarea')?.focus({ preventScroll: true });
}
</script>

<template>
  <div class="detail">
    <header class="ident">
      <h1>{{ title }}</h1>
      <p class="where">
        <span class="mono" :title="head?.project ?? props.sessionId">{{ where }}</span>
        <template v-if="head?.gitBranch">
          <span class="sep" aria-hidden="true"></span>
          <span class="mono">{{ head.gitBranch }}</span>
        </template>
      </p>
    </header>

    <!-- The "should I walk back to my desk" answer. Deliberately the only place
         the reserved hue is allowed to fill anything. -->
    <section v-if="waiting" class="urgent">
      <p class="urgent-kind">waiting on you</p>
      <p class="urgent-why">{{ head?.waitingFor || 'This session cannot continue without an answer.' }}</p>

      <!-- Offered only when a prompt could actually be typed. A permission
           dialog swallows anything written to the session — the keystrokes
           answer the dialog, and can approve the tool it is asking about — so
           the bridge refuses outright. Sending someone to a composer that will
           be refused is worse than saying why they have to walk back to the PC. -->
      <button
        v-if="canWrite && !permissionDialog"
        class="urgent-go"
        type="button"
        @click="toComposer"
      >
        write a prompt
      </button>
      <p v-else-if="permissionDialog" class="urgent-blocked">
        A permission dialog is open on the PC. Answer it there — anything typed here would answer
        the dialog instead of being submitted.
      </p>
    </section>

    <section v-if="errorAttention" class="cond fault">
      <p class="cond-kind">error</p>
      <p class="cond-text">
        {{ errorAttention.text }}
        <span class="mono">{{ relativeTime(errorAttention.ts, now) }}</span>
      </p>
    </section>

    <!-- A chunk that will not read. Repairable, so it is not dressed as damage. -->
    <section v-if="detail?.resyncing" class="cond">
      <p class="cond-kind">resyncing</p>
      <p class="cond-text">
        A chunk came back unreadable. It is being refetched; everything before the break is shown.
      </p>
    </section>

    <!-- A hole in the record. Everything either side of it is still shown, so
         the cost is the missing events and not the rest of the session. -->
    <section v-else-if="detail?.gap" class="cond fault">
      <p class="cond-kind">stream gap</p>
      <p v-if="detail.gap.missing !== null" class="cond-text">
        {{ detail.gap.missing === 1 ? 'One event is' : `${detail.gap.missing} events are` }} missing
        from the record after event #{{ detail.gap.afterSeq }}. The strip marks the hole.
      </p>
      <p v-else class="cond-text">
        A chunk after event #{{ detail.gap.afterSeq }} could not be read, so its events are missing
        from the strip. Everything either side of the break is shown.
      </p>
    </section>

    <!-- Catching up after the phone was asleep. Ordinary, and it heals itself. -->
    <section v-else-if="detail?.inFlight" class="cond">
      <p class="cond-kind">catching up</p>
      <p class="cond-text">
        Fetching {{ detail.pendingChunks.length }} more chunks a few at a time, so a catch-up does
        not trip Gitee's rate limit.
      </p>
    </section>

    <section v-if="detail?.error" class="cond fault">
      <p class="cond-kind">cannot read this session</p>
      <p class="cond-text">{{ detail.error }}</p>
    </section>

    <!-- The instrument face. Four readings in a fixed order, learned once; the
         two stream counters that were here died because nobody can act on a
         chunk count while everything is fine. -->
    <section class="face">
      <div class="face-head">
        <StatusMark :status="head?.status ?? 'unknown'" />
        <span v-if="model" class="model mono">{{ model }}</span>
      </div>

      <dl class="rail">
        <div>
          <dt>seq</dt>
          <dd>{{ seq }}</dd>
        </div>
        <div>
          <dt>last</dt>
          <dd :class="{ quiet: !lastEventAt }">{{ lastEventAt ? relativeTime(lastEventAt, now) : '—' }}</dd>
        </div>
        <div>
          <dt>turn</dt>
          <dd :class="{ quiet: !detail?.summary.lastTurnEnd }">
            {{ detail?.summary.lastTurnEnd ? formatDurationMs(detail.summary.lastTurnEnd.durationMs) : '—' }}
          </dd>
        </div>
        <div>
          <dt>cost</dt>
          <dd :class="{ quiet: !head?.cost }">{{ head?.cost ? formatUSD(head.cost.totalCostUSD) : '—' }}</dd>
        </div>
      </dl>
    </section>

    <Timeline
      v-if="detail"
      :events="detail.events"
      :now="now"
      :dropped-events="dropped"
    />

    <SubagentTree v-if="detail && detail.subagents.length > 0" :nodes="detail.subagents" />

    <CostPanel :cost="head?.cost" />

    <PromptComposer
      id="composer"
      :session-id="props.sessionId"
      :controllable="controllable"
      :injection-enabled="canSend"
    />
  </div>
</template>

<style scoped>
.detail {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

/* --- identity ------------------------------------------------------------- */

.ident {
  padding: 16px 0 0;
  min-width: 0;
}

h1 {
  margin: 0;
  font-size: 21px;
  line-height: 1.25;
  font-weight: 600;
  letter-spacing: -0.01em;
  overflow-wrap: anywhere;
}

.where {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 5px 0 0;
  font-size: 11px;
  color: var(--ink-2);
  overflow-wrap: anywhere;
}

.sep {
  width: 1px;
  height: 11px;
  background: var(--rule-strong);
  flex: none;
}

/* --- the band that fills -------------------------------------------------- */

.urgent {
  margin: 14px 0 0;
  padding: 11px 12px 12px;
  background: var(--plate);
  border-left: 3px solid var(--signal);
}

.urgent-kind {
  margin: 0;
  font-family: var(--mono);
  font-size: 11px;
  font-weight: 600;
  color: var(--signal);
}

.urgent-why {
  margin: 3px 0 0;
  font-size: 17px;
  line-height: 1.35;
  font-weight: 500;
  color: var(--ink);
  overflow-wrap: anywhere;
  max-width: var(--measure);
}

.urgent-go {
  margin-top: 6px;
  min-height: var(--tap);
  padding: 0;
  border: none;
  background: none;
  cursor: pointer;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--signal);
  border-bottom: 1px solid var(--signal);
}

.urgent-blocked {
  margin: 6px 0 0;
  max-width: var(--measure);
  font-size: 13px;
  line-height: 1.45;
  color: var(--ink);
}

/* --- conditions ----------------------------------------------------------- */

.cond {
  margin: 12px 0 0;
  padding-left: 10px;
  border-left: 2px solid var(--rule-strong);
  max-width: var(--measure);
}

.cond-kind {
  margin: 0;
  font-family: var(--mono);
  font-size: 10px;
  color: var(--ink-2);
}

.cond-text {
  margin: 2px 0 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--ink-2);
  overflow-wrap: anywhere;
}

.cond.fault {
  border-left-color: var(--fault);
}

.cond.fault .cond-kind,
.cond.fault .cond-text {
  color: var(--fault);
}

/* --- the face ------------------------------------------------------------- */

.face {
  margin: 16px 0 0;
  border-top: 1px solid var(--rule-strong);
  border-bottom: 1px solid var(--rule-strong);
}

.face-head {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  padding: 9px 0 8px;
  border-bottom: 1px solid var(--rule);
}

.model {
  font-size: 12px;
  color: var(--ink-2);
  overflow-wrap: anywhere;
}

.rail {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  margin: 0;
}

.rail > div {
  display: flex;
  align-items: baseline;
  gap: 7px;
  min-width: 0;
  padding: 7px 0;
}

/* The hairline between readings is the engraved division on a dial. */
.rail > div:nth-child(even) {
  padding-left: 12px;
  border-left: 1px solid var(--rule);
}

.rail > div:nth-child(n + 3) {
  border-top: 1px solid var(--rule);
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

@media (min-width: 480px) {
  .rail {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }

  .rail > div:nth-child(n + 3) {
    border-top: none;
  }

  .rail > div:nth-child(n + 2) {
    padding-left: 12px;
    border-left: 1px solid var(--rule);
  }
}
</style>
