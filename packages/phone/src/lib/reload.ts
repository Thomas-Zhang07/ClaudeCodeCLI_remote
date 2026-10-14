/**
 * Getting the app itself, not just the app's data.
 *
 * The refresh button used to re-read the relay: it dropped the open session's
 * cached chunks and polled again. That is the right thing for new events and the
 * wrong thing for a new *build*, because the page being refreshed is the thing
 * that is out of date — and on an installed PWA it can be weeks out of date with
 * no way to tell.
 *
 * The reason is the service worker. `registerSW.js` registers `sw.js`, which
 * precaches `index.html` and every hashed asset and answers every navigation
 * from that precache. So a plain reload is served the *old* bundle by design.
 * The browser does notice the new `sw.js` on that navigation and installs it —
 * with `skipWaiting` and `clientsClaim`, so it takes over immediately — but the
 * page that is already loading came from the old cache. The new build arrives on
 * the *next* load. That is why refreshing appeared to do nothing, and why doing
 * it twice appeared to work.
 *
 * So this does two things in the order that matters:
 *
 *  1. **Ask the worker to update, and wait for the new one to take control.**
 *     Only when there is actually a new one — an unchanged `sw.js` means there is
 *     nothing to wait for, and waiting anyway would put a fixed delay in front of
 *     every refresh.
 *  2. **Reload.** At that point the new worker is the controller, so the reload
 *     is answered from the new precache.
 *
 * The relay data goes too, which is what makes this a refresh rather than a
 * restart: `blobCache` holds chunks keyed by a path the bridge may well have
 * rewritten, and its whole purpose is never being fetched twice.
 *
 * **Not** cleared: settings, and the prompts this phone has sent. The token and
 * the signing secret live in the same localStorage, and "refresh" must never
 * mean "sign me out and lose my prompts".
 */

import { blobCache } from './cache';

/** How long to let a new worker take over before reloading regardless. */
const CLAIM_TIMEOUT_MS = 4_000;

/**
 * Update the service worker, and wait only if there was something to update.
 *
 * Returns once the new worker controls this page, or once there was demonstrably
 * nothing new. A failure at any point is not fatal: the reload still happens,
 * and a build that could not be fetched this time will be picked up next time.
 */
async function updateWorker(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;

  try {
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) return;

    await registration.update();

    // `update()` resolving with neither of these set is the "already current"
    // answer, and by far the common one. Waiting for a `controllerchange` that
    // is never coming would cost every refresh four seconds.
    if (registration.installing === null && registration.waiting === null) return;

    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        navigator.serviceWorker.removeEventListener('controllerchange', done);
        resolve();
      };
      const timer = setTimeout(done, CLAIM_TIMEOUT_MS);
      navigator.serviceWorker.addEventListener('controllerchange', done);
    });
  } catch {
    // No worker, no network, private mode: none of these stop a reload.
  }
}

/**
 * Throw away what this device has cached, and load the app again.
 *
 * Never resolves: the page is gone before it could.
 */
export async function reloadApp(): Promise<void> {
  blobCache.clear();

  await updateWorker();

  globalThis.location.reload();
}
