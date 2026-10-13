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
    <!-- One strip of chrome, not two. What the machine is doing is the most
         useful thing to keep on screen, so it rides with the navigation. -->
    <header class="masthead">
      <button
        v-if="effectiveView === 'detail'"
        class="ghost back"
        type="button"
        aria-label="Back to sessions"
        @click="showList"
      >
        <span aria-hidden="true">‹</span>
      </button>
      <span v-else class="wordmark">cc remote</span>

      <ConnectionBar />

      <button class="ghost settings" type="button" :aria-pressed="effectiveView === 'settings'" @click="toggleSettings">
        {{ effectiveView === 'settings' ? 'close' : 'setup' }}
      </button>
    </header>

    <main class="content">
      <SettingsScreen v-if="effectiveView === 'settings'" />

      <SessionDetail v-else-if="effectiveView === 'detail' && relay.activeSessionId" :session-id="relay.activeSessionId" />

      <SessionList v-else @open="showSession" />
    </main>
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
}

.masthead {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: calc(2px + env(safe-area-inset-top, 0px)) 6px 2px;
  background: var(--plate);
  border-bottom: 1px solid var(--rule);
  position: sticky;
  top: 0;
  z-index: 10;
}

.wordmark {
  font-family: var(--mono);
  font-size: 12px;
  color: var(--ink-2);
  padding: 0 6px 0 8px;
  white-space: nowrap;
}

.back span {
  font-size: 22px;
  line-height: 1;
}

/* The connection bar takes the middle and absorbs the slack; the two controls
   at the ends are fixed. */
.masthead :deep(.bar) {
  flex: 1;
  min-width: 0;
  border-bottom: none;
  background: none;
  padding: 0;
}

.settings {
  font-size: 12px;
  font-family: var(--mono);
}

.content {
  flex: 1;
  padding: 0 var(--page-pad) 32px;
  max-width: 600px;
  width: 100%;
  margin: 0 auto;
  min-width: 0;
}
</style>
