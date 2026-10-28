import type { PointerEvent as ReactPointerEvent } from "react";
import { create } from "zustand";

// Per device, like the artifact panel: a comfortable width depends on the screen, not the account.
const WIDTH_KEY = "okaychat:sidebar-width";
export const DEFAULT_SIDEBAR_WIDTH = 288;

const clampWidth = (w: number) => Math.round(Math.min(Math.max(220, w), Math.max(220, Math.min(520, window.innerWidth * 0.5))));

const applyWidth = (width: number) => document.documentElement.style.setProperty("--sidebar-width", `${width}px`);

/** The chat sidebar and the settings rail share one width, published as `--sidebar-width` on <html>. */
export const useSidebarWidth = create<{ width: number; set: (width: number) => void }>((set) => {
  const width = clampWidth(Number(localStorage.getItem(WIDTH_KEY)) || DEFAULT_SIDEBAR_WIDTH);
  applyWidth(width);
  return {
    width,
    set: (next) => {
      const width = clampWidth(next);
      applyWidth(width);
      localStorage.setItem(WIDTH_KEY, String(width));
      set({ width });
    },
  };
});

/** Drag or arrow keys (Shift for bigger steps) on the sidebar's right edge; double-click restores the default. Desktop only. */
export function SidebarResizeHandle() {
  const width = useSidebarWidth((s) => s.width);
  const resize = useSidebarWidth((s) => s.set);
  const onPointerDown = (e: ReactPointerEvent) => {
    e.preventDefault();
    const root = document.documentElement;
    const offset = e.clientX - width;
    const move = (ev: PointerEvent) => resize(ev.clientX - offset);
    const up = () => {
      document.body.style.removeProperty("cursor");
      document.querySelectorAll("iframe").forEach((f) => f.style.removeProperty("pointer-events"));
      delete root.dataset.sidebarResizing;
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
    };
    document.body.style.cursor = "col-resize";
    // Iframes swallow pointer events mid-drag.
    document.querySelectorAll("iframe").forEach((f) => (f.style.pointerEvents = "none"));
    // shell.css drops the width transitions while this is set, so the edge stays under the pointer.
    root.dataset.sidebarResizing = "";
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onDoubleClick={() => resize(DEFAULT_SIDEBAR_WIDTH)}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 80 : 20;
        const next = e.key === "ArrowRight" ? width + step : e.key === "ArrowLeft" ? width - step : null;
        if (next === null) return;
        e.preventDefault();
        resize(next);
      }}
      className="hover:bg-primary/40 focus-visible:bg-primary/40 absolute inset-y-0 right-0 z-10 w-1.5 cursor-col-resize outline-none transition-colors duration-(--motion-fast) max-md:hidden"
    />
  );
}
