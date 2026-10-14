/**
 * Keeping the newest message in view, without taking the screen away from anyone.
 *
 * The chat reads oldest to newest, so the end of it is the bottom — which means
 * a session has to be scrolled there on open, or it lands on last week's first
 * prompt. That part is unconditional.
 *
 * New arrivals are not. A session that is working produces events every few
 * seconds, and scrolling to the bottom on each of them would yank the screen out
 * from under someone reading back through the record — repeatedly, and with no
 * way to stop it. So a new event only follows the reader if the reader was
 * already at the end; anyone who has scrolled up stays where they put themselves.
 *
 * The scroller is not the chat's own element. The page's single scrolling box is
 * what lets the composer stay pinned to the foot of the screen, so this climbs
 * to whatever ancestor actually scrolls rather than adding a second viewport
 * inside the first.
 */

import { nextTick } from 'vue';

/** How close to the end still counts as reading the end. */
const STICK_SLACK_PX = 80;

export interface StickyScroller {
  /** Put the end of the content in view. */
  toEnd(behavior?: ScrollBehavior): void;
  /** Whether the reader is at the end, within the slack. */
  atEnd(): boolean;
  /**
   * Run a change that grows the content **above** the viewport without moving
   * the reader.
   *
   * Asking for older messages prepends a page of history. Left alone the browser
   * keeps `scrollTop` where it was, which after an insertion above is a different
   * place in the conversation — the reader is thrown forward by exactly the
   * height they just asked for.
   */
  preservingPosition(mutate: () => void): void;
  /** Forget the element, so a stale one is never scrolled. */
  release(): void;
}

/** The nearest ancestor that actually scrolls, or null if there is none. */
function scrollingAncestor(from: HTMLElement | null): HTMLElement | null {
  let node: HTMLElement | null = from?.parentElement ?? null;
  while (node !== null) {
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === 'auto' || overflow === 'scroll') return node;
    node = node.parentElement;
  }
  return null;
}

export function stickyScroller(element: HTMLElement | null): StickyScroller {
  let scroller: HTMLElement | null = element === null ? null : scrollingAncestor(element);

  return {
    toEnd(behavior: ScrollBehavior = 'auto'): void {
      scroller?.scrollTo({ top: scroller.scrollHeight, behavior });
    },

    atEnd(): boolean {
      if (scroller === null) return true;
      const remaining = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
      return remaining <= STICK_SLACK_PX;
    },

    preservingPosition(mutate: () => void): void {
      const box = scroller;
      if (box === null) {
        mutate();
        return;
      }

      const height = box.scrollHeight;
      const top = box.scrollTop;
      mutate();

      void nextTick(() => {
        const grown = box.scrollHeight - height;
        if (grown > 0) box.scrollTop = top + grown;
      });
    },

    release(): void {
      scroller = null;
    },
  };
}
