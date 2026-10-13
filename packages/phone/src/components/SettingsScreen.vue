<script setup lang="ts">
import { computed, ref } from 'vue';

import { blobCache } from '@/lib/cache';
import { webCryptoAvailable } from '@/lib/hmac';
import { useNow } from '@/lib/now';
import { POLL_MAX_MS, POLL_MIN_MS, clearSettings, saveSettings, settings } from '@/lib/settings';
import { refreshNow, relay, onSettingsChanged, throttledForMs } from '@/stores/relay';

const now = useNow(1000);
const owner = ref(settings.owner);
const repo = ref(settings.repo);
const token = ref(settings.token);
const secret = ref(settings.secret);
const pollSeconds = ref(Math.round(settings.pollMs / 1000));
const saved = ref(false);
const showToken = ref(false);

const dirty = computed(
  () =>
    owner.value !== settings.owner ||
    repo.value !== settings.repo ||
    token.value !== settings.token ||
    secret.value !== settings.secret ||
    Math.round(pollSeconds.value * 1000) !== settings.pollMs,
);

const cacheLabel = computed(() => `${blobCache.size} files (${Math.round(blobCache.approxBytes / 1024)} KB)`);
const backoff = computed(() => throttledForMs(now.value));
const cryptoOk = webCryptoAvailable();

function save(): void {
  saveSettings({
    owner: owner.value,
    repo: repo.value,
    token: token.value,
    secret: secret.value,
    pollMs: Math.round(pollSeconds.value * 1000),
  });
  saved.value = true;
  onSettingsChanged();
  void refreshNow();
}

function reset(): void {
  clearSettings();
  owner.value = '';
  repo.value = '';
  token.value = '';
  secret.value = '';
  onSettingsChanged();
}

function clearCache(): void {
  blobCache.clear();
}
</script>

<template>
  <div class="settings">
    <header class="ident">
      <h1>Settings</h1>
      <p class="where">This phone reads the relay repository and nothing else.</p>
    </header>

    <!-- Loud by structure rather than by hue: the token is a shell on the PC,
         and that deserves weight, not a colour that means something else. -->
    <section class="caution">
      <h2>Before you paste a token</h2>
      <ul>
        <li>
          <strong>This token can write to the repository.</strong> Anyone holding it can read the
          relay and push to it.
        </li>
        <li>
          <strong>A prompt written there runs as a command on the PC.</strong> The bridge injects it
          straight into a Claude Code session, so treat repo write access as equivalent to shell
          access on that machine. The signature only proves the prompt came from someone holding the
          shared secret. It is not a sandbox.
        </li>
        <li>
          Scope the token to this one private repository, and give it the narrowest permissions that
          work.
        </li>
        <li>Rotate the token and the shared secret immediately if this phone is lost.</li>
        <li>Prefer a private repository: relay files are readable by anyone with repo access.</li>
      </ul>
    </section>

    <section v-if="!cryptoOk" class="cond fault">
      <p class="cond-kind">insecure origin</p>
      <p class="cond-text">
        Web Crypto is unavailable here, so prompts cannot be signed or verified and chunks cannot be
        checksummed. Serve this app over https://, or open it on localhost, to enable sending.
      </p>
    </section>

    <section class="form">
      <label>
        <span>Owner</span>
        <input v-model="owner" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="gitee username" />
      </label>

      <label>
        <span>Repository</span>
        <input v-model="repo" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="relay repo name" />
      </label>

      <label>
        <span>Access token</span>
        <input
          v-model="token"
          :type="showToken ? 'text' : 'password'"
          autocapitalize="off"
          autocorrect="off"
          spellcheck="false"
          placeholder="personal access token"
        />
      </label>
      <button class="reveal" type="button" @click="showToken = !showToken">
        {{ showToken ? 'Hide token' : 'Show token' }}
      </button>

      <label>
        <span>Shared secret, the PC's <code>CCR_SECRET</code></span>
        <input
          v-model="secret"
          type="password"
          autocapitalize="off"
          autocorrect="off"
          spellcheck="false"
          placeholder="must match the PC exactly"
        />
      </label>

      <label>
        <span>Active session poll interval, every {{ pollSeconds }}s</span>
        <input
          v-model.number="pollSeconds"
          type="range"
          :min="POLL_MIN_MS / 1000"
          :max="POLL_MAX_MS / 1000"
          step="5"
        />
      </label>

      <p class="note">
        How often a session that is working has its head polled. The session list, and any idle
        session, are polled every 60s, and polling stops entirely while the app is in the background.
        The bridge publishes on turn boundaries, so faster polling mostly returns unchanged files,
        which still cost Gitee quota.
      </p>

      <button class="btn btn-primary save" type="button" :disabled="!dirty" @click="save">
        {{ dirty ? 'Save' : 'Saved' }}
      </button>

      <p v-if="saved && !dirty" class="note">Saved. The relay is being re-read now.</p>
      <p v-if="!blobCache.persisted" class="cond fault">
        The local cache could not be written, most likely private browsing or a full disk. The app
        still works; it just re-fetches everything after a reload.
      </p>
    </section>

    <section class="status">
      <h2>Relay</h2>
      <dl>
        <div>
          <dt>sessions published</dt>
          <dd>{{ relay.index ? relay.index.sessions.length : relay.empty ? 0 : '—' }}</dd>
        </div>
        <div>
          <dt>last successful read</dt>
          <dd>{{ relay.lastSuccessAt ? new Date(relay.lastSuccessAt).toLocaleTimeString() : 'never' }}</dd>
        </div>
        <div>
          <dt>last attempt</dt>
          <dd>{{ relay.lastPollAt ? new Date(relay.lastPollAt).toLocaleTimeString() : 'never' }}</dd>
        </div>
        <div>
          <dt>files held on this phone</dt>
          <dd>{{ cacheLabel }}</dd>
        </div>
      </dl>

      <p v-if="backoff > 0" class="cond fault">
        Gitee is throttling this phone. Next attempt in {{ Math.ceil(backoff / 1000) }}s.
        <template v-if="relay.error">Last error: {{ relay.error }}</template>
      </p>
      <p v-else-if="relay.error" class="cond fault">{{ relay.error }}</p>

      <div class="actions">
        <button class="btn" type="button" @click="clearCache">Clear the cache</button>
        <button class="btn" type="button" @click="reset">Forget everything</button>
      </div>
      <p class="note">
        Clearing the cache re-fetches every chunk on the next read. Forgetting everything also drops
        the token and the shared secret.
      </p>
    </section>
  </div>
</template>

<style scoped>
.settings {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.ident {
  padding: 16px 0 0;
}

h1 {
  margin: 0;
  font-size: 21px;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.where {
  margin: 5px 0 0;
  font-size: 13px;
  color: var(--ink-2);
}

h2 {
  margin: 0 0 6px;
  font-family: var(--mono);
  font-size: 10px;
  font-weight: 400;
  color: var(--ink-2);
}

/* --- the caution ---------------------------------------------------------- */

.caution {
  margin: 16px 0 0;
  padding: 12px 12px 14px;
  background: var(--plate);
  border-left: 3px solid var(--ink);
}

.caution h2 {
  color: var(--ink);
  font-family: var(--sans);
  font-size: 15px;
  font-weight: 600;
  margin-bottom: 8px;
}

.caution ul {
  margin: 0;
  padding-left: 16px;
  display: flex;
  flex-direction: column;
  gap: 7px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--ink-2);
  max-width: var(--measure);
}

.caution strong {
  color: var(--ink);
  font-weight: 600;
}

/* --- form ----------------------------------------------------------------- */

.form {
  display: flex;
  flex-direction: column;
  gap: 14px;
  margin-top: 24px;
  padding-top: 14px;
  border-top: 1px solid var(--rule-strong);
}

label {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

label > span {
  font-size: 12px;
  color: var(--ink-2);
}

label > span code {
  color: var(--ink);
}

input[type='range'] {
  accent-color: var(--ink);
  padding: 0;
  border: none;
  background: none;
  min-height: var(--tap);
}

.reveal {
  align-self: flex-start;
  min-height: var(--tap);
  margin-top: -12px;
  padding: 0;
  border: none;
  border-bottom: 1px solid var(--rule-strong);
  background: none;
  color: var(--ink-2);
  font-family: var(--mono);
  font-size: 11px;
  cursor: pointer;
}

.reveal:hover {
  color: var(--ink);
}

.save {
  align-self: flex-start;
  min-width: 120px;
  margin-top: 2px;
}

.note {
  margin: 0;
  max-width: var(--measure);
  font-size: 12px;
  line-height: 1.55;
  color: var(--ink-2);
}

.cond {
  margin: 0;
  padding-left: 10px;
  border-left: 2px solid var(--rule-strong);
  max-width: var(--measure);
  font-size: 13px;
  line-height: 1.5;
  color: var(--ink-2);
}

.cond.fault {
  border-left-color: var(--fault);
  color: var(--fault);
}

/* --- readout -------------------------------------------------------------- */

.status {
  margin-top: 24px;
  padding-top: 14px;
  border-top: 1px solid var(--rule-strong);
}

dl {
  margin: 0;
}

dl > div {
  display: flex;
  align-items: baseline;
  gap: 12px;
  padding: 6px 0;
  border-top: 1px solid var(--rule);
}

dt {
  font-size: 12px;
  color: var(--ink-2);
}

dd {
  margin: 0 0 0 auto;
  font-family: var(--mono);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--ink);
  text-align: right;
  overflow-wrap: anywhere;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 14px 0 10px;
}
</style>
