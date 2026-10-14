<script setup lang="ts">
import { computed, ref } from 'vue';

import { relativeTime } from '@/lib/format';
import { webCryptoAvailable } from '@/lib/hmac';
import { useNow } from '@/lib/now';
import { canSign } from '@/lib/settings';
import { MAX_PROMPT_BYTES, outboundFor, promptExpired, sendPrompt } from '@/stores/relay';
import type { OutboundPrompt } from '@/types';

const props = defineProps<{
  sessionId: string;
  controllable: boolean;
  /**
   * Whether the PC will actually deliver a prompt.
   *
   * Deliberately separate from `controllable`: a session can be one the PC owns
   * the terminal for, while the operator has still not allowed prompts. Offering
   * a text box in that state collects a prompt that is written, never read, and
   * never acknowledged — with nothing to explain why.
   */
  injectionEnabled: boolean;
  /**
   * Whether the session is over.
   *
   * An ended session is not controllable, so it lands in the same branch as a
   * session the PC never owned — and that branch tells the reader to start it
   * with `ccr`, which is advice about a session they have just closed.
   */
  ended: boolean;
}>();

const now = useNow(15_000);
const text = ref('');
const sending = ref(false);
const notice = ref<{ kind: 'ok' | 'error'; message: string } | null>(null);
const cryptoReady = webCryptoAvailable();

/**
 * The history is folded away by default.
 *
 * The composer is pinned to the foot of the screen, so whatever is in it is paid
 * for on every screenful of the record — and up to twenty past prompts, each
 * several lines, would cost more than the thing being read. The count stays
 * visible, because "did that land?" is the question it answers.
 */
const showHistory = ref(false);

const outbound = computed<OutboundPrompt[]>(() => outboundFor(props.sessionId));

const byteLength = computed(() => new TextEncoder().encode(text.value.trim()).length);
const tooLong = computed(() => byteLength.value > MAX_PROMPT_BYTES);

const blockedReason = computed<string | null>(() => {
  // Both of these are handled by a notice of their own.
  if (!props.controllable || !props.injectionEnabled) return null;
  if (!canSign.value) return 'Add the shared secret in Settings before sending.';
  if (!cryptoReady) {
    return 'Web Crypto is unavailable here, so prompts cannot be signed. Open the app over https:// (or localhost).';
  }
  return null;
});

const canSend = computed(
  () =>
    props.controllable &&
    props.injectionEnabled &&
    blockedReason.value === null &&
    text.value.trim() !== '' &&
    !tooLong.value,
);

/**
 * What to say about a prompt that was sent.
 *
 * A refusal carries the PC's own reason, which is the whole value of the
 * acknowledgment — "rejected" on its own tells you nothing you can act on, and
 * sends you looking for an answer elsewhere.
 */
function statusLabel(prompt: OutboundPrompt): { label: string; tone: string } {
  if (prompt.acknowledged === 'rejected') {
    return { label: prompt.ackDetail ?? 'the PC refused this prompt', tone: 'rejected' };
  }
  if (prompt.acknowledged === 'delivered') {
    return { label: 'reached the session', tone: 'delivered' };
  }
  if (prompt.acknowledged) {
    return { label: prompt.acknowledged, tone: prompt.acknowledged };
  }
  if (promptExpired(prompt, now.value)) {
    // Silence is not a refusal: the PC may simply not have reached it yet, so
    // say what is known rather than implying something went wrong.
    return { label: 'no word from the PC yet', tone: 'expired' };
  }
  return { label: 'sent, awaiting acknowledgement', tone: 'pending' };
}

async function submit(): Promise<void> {
  if (!canSend.value || sending.value) return;
  sending.value = true;
  notice.value = null;
  try {
    const outcome = await sendPrompt(text.value);
    if (outcome.ok) {
      text.value = '';
      notice.value = {
        kind: 'ok',
        message: 'Written to relay-in. Delivery is only confirmed when the PC reports it back.',
      };
    } else {
      notice.value = { kind: 'error', message: outcome.error };
    }
  } finally {
    sending.value = false;
  }
}
</script>

<template>
  <section class="composer">
    <!-- Refusing to draw a text box is the point: a prompt written into a relay
         nobody reads looks exactly like one that worked. -->
    <div v-if="ended" class="gate">
      <p class="gate-kind">ended</p>
      <p class="gate-text">
        This session is over. Anything written for it now has nothing on the other end to run it.
      </p>
    </div>

    <div v-else-if="!controllable" class="gate">
      <p class="gate-kind">read-only</p>
      <p class="gate-text">
        This session is being watched, not driven. Start it with <code>ccr</code> on the PC to be
        able to send prompts to it.
      </p>
    </div>

    <div v-else-if="!injectionEnabled" class="gate">
      <p class="gate-kind">prompts are off on the PC</p>
      <p class="gate-text">
        This session can be watched but not driven. Set <code>CCR_ALLOW_INJECTION=true</code> on the
        PC to change that.
      </p>
    </div>

    <template v-else>
      <textarea
        v-model="text"
        rows="2"
        placeholder="Write a prompt for this session"
        aria-label="Prompt"
        :disabled="sending"
        @keydown.ctrl.enter.prevent="submit"
      ></textarea>

      <p v-if="blockedReason" class="cond fault">{{ blockedReason }}</p>
      <p v-else-if="tooLong" class="cond fault">
        That is {{ byteLength }} bytes and the PC refuses anything over {{ MAX_PROMPT_BYTES }}.
      </p>

      <div class="send-row">
        <!-- A live counter, aligned, because the limit is real and it ticks. -->
        <span class="meter mono" :class="{ over: tooLong }">
          {{ byteLength }}<span class="of">/{{ MAX_PROMPT_BYTES }}</span>
        </span>
        <button class="btn btn-primary send" type="button" :disabled="!canSend || sending" @click="submit">
          {{ sending ? 'Sending…' : 'Send' }}
        </button>
      </div>

      <p v-if="notice" class="cond" :class="notice.kind === 'error' ? 'fault' : 'ok'">
        {{ notice.message }}
      </p>
    </template>

    <div v-if="outbound.length > 0" class="history">
      <!-- The same on/off vocabulary the record's own toggle uses, so the two
           controls in this app read as the same kind of thing. -->
      <button
        class="history-toggle"
        type="button"
        :aria-expanded="showHistory"
        @click="showHistory = !showHistory"
      >
        sent from this phone {{ showHistory ? 'on' : 'off' }}
      </button>

      <ul v-if="showHistory">
        <li v-for="prompt in outbound" :key="prompt.promptId" :class="`st-${statusLabel(prompt).tone}`">
          <p class="line1">
            <span class="state">{{ statusLabel(prompt).label }}</span>
            <span class="stamp">{{ relativeTime(prompt.ts, now) }}</span>
          </p>
          <p class="text">{{ prompt.text }}</p>
          <p v-if="statusLabel(prompt).tone === 'expired'" class="hint">
            Prompts are refused when they are more than ten minutes old, so this one was probably
            never picked up. Check the PC is running with <code>ccr</code>.
          </p>
        </li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
.composer {
  /* Pinned to the foot of the session screen. Everything above it scrolls; this
     does not, because having to reach the bottom of a long transcript before you
     can type into it is the thing being fixed here. */
  position: sticky;
  bottom: 0;
  z-index: 5;
  display: flex;
  flex-direction: column;
  gap: 10px;
  /* Bleeds to the edges, so the record cannot be seen past it while it scrolls
     underneath. */
  margin: 24px calc(var(--page-pad) * -1) 0;
  padding: 10px var(--page-pad) calc(10px + env(safe-area-inset-bottom, 0px));
  background: var(--plate);
  border-top: 1px solid var(--rule-strong);
}

.composer textarea {
  /* A long prompt scrolls inside the box rather than pushing the record off the
     screen above it. */
  max-height: 30dvh;
  resize: none;
}

/* --- gates ---------------------------------------------------------------- */

.gate {
  padding-left: 10px;
  border-left: 2px solid var(--rule-strong);
  max-width: var(--measure);
}

.gate-kind {
  margin: 0;
  font-family: var(--mono);
  font-size: 10px;
  color: var(--ink-2);
}

.gate-text {
  margin: 2px 0 0;
  font-size: 14px;
  line-height: 1.5;
  color: var(--ink-2);
}

.gate-text code {
  color: var(--ink);
}

/* --- sending -------------------------------------------------------------- */

.send-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.meter {
  font-size: 12px;
  color: var(--ink-2);
}

.meter .of {
  opacity: 0.6;
}

.meter.over {
  color: var(--fault);
}

.send {
  margin-left: auto;
  min-width: 108px;
}

.cond {
  margin: 0;
  padding-left: 10px;
  border-left: 2px solid var(--rule-strong);
  font-size: 13px;
  line-height: 1.5;
  color: var(--ink-2);
  max-width: var(--measure);
}

.cond.fault {
  border-left-color: var(--fault);
  color: var(--fault);
}

.cond.ok {
  border-left-color: var(--ink-2);
  color: var(--ink);
}

/* --- what we have sent ---------------------------------------------------- */

.history {
  border-top: 1px solid var(--rule);
  padding-top: 8px;
}

.history-toggle {
  padding: 0;
  border: none;
  background: none;
  color: var(--ink-2);
  font-family: var(--mono);
  font-size: 10px;
  cursor: pointer;
}

.history-toggle:hover {
  color: var(--ink);
}

.history ul {
  list-style: none;
  margin: 10px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  /* Bounded too: opening the history must not be able to fill the screen
     either, or the pinning buys nothing. */
  max-height: 40dvh;
  overflow-y: auto;
}

.history li {
  padding-left: 10px;
  border-left: 2px solid var(--rule-strong);
  max-width: var(--measure);
}

.line1 {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin: 0;
}

.state {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--ink-2);
}

.stamp {
  margin-left: auto;
  font-family: var(--mono);
  font-size: 10px;
  color: var(--ink-2);
  white-space: nowrap;
}

/* State is the word first; the rule colour only backs it up. */
.st-delivered {
  border-left-color: var(--ink);
}

.st-delivered .state {
  color: var(--ink);
}

.st-accepted,
.st-queued {
  border-left-color: var(--ink-2);
}

.st-dropped,
.st-rejected,
.st-expired {
  border-left-color: var(--fault);
}

.st-dropped .state,
.st-rejected .state,
.st-expired .state {
  color: var(--fault);
}

.text {
  margin: 3px 0 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--ink-2);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 5em;
  overflow: hidden;
}

.hint {
  margin: 6px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--fault);
}
</style>
