<script setup lang="ts">
import { computed, ref } from 'vue';

import { relativeTime } from '@/lib/format';
import { webCryptoAvailable } from '@/lib/hmac';
import { useNow } from '@/lib/now';
import { canSign } from '@/lib/settings';
import { MAX_PROMPT_BYTES, outboundFor, promptExpired, sendPrompt } from '@/stores/relay';
import type { OutboundPrompt } from '@/types';

const props = defineProps<{ sessionId: string; controllable: boolean }>();

const now = useNow(15_000);
const text = ref('');
const sending = ref(false);
const notice = ref<{ kind: 'ok' | 'error'; message: string } | null>(null);
const cryptoReady = webCryptoAvailable();

const outbound = computed<OutboundPrompt[]>(() => outboundFor(props.sessionId));

const byteLength = computed(() => new TextEncoder().encode(text.value.trim()).length);
const tooLong = computed(() => byteLength.value > MAX_PROMPT_BYTES);

const blockedReason = computed<string | null>(() => {
  if (!props.controllable) return null; // handled by the read-only notice
  if (!canSign.value) return 'Add the shared secret in Settings before sending.';
  if (!cryptoReady) {
    return 'Web Crypto is unavailable here, so prompts cannot be signed. Open the app over https:// (or localhost).';
  }
  return null;
});

const canSend = computed(
  () => props.controllable && blockedReason.value === null && text.value.trim() !== '' && !tooLong.value,
);

function statusLabel(prompt: OutboundPrompt): { label: string; tone: string } {
  if (prompt.acknowledged) {
    return { label: prompt.acknowledged, tone: prompt.acknowledged };
  }
  if (promptExpired(prompt, now.value)) {
    return { label: 'no acknowledgement seen', tone: 'expired' };
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
  <section class="card composer">
    <h2>Prompt</h2>

    <p v-if="!controllable" class="readonly">
      Read-only session — start it with <code>ccr</code> on the PC to send prompts.
    </p>

    <template v-else>
      <textarea
        v-model="text"
        rows="3"
        placeholder="Send a prompt to this session…"
        :disabled="sending"
        @keydown.ctrl.enter.prevent="submit"
      ></textarea>

      <p v-if="blockedReason" class="warn">{{ blockedReason }}</p>
      <p v-else-if="tooLong" class="warn">
        {{ byteLength }} bytes — the PC refuses anything over {{ MAX_PROMPT_BYTES }}.
      </p>

      <button class="btn btn-primary send" type="button" :disabled="!canSend || sending" @click="submit">
        {{ sending ? 'Sending…' : 'Send' }}
      </button>

      <p v-if="notice" class="notice" :class="notice.kind">{{ notice.message }}</p>
    </template>

    <div v-if="outbound.length > 0" class="outbound">
      <h3>Sent from this phone</h3>
      <ul>
        <li v-for="prompt in outbound" :key="prompt.promptId">
          <div class="meta">
            <span class="state" :class="statusLabel(prompt).tone">{{ statusLabel(prompt).label }}</span>
            <span class="time">{{ relativeTime(prompt.ts, now) }}</span>
          </div>
          <p class="text">{{ prompt.text }}</p>
          <p v-if="statusLabel(prompt).tone === 'expired'" class="hint">
            Prompts are refused when they are more than 10 minutes old, so this one was probably
            never picked up. Check the PC is running with <code>ccr</code>.
          </p>
        </li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
.composer {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

h2 {
  font-size: 13px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--muted);
  margin: 0;
}

.readonly {
  margin: 0;
  font-size: 13px;
  color: var(--muted);
}

.send {
  align-self: flex-end;
  min-width: 120px;
}

.warn {
  margin: 0;
  font-size: 13px;
  color: var(--wait);
}

.notice {
  margin: 0;
  font-size: 13px;
}

.notice.ok {
  color: var(--accent);
}

.notice.error {
  color: var(--danger);
}

.outbound {
  border-top: 1px solid var(--border);
  padding-top: 8px;
}

h3 {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--muted);
  margin: 0 0 6px;
}

.outbound ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.outbound li {
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 8px 10px;
}

.meta {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.state {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
}

.state.pending {
  color: var(--muted);
}

.state.accepted,
.state.queued {
  color: var(--info);
}

.state.delivered {
  color: var(--accent);
}

.state.dropped,
.state.rejected,
.state.expired {
  color: var(--danger);
}

.time {
  margin-left: auto;
  font-size: 11px;
  color: var(--muted);
}

.text {
  margin: 4px 0 0;
  font-size: 13px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 4.5em;
  overflow: hidden;
}

.hint {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--wait);
}
</style>
