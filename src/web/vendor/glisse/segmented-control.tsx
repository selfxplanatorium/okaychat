// Adapted from Glisse 0.5.0 (MIT, Copyright (c) 2026 Kelvin Zhang), sections
// src/internal/segments.tsx and src/segmented-control.tsx. The track, thumb
// and label tree are upstream's segmented control; the spring-driven lens is
// not shipped here (the engine exposes a switch lens only), so the thumb slides
// on a CSS transition, and the semantics are a real radio group with roving
// tabIndex, direction-aware arrows and Home/End. See UPSTREAM.md.
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import type {
  CSSProperties,
  HTMLAttributes,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactElement,
  ReactNode,
} from "react";

export interface SegmentItem {
  value: string;
  label: ReactNode;
  /** Kept focusable with aria-disabled so a wrapper can explain why. */
  disabled?: boolean;
}

export interface SegmentedControlProps
  extends Omit<HTMLAttributes<HTMLDivElement>, "role" | "onChange" | "defaultValue" | "children"> {
  items: ReadonlyArray<SegmentItem>;
  value?: string | null;
  defaultValue?: string | null;
  onValueChange?: (value: string) => void;
  /** The group's accessible name; `aria-label` on the group works too. Vendor code never holds user-facing text. */
  label?: string;
  disabled?: boolean;
  /** Wraps each rendered radio, for a tooltip on a disabled segment. */
  renderItem?: (item: SegmentItem, radio: ReactElement) => ReactElement;
}

const cx = (...names: Array<string | false | null | undefined>) => names.filter(Boolean).join(" ");

const KEYS = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"] as const;

const DRAG_THRESHOLD = 6;
const VERTICAL_SLOP = 10;

interface Drag {
  id: number;
  x: number;
  y: number;
  slot: number;
  left: number;
  index: number;
  moved: boolean;
}

export function SegmentedControl({
  items,
  value: valueProp,
  defaultValue = null,
  onValueChange,
  label,
  disabled = false,
  className,
  renderItem,
  onKeyDown,
  style,
  ...attributes
}: SegmentedControlProps) {
  const controlled = valueProp !== undefined;
  const [uncontrolled, setUncontrolled] = useState<string | null>(defaultValue);
  const value = controlled ? (valueProp ?? null) : uncontrolled;
  const selected = items.findIndex((item) => item.value === value);
  const groupRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const focusedIndex = useRef(-1);
  const suppressClick = useRef(false);
  const drag = useRef<Drag | null>(null);

  const emit = useRef(onValueChange);
  const disabledRef = useRef(disabled);
  const controlledRef = useRef(controlled);
  useEffect(() => {
    emit.current = onValueChange;
    disabledRef.current = disabled;
    controlledRef.current = controlled;
  });

  const select = useCallback((next: string) => {
    if (disabledRef.current) return;
    if (!controlledRef.current) setUncontrolled(next);
    emit.current?.(next);
  }, []);

  const enabledIndexes = items.flatMap((item, index) => (item.disabled ? [] : [index]));
  const tabStop = selected >= 0 && !items[selected]?.disabled ? selected : (enabledIndexes[0] ?? -1);

  const moveTo = (index: number) => {
    const item = items[index];
    if (!item) return;
    // A disabled choice keeps focus (and its reason) without being selected.
    if (!item.disabled) select(item.value);
    itemRefs.current[index]?.focus();
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event);
    if (event.key === " " || event.key === "Enter") suppressClick.current = false;
    if (event.defaultPrevented || disabled || !KEYS.includes(event.key as (typeof KEYS)[number])) return;
    if (!items.length) return;
    event.preventDefault();
    const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
    const step =
      event.key === "ArrowRight"
        ? rtl
          ? -1
          : 1
        : event.key === "ArrowLeft"
          ? rtl
            ? 1
            : -1
          : event.key === "ArrowDown"
            ? 1
            : event.key === "ArrowUp"
              ? -1
              : 0;
    if (event.key === "Home") {
      moveTo(0);
      return;
    }
    if (event.key === "End") {
      moveTo(items.length - 1);
      return;
    }
    const at = focusedIndex.current >= 0 ? focusedIndex.current : selected >= 0 ? selected : 0;
    moveTo((at + step + items.length) % items.length);
  };

  const endDrag = () => {
    const group = groupRef.current;
    drag.current = null;
    group?.removeAttribute("data-dragging");
    group?.style.removeProperty("--oc-seg-drag");
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.isPrimary || event.button !== 0 || disabled) return;
    const group = groupRef.current;
    if (!group || !items.length) return;
    const box = group.getBoundingClientRect();
    const slot = box.width / items.length;
    if (!(slot > 0)) return;
    suppressClick.current = false;
    drag.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      slot,
      left: box.left,
      index: Math.max(0, selected),
      moved: false,
    };
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = drag.current;
    const group = groupRef.current;
    if (!gesture || !group || event.pointerId !== gesture.id) return;
    const dx = event.clientX - gesture.x;
    const dy = event.clientY - gesture.y;
    if (!gesture.moved && Math.abs(dy) > VERTICAL_SLOP && Math.abs(dy) > Math.abs(dx) + DRAG_THRESHOLD) {
      // The page keeps the scroll and the release selects nothing.
      suppressClick.current = true;
      endDrag();
      return;
    }
    if (!gesture.moved && Math.abs(dx) < DRAG_THRESHOLD) return;
    if (!gesture.moved) {
      gesture.moved = true;
      group.setAttribute("data-dragging", "");
      group.setPointerCapture(event.pointerId);
    }
    const min = -gesture.index * gesture.slot;
    const max = (items.length - 1 - gesture.index) * gesture.slot;
    group.style.setProperty("--oc-seg-drag", `${Math.min(max, Math.max(min, dx))}px`);
  };

  const handlePointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = drag.current;
    const group = groupRef.current;
    if (!gesture || !group || event.pointerId !== gesture.id) return;
    const moved = gesture.moved;
    endDrag();
    if (!moved) return;
    suppressClick.current = true;
    if (group.hasPointerCapture(event.pointerId)) group.releasePointerCapture(event.pointerId);
    const index = Math.min(items.length - 1, Math.max(0, Math.floor((event.clientX - gesture.left) / gesture.slot)));
    const item = items[index];
    if (item && !item.disabled) select(item.value);
  };

  const handleClick = (item: SegmentItem) => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    if (item.disabled) return;
    select(item.value);
  };

  return (
    <div
      {...attributes}
      aria-disabled={disabled || undefined}
      aria-label={label ?? attributes["aria-label"]}
      aria-orientation="horizontal"
      className={cx("oc-segmented", className)}
      data-disabled={disabled ? "" : undefined}
      data-empty={selected < 0 ? "" : undefined}
      data-glass-surface="control"
      onKeyDown={handleKeyDown}
      onPointerCancel={endDrag}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      ref={groupRef}
      role="radiogroup"
      style={
        {
          ...style,
          "--oc-seg-count": Math.max(1, items.length),
          "--oc-seg-index": Math.max(selected, 0),
        } as CSSProperties
      }
    >
      <span aria-hidden="true" className="oc-segmented-thumb" />
      {items.map((item, index) => {
        const checked = index === selected;
        const radio = (
          <button
            aria-checked={checked}
            aria-disabled={item.disabled || disabled || undefined}
            className="oc-segmented-item"
            data-index={index}
            data-selected={checked ? "" : undefined}
            key={item.value}
            onClick={() => handleClick(item)}
            onFocus={() => {
              focusedIndex.current = index;
            }}
            ref={(node) => {
              itemRefs.current[index] = node;
            }}
            role="radio"
            tabIndex={disabled ? -1 : index === tabStop ? 0 : -1}
            type="button"
          >
            <span className="oc-segmented-label">{item.label}</span>
          </button>
        );
        return renderItem ? (
          <Fragment key={item.value}>{renderItem(item, radio)}</Fragment>
        ) : (
          radio
        );
      })}
    </div>
  );
}
