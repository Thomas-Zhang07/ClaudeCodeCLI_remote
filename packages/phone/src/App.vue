<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';

import { blobCache } from '@/lib/cache';
import { isConfigured } from '@/lib/settings';
import { closeSession, openSession, relay, startPolling, stopPolling } from '@/stores/relay';

import ConnectionBar from './components/ConnectionBar.vue';
import SessionDetail from './components/SessionDetail.vue';
import SessionList from './components/SessionList.vue';
import SettingsScreen from './components/SettingsScreen.vue';

type View = 'list' | 'detail' | 'settings';

const view = ref<View>('list');
/** True once an auth failure has already bounced the user to Settings. */
const authRedirected = ref(false);

// A phone with no configuration has exactly one useful screen.
const effectiveView = computed<View>(() => (isConfigured.value ? view.value : 'settings'));

/**
 * The session lives in the URL hash so the Android back gesture and a reload
 * both land where the user was, instead of dumping them on the list.
 */
function sessionFromHash(): string | null {
  const match = /^#\/s\/(.+)$/.exec(location.hash);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function syncHash(): void {
  const wanted = view.value === 'detail' && relay.activeSessionId ? `#/s/${encodeURIComponent(relay.activeSessionId)}` : '';
  if (location.hash !== wanted) {
    // `replaceState` keeps the back gesture for the app, not for hash churn.
    history.replaceState(null, '', `${location.pathname}${location.search}${wanted}`);
  }
}

async function showList(): Promise<void> {
  view.value = 'list';
  if (relay.activeSessionId) closeSession();
  syncHash();
}

async function showSession(sessionId: string): Promise<void> {
  view.value = 'detail';
  syncHash();
  await openSession(sessionId);
}

function toggleSettings(): void {
  if (view.value === 'settings') void showList();
  else view.value = 'settings';
}

watch(
  () => relay.phase,
  (phase) => {
    if (phase === 'ready') {
      authRedirected.value = false;
      return;
    }
    // A rejected token is only fixable in Settings; do it once, not on every
    // failed poll, or the user cannot stay on the list.
    if (phase === 'error' && relay.errorKind === 'auth' && !authRedirected.value) {
      authRedirected.value = true;
      view.value = 'settings';
    }
  },
);

function onHashChange(): void {
  const sessionId = sessionFromHash();
  if (sessionId && sessionId !== relay.activeSessionId) void showSession(sessionId);
  else if (!sessionId && view.value === 'detail') void showList();
}

function flushCache(): void {
  blobCache.flush();
}

onMounted(() => {
  window.addEventListener('hashchange', onHashChange);
  window.addEventListener('pagehide', flushCache);
  startPolling();

  // A reload (or a shared link) lands back on the same session.
  const initial = sessionFromHash();
  if (initial) void showSession(initial);
});

onUnmounted(() => {
  stopPolling();
  window.removeEventListener('hashchange', onHashChange);
  window.removeEventListener('pagehide', flushCache);
  flushCache();
});
</script>

<template>
  <div class="app">
    <header class="topbar">
      <h1 class="brand">CC Remote</h1>
      <button class="settings-btn" type="button" @click="toggleSettings">
        {{ view === 'settings' ? 'Close' : 'Settings' }}
      </button>
    </header>

    <ConnectionBar />

    <main class="content">
      <SettingsScreen v-if="effectiveView === 'settings'" @done="showList" />

      <SessionDetail
        v-else-if="effectiveView === 'detail' && relay.activeSessionId"
        :session-id="relay.activeSessionId"
        @back="showList"
      />

      <SessionList v-else @open="showSession" />
    </main>

    <p class="footnote muted">
      Read-only monitoring needs nothing configured on this phone beyond the token.
      <span v-if="relay.index">Updated {{ relay.index.generatedAt }}</span>
    </p>
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
}

.topbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px calc(10px + env(safe-area-inset-top, 0px));
  background: var(--surface);
}

.brand {
  font-size: 16px;
  margin: 0;
  letter-spacing: 0.02em;
}

.settings-btn {
  margin-left: auto;
  min-height: 36px;
  padding: 6px 12px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--surface-2);
  font-size: 13px;
  cursor: pointer;
}

.content {
  flex: 1;
  padding: 14px;
  max-width: 720px;
  width: 100%;
  margin: 0 auto;
  min-width: 0;
}

.footnote {
  font-size: 11px;
  text-align: center;
  padding: 8px 14px calc(12px + env(safe-area-inset-bottom, 0px));
  margin: 0;
  overflow-wrap: anywhere;
}
</style>
