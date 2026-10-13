/** A clock that ticks only while the page is visible, for relative times. */

import { onUnmounted, ref } from 'vue';

export function useNow(intervalMs = 15_000) {
  const now = ref(Date.now());

  const timer = setInterval(() => {
    if (!document.hidden) now.value = Date.now();
  }, intervalMs);

  const onVisibility = () => {
    if (!document.hidden) now.value = Date.now();
  };
  document.addEventListener('visibilitychange', onVisibility);

  onUnmounted(() => {
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onVisibility);
  });

  return now;
}
