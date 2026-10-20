/*
 * Icon motion. Every lucide icon inside a control plays a short gesture when the
 * pointer or keyboard focus arrives, and a bigger one when the control is
 * activated. The gestures live in icons.css, keyed by lucide's per-icon class,
 * so components need no changes and new icons get the generic gesture for free.
 *
 * One delegated listener drives every icon. The state is an attribute that is
 * removed only when the icon's animations finish, so a gesture always plays to
 * its end instead of snapping back when the pointer leaves halfway through.
 */

const CONTROL = [
  "button",
  "a[href]",
  "summary",
  "label",
  '[role="button"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="menuitemradio"]',
  '[role="menuitemcheckbox"]',
  '[role="option"]',
  '[role="tab"]',
  '[role="switch"]',
].join(",");

// Spinners own their animation, and a caller can opt a subtree out.
const SKIP = ".lucide-loader-circle, .lucide-loader, .animate-spin, [data-icon-motion-off] svg";

const DISABLED = ':disabled, [aria-disabled="true"], [data-disabled]';

type Gesture = "hover" | "press";

const runs = new WeakMap<SVGSVGElement, number>();

function visible(svg: SVGSVGElement) {
  // Swapped icons (copy/check) stack in one cell; only the shown one moves.
  return typeof svg.checkVisibility === "function"
    ? svg.checkVisibility({ opacityProperty: true, visibilityProperty: true })
    : true;
}

function iconsOf(control: Element) {
  return [...control.querySelectorAll<SVGSVGElement>("svg.lucide")].filter(
    (svg) => svg.closest(CONTROL) === control && !svg.matches(SKIP) && visible(svg),
  );
}

function play(svg: SVGSVGElement, gesture: Gesture) {
  const playing = svg.getAttribute("data-icon-motion");
  // A hover never interrupts anything; a press restarts whatever is running.
  if (playing && gesture === "hover") return;
  if (playing) {
    svg.removeAttribute("data-icon-motion");
    // Flush styles so the same keyframes restart from the first frame.
    void svg.getBoundingClientRect();
  }
  const run = (runs.get(svg) ?? 0) + 1;
  runs.set(svg, run);
  svg.setAttribute("data-icon-motion", gesture);
  const animations = svg.getAnimations({ subtree: true });
  const done = () => {
    if (runs.get(svg) === run) svg.removeAttribute("data-icon-motion");
  };
  if (animations.length === 0) return done();
  void Promise.allSettled(animations.map((animation) => animation.finished)).then(done);
}

function trigger(target: EventTarget | null, gesture: Gesture) {
  if (!(target instanceof Element)) return null;
  const control = target.closest(CONTROL);
  if (!control || control.matches(DISABLED)) return control;
  for (const svg of iconsOf(control)) play(svg, gesture);
  return control;
}

// Hover gestures wait for a settled pointer, so sweeping across a toolbar or
// down the sidebar does not set every icon moving. Presses play at once.
const HOVER_DELAY_MS = 1000;

let installed = false;

export function installIconMotion() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
  let hovered: Element | null = null;
  let pending = 0;

  const cancel = () => {
    window.clearTimeout(pending);
    pending = 0;
  };
  const hoverLater = (control: Element) => {
    cancel();
    if (reduce.matches) return;
    pending = window.setTimeout(() => {
      pending = 0;
      trigger(control, "hover");
    }, HOVER_DELAY_MS);
  };

  document.addEventListener(
    "pointerover",
    (event) => {
      if (event.pointerType === "touch") return;
      const control = event.target instanceof Element ? event.target.closest(CONTROL) : null;
      // pointerover fires for every child; only entering a new control counts.
      if (control === hovered) return;
      hovered = control;
      if (control) hoverLater(control);
      else cancel();
    },
    { passive: true },
  );
  document.addEventListener(
    "pointerout",
    (event) => {
      if (event.relatedTarget) return;
      hovered = null;
      cancel();
    },
    { passive: true },
  );
  document.addEventListener("focusin", (event) => {
    if (event.target instanceof Element && event.target.matches(":focus-visible")) hoverLater(event.target);
  });
  document.addEventListener("focusout", () => {
    if (!hovered) cancel();
  });
  document.addEventListener(
    "click",
    (event) => {
      // The press replaces the hover that was still waiting.
      cancel();
      // A label forwards a second click to its input; animate the first only.
      if (reduce.matches || event.target instanceof HTMLInputElement) return;
      trigger(event.target, "press");
    },
    { capture: true, passive: true },
  );
}
