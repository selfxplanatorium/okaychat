import { useEffect, useRef } from "react";
import { flushSync } from "react-dom";

/** Movement before a touch counts as a horizontal drag rather than a scroll. */
const SLOP = 8;
/** px/ms. A flick faster than this decides the direction regardless of distance. */
const FLICK = 0.35;
const MOBILE = "(max-width: 767px)";

/** Touches that belong to the element under the finger, not to the drawer. */
const OWN_GESTURE = 'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="slider"], [role="dialog"], [role="menu"], [role="listbox"], .shell-artifact, [data-no-drawer-swipe]';

/** True when something under the finger would scroll left, so a swipe right is its scroll. */
function scrollsLeft(target: Element | null) {
  for (let el = target; el && el !== document.body; el = el.parentElement) {
    if (el.scrollLeft > 0 && el.scrollWidth > el.clientWidth) {
      const overflow = getComputedStyle(el).overflowX;
      if (overflow === "auto" || overflow === "scroll") return true;
    }
  }
  return false;
}

/**
 * Phone drawer gestures: swipe right anywhere on the page to open, like a native
 * app, and swipe the open drawer (or its backdrop) left to close. Fields, open
 * popups, the artifact panel, and content that can still scroll left keep their
 * own touches. The drawer follows the finger, then
 * settles by flick velocity or by whether it passed halfway. During the drag
 * inline styles override the open/closed classes; on release React commits the
 * new state first, then the inline styles are dropped so the class transition
 * carries the drawer the rest of the way from where the finger left it.
 */
export function useDrawerSwipe(open: boolean, setOpen: (open: boolean) => void, enabled: boolean) {
  const state = useRef({ open, setOpen });
  state.current = { open, setOpen };

  useEffect(() => {
    if (!enabled) return;
    const parts = () => ({
      drawer: document.querySelector<HTMLElement>(".shell-sidebar"),
      inner: document.querySelector<HTMLElement>(".shell-sidebar-inner"),
      scrim: document.querySelector<HTMLElement>(".shell-scrim"),
    });
    let gesture: { x: number; y: number; width: number; dragging: boolean; lastX: number; lastT: number; velocity: number; offset: number } | null = null;

    const paint = (offset: number, width: number) => {
      const { drawer, inner, scrim } = parts();
      if (!drawer || !inner || !scrim) return;
      for (const el of [drawer, inner, scrim]) el.style.transition = "none";
      drawer.style.translate = `${offset}px 0`;
      drawer.style.visibility = "visible";
      inner.style.opacity = "1";
      inner.style.transform = "none";
      scrim.style.opacity = String(1 + offset / width);
    };
    const release = () => {
      const { drawer, inner, scrim } = parts();
      for (const el of [drawer, inner, scrim]) el?.removeAttribute("style");
    };

    const onStart = (event: TouchEvent) => {
      if (event.touches.length !== 1 || !window.matchMedia(MOBILE).matches) return;
      const touch = event.touches[0]!;
      const { drawer, scrim } = parts();
      if (!drawer) return;
      const target = event.target as Element;
      if (state.current.open) {
        if (!drawer.contains(target) && !scrim?.contains(target)) return;
      } else if (target.closest?.(OWN_GESTURE) || scrollsLeft(target) || !document.getSelection()?.isCollapsed) {
        return;
      }
      gesture = { x: touch.clientX, y: touch.clientY, width: drawer.offsetWidth, dragging: false, lastX: touch.clientX, lastT: event.timeStamp, velocity: 0, offset: 0 };
    };

    const onMove = (event: TouchEvent) => {
      if (!gesture) return;
      const touch = event.touches[0]!;
      const dx = touch.clientX - gesture.x;
      const dy = touch.clientY - gesture.y;
      if (!gesture.dragging) {
        if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
        // Vertical movement is a scroll; the wrong direction is not this gesture. A move
        // that is no longer cancelable means the browser already started scrolling.
        if (Math.abs(dy) > Math.abs(dx) || (state.current.open ? dx > 0 : dx < 0) || !event.cancelable) {
          gesture = null;
          return;
        }
        gesture.dragging = true;
      }
      event.preventDefault();
      const dt = event.timeStamp - gesture.lastT;
      if (dt > 0) gesture.velocity = (touch.clientX - gesture.lastX) / dt;
      gesture.lastX = touch.clientX;
      gesture.lastT = event.timeStamp;
      const base = state.current.open ? 0 : -gesture.width;
      gesture.offset = Math.min(0, Math.max(-gesture.width, base + dx));
      paint(gesture.offset, gesture.width);
    };

    const onEnd = () => {
      const current = gesture;
      gesture = null;
      if (!current?.dragging) return;
      const next = current.velocity > FLICK ? true : current.velocity < -FLICK ? false : current.offset > -current.width / 2;
      flushSync(() => state.current.setOpen(next));
      release();
    };

    // Capture phase: Base UI's context-menu trigger (thread rows) stops touchstart from bubbling.
    document.addEventListener("touchstart", onStart, { passive: true, capture: true });
    document.addEventListener("touchmove", onMove, { passive: false, capture: true });
    document.addEventListener("touchend", onEnd, true);
    document.addEventListener("touchcancel", onEnd, true);
    return () => {
      document.removeEventListener("touchstart", onStart, true);
      document.removeEventListener("touchmove", onMove, true);
      document.removeEventListener("touchend", onEnd, true);
      document.removeEventListener("touchcancel", onEnd, true);
      release();
    };
  }, [enabled]);
}
