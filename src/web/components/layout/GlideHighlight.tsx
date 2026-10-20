import { useLayoutEffect, useRef } from "react";

const SELECTED = '[data-glide]:is([data-active], [aria-current="page"])';

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
    let frame = 0;

    const place = () => {
      frame = 0;
      const next = host.querySelector<HTMLElement>(SELECTED);
      if (!next || next.offsetParent === null) {
        current = null;
        card.dataset.state = "hidden";
        return;
      }
      const hostBox = host.getBoundingClientRect();
      const box = next.getBoundingClientRect();
      const x = box.left - hostBox.left + host.scrollLeft;
      const y = box.top - hostBox.top + host.scrollTop;
      // Slide only between two rows. Appearing, resizing, and list reflows jump.
      const slide = current !== null && current !== next && card.dataset.state === "shown";
      card.dataset.motion = slide ? "slide" : "jump";
      card.style.width = `${box.width}px`;
      card.style.height = `${box.height}px`;
      card.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      card.dataset.state = "shown";
      current = next;
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(place);
    };

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
      cancelAnimationFrame(frame);
      mutations.disconnect();
      resizes.disconnect();
    };
  }, []);

  return <span ref={ref} aria-hidden data-state="hidden" className="glide-card depth-row-active" />;
}
