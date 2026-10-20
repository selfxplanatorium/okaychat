import { useEffect, useRef } from "react";
import { flushSync } from "react-dom";

/** Distance from the left screen edge that starts an open gesture. */
const EDGE = 28;
/** Movement before a touch counts as a horizontal drag rather than a scroll. */
const SLOP = 8;
/** px/ms. A flick faster than this decides the direction regardless of distance. */
const FLICK = 0.35;
const MOBILE = "(max-width: 767px)";

/**
 * Phone drawer gestures: swipe in from the left edge to open, swipe the open
 * drawer (or its backdrop) left to close. The drawer follows the finger, then
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
      const target = event.target as Node;
      if (state.current.open ? !drawer.contains(target) && !scrim?.contains(target) : touch.clientX > EDGE) return;
      gesture = { x: touch.clientX, y: touch.clientY, width: drawer.offsetWidth, dragging: false, lastX: touch.clientX, lastT: event.timeStamp, velocity: 0, offset: 0 };
    };

    const onMove = (event: TouchEvent) => {
      if (!gesture) return;
      const touch = event.touches[0]!;
      const dx = touch.clientX - gesture.x;
      const dy = touch.clientY - gesture.y;
      if (!gesture.dragging) {
        if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
        // Vertical movement is a scroll; the wrong direction is not this gesture.
        if (Math.abs(dy) > Math.abs(dx) || (state.current.open ? dx > 0 : dx < 0)) {
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

    document.addEventListener("touchstart", onStart, { passive: true });
    document.addEventListener("touchmove", onMove, { passive: false });
    document.addEventListener("touchend", onEnd);
    document.addEventListener("touchcancel", onEnd);
    return () => {
      document.removeEventListener("touchstart", onStart);
      document.removeEventListener("touchmove", onMove);
      document.removeEventListener("touchend", onEnd);
      document.removeEventListener("touchcancel", onEnd);
      release();
    };
  }, [enabled]);
}
