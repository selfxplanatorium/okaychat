// Adapted from Glisse 0.5.0 (MIT, Copyright (c) 2026 Kelvin Zhang), sections
// src/switch.tsx and src/internal/spring.ts. The visual tree, drag gesture,
// lift and spring design are upstream's; the lens is loaded lazily from
// material-engine.ts, the geometry is measured from the CSS box instead of
// fixed JS constants, and RTL, cancellation and reduced motion are handled
// locally. See UPSTREAM.md.
import { forwardRef, useCallback, useEffect, useRef, useState } from "react";
import type {
  ButtonHTMLAttributes,
  FocusEvent as ReactFocusEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import type { SwitchLensHandle } from "./material-engine";
import { clamp01, dragPosition, isVerticalEscape, releaseTarget, switchAttributes, toggleDecision } from "./switch-state";

export interface GlisseSwitchProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "role" | "type" | "aria-checked" | "children" | "onChange"> {
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  /** A save is in flight: the switch cannot change and announces itself busy. */
  loading?: boolean;
}

const cx = (...names: Array<string | false | null | undefined>) => names.filter(Boolean).join(" ");

/* ---------------------------------------------------------------------------
 * Springs (upstream src/internal/spring.ts): one shared frame loop, analytic
 * critically/under-damped motion. A spring jumps instead of animating when the
 * document is hidden or the account turned interface motion off.
 * ------------------------------------------------------------------------- */

interface SpringState {
  value: number;
  target: number;
  velocity: number;
  stiffness: number;
  damping: number;
  paint: (value: number) => void;
}

const moving = new Set<SpringState>();
let frame = 0;
let last = 0;

function advance(state: SpringState, dt: number) {
  const x = state.value - state.target;
  const v = state.velocity;
  const half = state.damping / 2;
  const discriminant = half * half - state.stiffness;
  if (Math.abs(discriminant) < 1e-4) {
    const decay = Math.exp(-half * dt);
    const b = v + half * x;
    state.value = state.target + decay * (x + b * dt);
    state.velocity = decay * (v - half * b * dt);
  } else if (discriminant > 0) {
    const root = Math.sqrt(discriminant);
    const r1 = -half + root;
    const r2 = -half - root;
    const a = (v - r2 * x) / (r1 - r2);
    const b = x - a;
    state.value = state.target + a * Math.exp(r1 * dt) + b * Math.exp(r2 * dt);
    state.velocity = a * r1 * Math.exp(r1 * dt) + b * r2 * Math.exp(r2 * dt);
  } else {
    const omega = Math.sqrt(-discriminant);
    const decay = Math.exp(-half * dt);
    const cos = Math.cos(omega * dt);
    const sin = Math.sin(omega * dt);
    state.value = state.target + decay * (x * cos + ((v + half * x) / omega) * sin);
    state.velocity = decay * (v * cos - ((half * v + state.stiffness * x) / omega) * sin);
  }
}

function tick(time: number) {
  frame = 0;
  const dt = Math.min(0.1, Math.max(0, (time - last) / 1000));
  last = time;
  for (const state of moving) {
    advance(state, dt);
    if (Math.abs(state.value - state.target) < 1e-4 && Math.abs(state.velocity) < 0.001) {
      state.value = state.target;
      state.velocity = 0;
      moving.delete(state);
    }
    state.paint(state.value);
  }
  if (moving.size) frame = requestAnimationFrame(tick);
}

interface Spring {
  readonly value: number;
  set(target: number, instant?: boolean): void;
  paint(): void;
  stop(): void;
}

function createSpring(value: number, stiffness: number, damping: number, paint: (value: number) => void): Spring {
  const state: SpringState = { value, target: value, velocity: 0, stiffness, damping, paint };
  return {
    get value() {
      return state.value;
    },
    paint: () => paint(state.value),
    set(target, instant = false) {
      state.target = target;
      if (instant || document.hidden || !motionAllowed()) {
        state.value = target;
        state.velocity = 0;
        moving.delete(state);
        paint(target);
        return;
      }
      moving.add(state);
      if (!frame) {
        last = performance.now();
        frame = requestAnimationFrame(tick);
      }
    },
    stop: () => {
      moving.delete(state);
    },
  };
}

/* ---------------------------------------------------------------------------
 * Environment: one MediaQueryList and one attribute observer for every switch
 * on the page. Appearance > Motion writes data-motion-off on <html>; the glass
 * policy writes the effective tier and switched-off families there too.
 * ------------------------------------------------------------------------- */

const environmentListeners = new Set<() => void>();
let environmentObserver: MutationObserver | null = null;
let motionQuery: MediaQueryList | null = null;

function reducedMotion(): boolean {
  if (!motionQuery && typeof matchMedia === "function") motionQuery = matchMedia("(prefers-reduced-motion: reduce)");
  return motionQuery?.matches ?? false;
}

function motionAllowed(): boolean {
  const off = document.documentElement.dataset.motionOff ?? "";
  return !/(^|\s)(interface|transitions)(\s|$)/.test(off) && !reducedMotion();
}

function watchEnvironment(listener: () => void): () => void {
  environmentListeners.add(listener);
  if (!environmentObserver) {
    environmentObserver = new MutationObserver(() => environmentListeners.forEach((notify) => notify()));
    environmentObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-motion-off", "data-glass-effective", "data-glass-solid"],
    });
  }
  if (!motionQuery && typeof matchMedia === "function") {
    motionQuery = matchMedia("(prefers-reduced-motion: reduce)");
    motionQuery.addEventListener("change", () => environmentListeners.forEach((notify) => notify()));
  }
  return () => {
    environmentListeners.delete(listener);
    if (!environmentListeners.size) {
      environmentObserver?.disconnect();
      environmentObserver = null;
    }
  };
}

/* ---------------------------------------------------------------------------
 * Lens: shared lazy import, only while the effective tier refracts and the
 * controls family is on. A failed import leaves the CSS switch in place.
 * ------------------------------------------------------------------------- */

type EngineModule = typeof import("./material-engine");
let enginePromise: Promise<EngineModule> | null = null;

const loadEngine = () => (enginePromise ??= import("./material-engine"));

function lensEligible(): boolean {
  if (!motionAllowed()) return false;
  const root = document.documentElement;
  if (root.dataset.glassEffective !== "high" && root.dataset.glassEffective !== "balanced") return false;
  return !(root.dataset.glassSolid ?? "").split(/\s+/).includes("controls");
}

function numberToken(style: CSSStyleDeclaration, name: string, fallback: number): number {
  const value = Number.parseFloat(style.getPropertyValue(name));
  return Number.isFinite(value) ? value : fallback;
}

function lensOptions(element: HTMLElement) {
  const style = getComputedStyle(element);
  return {
    bend: numberToken(style, "--lg-glass-bend", numberToken(style, "--oc-glass-bend", 0.18)),
    dispersion: numberToken(style, "--lg-glass-dispersion", numberToken(style, "--oc-glass-dispersion", 0.12)),
    // Upstream caps a control's refraction map at 2 px per CSS px.
    density: 2,
    dark: document.documentElement.classList.contains("dark"),
  };
}

/** Distance between the two thumb rests, measured from the rendered boxes. */
function travelOf(track: HTMLElement, thumb: HTMLElement): number {
  const trackBox = track.getBoundingClientRect();
  const thumbBox = thumb.getBoundingClientRect();
  const margin = Math.max(0, (trackBox.height - thumbBox.height) / 2);
  return Math.max(0, trackBox.width - thumbBox.width - 2 * margin);
}

const isRtl = (element: HTMLElement) => getComputedStyle(element).direction === "rtl";

/* ------------------------------------------------------------------------- */

interface Gesture {
  id: number;
  x: number;
  y: number;
  from: boolean;
  moved: boolean;
  box: DOMRect;
}

interface Control {
  prepare(): void;
  sync(): void;
  down(event: ReactPointerEvent<HTMLButtonElement>): void;
  move(event: ReactPointerEvent<HTMLButtonElement>): void;
  up(event: ReactPointerEvent<HTMLButtonElement>): void;
  cancel(): void;
  toggle(): void;
}

export const GlisseSwitch = forwardRef<HTMLButtonElement, GlisseSwitchProps>(function GlisseSwitch(
  {
    checked: checkedProp,
    defaultChecked = false,
    onCheckedChange,
    loading = false,
    disabled = false,
    className,
    onClick,
    onPointerDown,
    onPointerEnter,
    onFocus,
    onKeyDown,
    ...attributes
  },
  forwardedRef,
) {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const bedRef = useRef<HTMLSpanElement | null>(null);
  const trackRef = useRef<HTMLSpanElement | null>(null);
  const insetRef = useRef<HTMLSpanElement | null>(null);
  const thumbRef = useRef<HTMLSpanElement | null>(null);
  const faceRef = useRef<HTMLSpanElement | null>(null);
  const fillRef = useRef<HTMLSpanElement | null>(null);
  const insetFillRef = useRef<HTMLSpanElement | null>(null);
  const controlRef = useRef<Control | null>(null);
  const lensRef = useRef<SwitchLensHandle | null>(null);
  const suppressClick = useRef(false);

  const controlled = checkedProp !== undefined;
  const [uncontrolled, setUncontrolled] = useState(() => (checkedProp === undefined ? defaultChecked : checkedProp));
  const checked = controlled ? checkedProp : uncontrolled;
  const off = disabled || loading;
  /** What the springs are showing; a refused controlled change never moves it. */
  const shown = useRef(checked);

  const emit = useRef(onCheckedChange);
  const controlledRef = useRef(controlled);
  const offRef = useRef(off);
  const loadingRef = useRef(loading);

  useEffect(() => {
    emit.current = onCheckedChange;
    controlledRef.current = controlled;
    offRef.current = off;
    loadingRef.current = loading;
  });

  const setChecked = useCallback((next: boolean) => {
    if (!controlledRef.current) setUncontrolled(next);
    emit.current?.(next);
  }, []);

  useEffect(() => {
    shown.current = checked;
    controlRef.current?.sync();
  }, [checked]);

  useEffect(() => {
    const element = buttonRef.current;
    const bed = bedRef.current;
    const track = trackRef.current;
    const inset = insetRef.current;
    const thumb = thumbRef.current;
    const face = faceRef.current;
    if (!element || !bed || !track || !inset || !thumb || !face) return;
    const fills = [fillRef.current, insetFillRef.current].filter((fill): fill is HTMLSpanElement => fill !== null);
    const resting = numberToken(getComputedStyle(element), "--oc-switch-rest", 0.65);
    const grow = numberToken(getComputedStyle(element), "--oc-switch-grow", 0.25);

    let live = true;
    let lensPending = false;
    let travel = travelOf(track, thumb);
    let rtl = isRtl(element);
    let options = lensOptions(element);
    let x = 0;
    let scale = resting;
    let lifted = 0;
    let gesture: Gesture | null = null;
    let ignoreClick = false;

    const paint = () => {
      thumb.style.transform = `translate(${x}px, -50%) scale(${scale})`;
      lensRef.current?.update({ ...options, amount: lifted });
    };

    /** A control mounted inside a hidden panel measures zero; retry when it can be seen. */
    const remeasure = () => {
      if (!(travel > 0)) travel = travelOf(track, thumb);
    };

    const sync = () => {
      remeasure();
      position.set(shown.current ? 1 : 0);
      color.set(shown.current ? 1 : 0);
    };

    const position = createSpring(shown.current ? 1 : 0, 1000, 80, (value) => {
      x = value * travel;
      paint();
    });
    const color = createSpring(shown.current ? 1 : 0, 1000, 80, (value) => {
      for (const fill of fills) fill.style.opacity = String(clamp01(value));
    });
    const lift = createSpring(0, 2000, 80, (value) => {
      lifted = clamp01(value);
      scale = resting + grow * value;
      face.style.opacity = String(1 - 0.85 * lifted);
      element.style.setProperty("--oc-switch-lift", String(lifted));
      element.toggleAttribute("data-lifted", lifted > 0.01);
      const lens = lensRef.current;
      if (lens) lens.setActive(lifted > 0.01);
      paint();
    });

    position.paint();
    color.paint();
    lift.paint();
    const settleFrame = requestAnimationFrame(() => {
      const before = travel;
      remeasure();
      if (travel !== before) sync();
    });

    const release = () => {
      const old = gesture;
      gesture = null;
      lift.set(0);
      if (old && element.hasPointerCapture(old.id)) element.releasePointerCapture(old.id);
    };

    const settle = (next?: boolean) => {
      release();
      if (next === undefined || next === shown.current) {
        sync();
        return;
      }
      // Controlled switches wait for their parent; a refusal leaves the value.
      if (!controlledRef.current) shown.current = next;
      setChecked(next);
      sync();
    };

    const ensureLens = () => {
      if (!live || lensPending || lensRef.current || !lensEligible()) return;
      lensPending = true;
      void loadEngine()
        .then((module) => {
          if (!live || lensRef.current) return;
          options = lensOptions(element);
          lensRef.current = module.enhanceSwitch({ thumb, inset, bed }, options);
          lensRef.current.update({ ...options, amount: lifted });
          lensRef.current.setActive(lifted > 0.01);
          element.setAttribute("data-enhanced", "");
        })
        .catch(() => {
          lensPending = false;
        });
    };

    const control: Control = {
      prepare() {
        const before = travel;
        remeasure();
        if (travel !== before) sync();
        ensureLens();
      },
      sync,
      down(event) {
        if (!event.isPrimary || event.button !== 0 || offRef.current || loadingRef.current) return;
        // Reduced motion and motion-off keep the switch a plain toggle.
        if (!motionAllowed()) return;
        travel = travelOf(track, thumb);
        rtl = isRtl(element);
        options = lensOptions(element);
        suppressClick.current = false;
        ignoreClick = false;
        gesture = {
          id: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          from: shown.current,
          moved: false,
          box: element.getBoundingClientRect(),
        };
        element.setPointerCapture(event.pointerId);
        lift.set(1);
        ensureLens();
      },
      move(event) {
        if (!gesture || event.pointerId !== gesture.id) return;
        const dx = event.clientX - gesture.x;
        const dy = event.clientY - gesture.y;
        if (!gesture.moved && isVerticalEscape(dx, dy)) {
          // The page keeps the scroll; nothing is committed and the click is dropped.
          ignoreClick = true;
          suppressClick.current = true;
          settle();
          return;
        }
        if (!gesture.moved && Math.abs(dx) < 4) return;
        gesture.moved = true;
        const input = { from: gesture.from, dx, travel, rtl };
        const value = dragPosition(input);
        position.set(value);
        color.set(value > 0.5 ? 1 : 0);
      },
      up(event) {
        if (!gesture || event.pointerId !== gesture.id) return;
        const { from, x: startX, moved, box } = gesture;
        const dx = event.clientX - startX;
        const near = event.clientY >= box.top - 24 && event.clientY <= box.bottom + 24;
        const target = ignoreClick ? null : releaseTarget({ from, dx, travel, rtl, moved, cancelled: false });
        // A tap is committed by the click that follows; a drag or a release
        // outside the control must not toggle a second time.
        if (moved || ignoreClick || !near) suppressClick.current = true;
        settle(target === null ? undefined : target);
      },
      cancel() {
        if (!gesture) return;
        suppressClick.current = true;
        settle();
      },
      toggle() {
        const decision = toggleDecision({
          checked: shown.current,
          controlled: controlledRef.current,
          disabled: offRef.current,
          loading: loadingRef.current,
        });
        if (!decision) return;
        if (decision.applyLocally) shown.current = decision.requested;
        setChecked(decision.requested);
        sync();
      },
    };
    controlRef.current = control;

    const onEnvironmentChange = () => {
      release();
      sync();
      lift.set(0);
      // Reduced motion, a downgraded tier or a switched-off controls family
      // detaches the lens; the CSS control is unaffected.
      if (!lensEligible()) lensRef.current?.setActive(false);
    };
    const unwatch = watchEnvironment(onEnvironmentChange);

    return () => {
      live = false;
      unwatch();
      cancelAnimationFrame(settleFrame);
      release();
      position.stop();
      color.stop();
      lift.stop();
      lensRef.current?.destroy();
      lensRef.current = null;
      controlRef.current = null;
      thumb.style.removeProperty("transform");
      face.style.removeProperty("opacity");
      for (const fill of fills) fill.style.removeProperty("opacity");
      element.style.removeProperty("--oc-switch-lift");
      element.removeAttribute("data-lifted");
      element.removeAttribute("data-enhanced");
    };
  }, [setChecked]);

  // `data-enhanced` marks a control whose lens is attached: diagnostics only,
  // the CSS material is the same before and after.
  const setButton = useCallback(
    (node: HTMLButtonElement | null) => {
      buttonRef.current = node;
      if (typeof forwardedRef === "function") forwardedRef(node);
      else if (forwardedRef) forwardedRef.current = node;
    },
    [forwardedRef],
  );

  const handleClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
    onClick?.(event);
    if (event.defaultPrevented) return;
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    controlRef.current?.toggle();
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    onPointerDown?.(event);
    if (event.defaultPrevented) return;
    controlRef.current?.down(event);
  };

  const handlePointerEnter = (event: ReactPointerEvent<HTMLButtonElement>) => {
    onPointerEnter?.(event);
    controlRef.current?.prepare();
  };

  const handleFocus = (event: ReactFocusEvent<HTMLButtonElement>) => {
    onFocus?.(event);
    controlRef.current?.prepare();
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    onKeyDown?.(event);
    // A keyboard click carries no pointer gesture, so a stale drag guard must
    // not swallow it.
    if (event.key === " " || event.key === "Enter") suppressClick.current = false;
  };

  return (
    <button
      {...(switchAttributes({ checked, disabled, loading, attributes }) as ButtonHTMLAttributes<HTMLButtonElement>)}
      aria-checked={checked}
      className={cx("oc-switch", className)}
      data-glass-surface="control"
      onClick={handleClick}
      onFocus={handleFocus}
      onKeyDown={handleKeyDown}
      onLostPointerCapture={() => controlRef.current?.cancel()}
      onPointerCancel={() => controlRef.current?.cancel()}
      onPointerDown={handlePointerDown}
      onPointerEnter={handlePointerEnter}
      onPointerMove={(event) => controlRef.current?.move(event)}
      onPointerUp={(event) => controlRef.current?.up(event)}
      ref={setButton}
    >
      <span aria-hidden="true" className="oc-switch-bed" ref={bedRef}>
        <span className="oc-switch-track" ref={trackRef}>
          <span className="oc-switch-fill" ref={fillRef} />
        </span>
      </span>
      <span aria-hidden="true" className="oc-switch-bed oc-switch-inset" ref={insetRef}>
        <span className="oc-switch-track">
          <span className="oc-switch-fill" ref={insetFillRef} />
        </span>
      </span>
      <span aria-hidden="true" className="oc-switch-thumb" ref={thumbRef}>
        <span className="oc-thumb-face" ref={faceRef} />
      </span>
    </button>
  );
});
