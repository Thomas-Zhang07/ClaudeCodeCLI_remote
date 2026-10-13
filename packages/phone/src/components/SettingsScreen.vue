<script setup lang="ts">
import { computed, ref } from 'vue';

import { blobCache } from '@/lib/cache';
import { webCryptoAvailable } from '@/lib/hmac';
import { useNow } from '@/lib/now';
import {
  POLL_MAX_MS,
  POLL_MIN_MS,
  clearSettings,
  isConfigured,
  saveSettings,
  settings,
} from '@/lib/settings';
import { refreshNow, relay, onSettingsChanged, throttledForMs } from '@/stores/relay';

const emit = defineEmits<{ done: [] }>();

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
    <div class="head">
      <h1>Settings</h1>
      <button v-if="isConfigured" class="btn" type="button" @click="emit('done')">Done</button>
    </div>

    <section class="card warn-card">
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
          shared secret — it is not a sandbox.
        </li>
        <li>Scope the token to this one private repository, and give it the narrowest permissions that work.</li>
        <li>Rotate the token (and the shared secret) immediately if this phone is lost.</li>
        <li>Prefer a private repository: relay files are readable by anyone with repo access.</li>
      </ul>
    </section>

    <section v-if="!webCryptoAvailable()" class="card warn-card">
      <h2>Insecure origin</h2>
      <p class="muted">
        Web Crypto is unavailable here, so prompts cannot be signed or verified and chunks cannot be
        checksummed. Serve this app over https:// (or open it on localhost) to enable sending.
      </p>
    </section>

    <section class="card form">
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
        <span>Shared secret (CCR_SECRET on the PC)</span>
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
        <span>Poll interval — {{ pollSeconds }}s</span>
        <input v-model.number="pollSeconds" type="range" :min="POLL_MIN_MS / 1000" :max="POLL_MAX_MS / 1000" step="5" />
      </label>

      <p class="muted small">
        Polling is skipped while the app is in the background and resumes the moment it comes back.
        The steady-state cost is one request per poll; a 30s interval is a reasonable default on
        mobile data.
      </p>

      <button class="btn btn-primary" type="button" :disabled="!dirty" @click="save">
        {{ dirty ? 'Save' : 'Saved' }}
      </button>

      <p v-if="saved && !dirty" class="ok small">Saved.</p>
      <p v-if="!blobCache.persisted" class="warn small">
        The local cache could not be written (private browsing, or storage full). The app still
        works; it just re-fetches after a reload.
      </p>
    </section>

    <section class="card">
      <h2>Status</h2>
      <dl class="status">
        <div>
          <dt>Relay</dt>
          <dd>{{ relay.index ? `${relay.index.sessions.length} session(s)` : relay.empty ? 'empty' : '—' }}</dd>
        </div>
        <div>
          <dt>Last success</dt>
          <dd>{{ relay.lastSuccessAt ? new Date(relay.lastSuccessAt).toLocaleTimeString() : 'never' }}</dd>
        </div>
        <div>
          <dt>Branch head</dt>
          <dd class="mono">{{ relay.branchSha ? relay.branchSha.slice(0, 8) : '—' }}</dd>
        </div>
        <div>
          <dt>Cached files</dt>
          <dd>{{ cacheLabel }}</dd>
        </div>
      </dl>

      <p v-if="backoff > 0" class="warn small">
        Throttled by Gitee. Next attempt in {{ Math.ceil(backoff / 1000) }}s.
        <template v-if="relay.error">Last error: {{ relay.error }}</template>
      </p>
      <p v-else-if="relay.error" class="warn small">{{ relay.error }}</p>

      <div class="actions">
        <button class="btn" type="button" @click="clearCache">Clear cache</button>
        <button class="btn" type="button" @click="reset">Forget everything</button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.settings {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.head {
  display: flex;
  align-items: center;
}

h1 {
  font-size: 20px;
  margin: 0;
}

.head .btn {
  margin-left: auto;
}

h2 {
  font-size: 14px;
  margin: 0 0 6px;
}

.warn-card {
  border-color: color-mix(in srgb, var(--wait) 45%, var(--border));
  background: color-mix(in srgb, var(--wait) 8%, var(--surface));
}

.warn-card ul {
  margin: 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
}

.form {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

label {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

label > span {
  font-size: 12px;
  color: var(--muted);
}

.form .btn-primary {
  margin-top: 4px;
}

.reveal {
  align-self: flex-start;
  background: none;
  border: none;
  color: var(--accent);
  font-size: 13px;
  padding: 0;
  margin-top: -6px;
  min-height: 32px;
  cursor: pointer;
}

.small {
  font-size: 12px;
  margin: 0;
}

.ok {
  color: var(--accent);
}

.warn {
  color: var(--wait);
}

.status {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px 12px;
  margin: 0;
}

dt {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--muted);
}

dd {
  margin: 2px 0 0;
  font-size: 13px;
  overflow-wrap: anywhere;
}

dd.mono {
  font-family: var(--mono);
}

.actions {
  display: flex;
  gap: 8px;
  margin-top: 12px;
  flex-wrap: wrap;
}
</style>
