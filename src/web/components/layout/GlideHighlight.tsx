import { useLayoutEffect, useRef } from "react";

const SELECTED = '[data-glide]:is([data-active], [aria-current="page"])';
const switches = new WeakMap<HTMLElement, (row: HTMLElement, action: () => unknown) => void>();

/** Start the card before chat rendering, and give the browser a paint to start its compositor transition. */
export function switchWithHighlight(trigger: HTMLElement, action: () => unknown) {
  const host = trigger.closest<HTMLElement>(".glide-host");
  const row = trigger.closest<HTMLElement>("[data-glide]");
  const start = host && switches.get(host);
  if (start && row) start(row, action);
  else action();
}

/**
 * The row's layout position inside the host. Offsets ignore transforms, so a row still running its
 * entry animation (a pinned chat remounts in the Pinned group) is measured where it will settle.
 */
function layoutOffset(row: HTMLElement, host: HTMLElement) {
  let x = 0;
  let y = 0;
  let node: Element | null = row;
  while (node instanceof HTMLElement && node !== host) {
    x += node.offsetLeft;
    y += node.offsetTop;
    node = node.offsetParent;
  }
  if (node === host) return { x, y };
  const hostBox = host.getBoundingClientRect();
  const box = row.getBoundingClientRect();
  return { x: box.left - hostBox.left + host.scrollLeft, y: box.top - hostBox.top + host.scrollTop };
}

/**
 * One raised card that slides to whichever row is selected, so a selection
 * change reads as the card moving rather than one row losing its card and
 * another gaining it. Render it as the first child of a positioned host marked
 * `glide-host`; rows opt in with `data-glide` and paint above it. The rows'
 * own selected background is suppressed in shell.css, so the card is the only
 * selected surface. Selection state itself stays on the rows.
 */
export function GlideHighlight() {
  const ref = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const card = ref.current;
    const host = card?.parentElement;
    if (!card || !host) return;
    let current: HTMLElement | null = null;
    let lastX = 0;
    let lastY = 0;
    let lastWidth = 0;
    let lastHeight = 0;
    let frame = 0;
    let switchFrame = 0;
    let switchTimer = 0;
    let generation = 0;
    let pending: HTMLElement | null = null;

    const place = () => {
      frame = 0;
      const next = pending && host.contains(pending) ? pending : host.querySelector<HTMLElement>(SELECTED);
      if (!next || next.offsetParent === null) {
        current = null;
        card.dataset.state = "hidden";
        return;
      }
      const { x, y } = layoutOffset(next, host);
      const width = next.offsetWidth;
      const height = next.offsetHeight;
      // Selection and resize observers often report the position we already set on click. Removing the
      // slide transition here would cancel the animation just as the chat commits its selected state.
      if (current === next && x === lastX && y === lastY && width === lastWidth && height === lastHeight && card.dataset.state === "shown") return;
      // Slide between two rows, and with a row the list moved (it slides there too). Appearing and resizing jump.
      const slide = current !== null && (current !== next || y !== lastY) && card.dataset.state === "shown";
      card.dataset.motion = slide ? "slide" : "jump";
      card.style.width = `${width}px`;
      card.style.height = `${height}px`;
      card.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      card.dataset.state = "shown";
      current = next;
      lastX = x;
      lastY = y;
      lastWidth = width;
      lastHeight = height;
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(place);
    };

    switches.set(host, (row, action) => {
      const ticket = ++generation;
      cancelAnimationFrame(switchFrame);
      clearTimeout(switchTimer);
      pending = row;
      cancelAnimationFrame(frame);
      place();
      const settle = () => {
        if (ticket !== generation) return;
        pending = null;
        schedule();
      };
      // The first frame establishes the transition; the second advances it before React can block the main thread.
      switchFrame = requestAnimationFrame(() => {
        switchFrame = requestAnimationFrame(() => {
          switchTimer = window.setTimeout(() => {
            try {
              void Promise.resolve(action()).then(settle, settle);
            } catch (error) {
              settle();
              throw error;
            }
          }, 0);
        });
      });
    });

    place();
    const mutations = new MutationObserver(schedule);
    mutations.observe(host, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-active", "aria-current"],
    });
    const resizes = new ResizeObserver(schedule);
    resizes.observe(host);
    return () => {
      generation++;
      switches.delete(host);
      cancelAnimationFrame(frame);
      cancelAnimationFrame(switchFrame);
      clearTimeout(switchTimer);
      mutations.disconnect();
      resizes.disconnect();
    };
  }, []);

  return <span ref={ref} aria-hidden data-state="hidden" className="glide-card depth-row-active" />;
}
