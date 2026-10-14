<script setup lang="ts">
import { computed, ref } from 'vue';

import { countAgents } from '@/lib/agents';
import { basename, relativeTime } from '@/lib/format';
import { useNow } from '@/lib/now';
import { injectionEnabled, relay } from '@/stores/relay';

import Chat from './Chat.vue';
import PromptComposer from './PromptComposer.vue';
import SessionPanel from './SessionPanel.vue';
import StatusMark from './StatusMark.vue';

/**
 * One session: what it needs from you, then what was said.
 *
 * The order is the whole point of this screen. The instrument rail that used to
 * open it — sequence number, last activity, turn duration, cost — was four
 * readings the reader could not act on, in front of the one thing they opened
 * the session to see. Those readings have moved into the session panel, and the
 * conversation is the first thing on the screen.
 *
 * What stays above it is what a person has to act on: a session blocked on an
 * answer, a record that will not read, a session that has failed. Each of those
 * appears only when it is true, which is the only ordering that does not cost
 * anything when nothing is wrong.
 */
const props = defineProps<{ sessionId: string }>();

const now = useNow(5_000);
const panelOpen = ref(false);

/**
 * Whether the subagents' own output joins the conversation.
 *
 * Off by default, and deliberately: a session that spawns five agents produces
 * far more of their text than of its own, and the main thread is what a reader
 * is following. The switch lives in the panel next to the agents it governs.
 */
const showSubagentActivity = ref(false);

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

const agents = computed(() => countAgents(detail.value?.subagents ?? []));

/**
 * The one control this screen adds.
 *
 * It carries the running count so the panel does not have to be opened to find
 * out whether anything is running — which is most of what the drawer is for.
 *
 * The glyph is on all three wordings on purpose: it is what makes the control
 * recognisable as the same thing from one session to the next, and a session
 * with no agents is exactly when a reader has no other cue that a panel exists.
 */
const panelLabel = computed(() => {
  const { total, running } = agents.value;
  if (total === 0) return '☰ details';
  if (running > 0) return `☰ ${total} · ${running} running`;
  return `☰ ${total} agents`;
});

const waiting = computed(() => head.value?.status === 'waiting');
const controllable = computed(() => head.value?.controllable === true);
const ended = computed(() => head.value?.status === 'ended');
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
        <StatusMark :status="head?.status ?? 'unknown'" />
        <span class="sep" aria-hidden="true"></span>
        <span class="mono" :title="head?.project ?? props.sessionId">{{ where }}</span>
        <template v-if="head?.gitBranch">
          <span class="sep" aria-hidden="true"></span>
          <span class="mono">{{ head.gitBranch }}</span>
        </template>

        <button class="panel-open" type="button" @click="panelOpen = true">
          {{ panelLabel }}
        </button>
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
        from the record after event #{{ detail.gap.afterSeq }}. The feed marks the hole.
      </p>
      <p v-else class="cond-text">
        A chunk after event #{{ detail.gap.afterSeq }} could not be read, so its events are missing
        from the feed. Everything either side of the break is shown.
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

    <Chat
      v-if="detail"
      :session-id="props.sessionId"
      :events="detail.events"
      :now="now"
      :show-subagent-activity="showSubagentActivity"
      :dropped-events="dropped"
    />

    <PromptComposer
      id="composer"
      :session-id="props.sessionId"
      :controllable="controllable"
      :injection-enabled="canSend"
      :ended="ended"
    />

    <SessionPanel
      v-model:show-subagent-activity="showSubagentActivity"
      :open="panelOpen"
      :session-id="props.sessionId"
      :head="head"
      :detail="detail"
      @close="panelOpen = false"
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

/* Status, where this session lives, and the way into everything else. One line,
   because the conversation starts immediately below it. */
.where {
  display: flex;
  align-items: center;
  gap: 8px;
  /* Wrapping is what stops the panel button being pushed off the edge. A long
     branch name and a long directory name together are wider than a phone, and
     the page cannot scroll sideways to reach what falls off. */
  flex-wrap: wrap;
  margin: 8px 0 0;
  font-size: 11px;
  color: var(--ink-2);
  min-width: 0;
}

/* The two names yield before the button does: `min-width: 0` is what lets a
   flex item shrink below its content, which is the whole difference between
   these truncating and the control beside them disappearing. */
.where .mono {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sep {
  width: 1px;
  height: 11px;
  background: var(--rule-strong);
  flex: none;
}

/* A real control, not a word that happens to be clickable. It was bare mono
   text in the muted ink at the end of this line, which reads as a label — the
   panel might as well not have existed. */
.panel-open {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
  padding: 0 9px;
  min-height: 30px;
  border: 1px solid var(--rule-strong);
  border-radius: var(--radius);
  background: var(--plate);
  cursor: pointer;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--ink);
  white-space: nowrap;
}

.panel-open:hover,
.panel-open:active {
  border-color: var(--ink-2);
}

.panel-open:active {
  background: var(--paper);
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
</style>
