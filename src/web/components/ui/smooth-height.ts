import { useCallback } from "react";
import { motionAllowed } from "@/state/appearance";

// --motion-base and --ease-out-expo, the popups' own enter timing.
const DURATION = 220;
const EASING = "cubic-bezier(0.16, 1, 0.3, 1)";

/**
 * Popups and the composer never jump to a new height: attach the returned ref and every height change animates
 * from the height it showed. A ResizeObserver sees changes at rest (after layout, before paint, so the new
 * height never flashes). While animating, the height is forced, so content changes are caught by a
 * MutationObserver instead and restart the animation from the current height. Boxes anchored at their bottom
 * edge (popups that open upward, or `pin: "bottom"`) keep their content pinned there, so it does not move.
 */
export function useSmoothHeight({ pin }: { pin?: "bottom" } = {}) {
  return useCallback((popup: HTMLElement | null) => {
    if (!popup) return;
    let shown: number | null = null;
    let running: Animation[] = [];
    let from = 0;

    const stop = () => {
      const elapsed = Number(running[0]?.currentTime ?? 0);
      for (const animation of running) animation.cancel();
      running = [];
      return elapsed;
    };
    // The used height ignores the enter/exit scale and is not rounded like offsetHeight, so the pinned edge
    // cannot drift by a pixel. With no animation running it is the natural height.
    const height = () => parseFloat(getComputedStyle(popup).height);
    const animate = (start: number, elapsed = 0) => {
      const to = height();
      shown = to;
      from = start;
      if (Math.abs(start - to) < 1 || !motionAllowed("interface")) return;
      const timing = { duration: DURATION, easing: EASING };
      const frame = { overflow: "hidden" };
      const pinned = pin === "bottom" || popup.dataset.side === "top";
      const style = getComputedStyle(popup);
      if (pinned && style.display.endsWith("flex") && style.flexDirection === "column") {
        // Content aligned to the bottom overflows (and is clipped) at the top, so only the height animates.
        // Children keep their natural size instead of shrinking into the held height.
        Object.assign(frame, { justifyContent: "flex-end" });
        for (const child of popup.children) running.push(child.animate([{ flexShrink: 0 }, { flexShrink: 0 }], timing));
      } else if (pinned) {
        // `top` runs on the main thread with the height. A transform would run on the compositor, drift
        // from the height while the main thread is busy, and shake the pinned edge.
        const keyframes = [{ position: "relative", top: `${start - to}px` }, { position: "relative", top: "0px" }];
        for (const child of popup.children) {
          if (getComputedStyle(child).position === "static") running.push(child.animate(keyframes, timing));
        }
      }
      running.unshift(popup.animate([{ ...frame, height: `${start}px` }, { ...frame, height: `${to}px` }], timing));
      for (const animation of running) animation.currentTime = elapsed;
      running[0]!.onfinish = () => {
        running = [];
      };
    };

    const resized = new ResizeObserver(() => {
      if (running.length) return; // Our own animation.
      if (shown === null) shown = height();
      else animate(shown);
    });
    const mutated = new MutationObserver(() => {
      if (!running.length) return; // The ResizeObserver handles changes at rest.
      const target = shown!;
      const current = height();
      const elapsed = stop();
      // Content that keeps the size (a ticking counter) resumes the same motion instead of starting over.
      if (Math.abs(height() - target) < 1) animate(from, elapsed);
      else animate(current);
    });
    resized.observe(popup);
    // `style` catches auto-growing textareas, which resize through their inline height.
    mutated.observe(popup, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["style"] });
    return () => {
      resized.disconnect();
      mutated.disconnect();
      stop();
    };
  }, [pin]);
}
