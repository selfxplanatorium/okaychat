import { useEffect, useRef } from "react";
import { generateId } from "ai";

/**
 * Back closes the topmost overlay, like a native app: Android's back button and
 * gesture, an installed PWA's back swipe, and a Tauri Android wrapper (which maps
 * back to webview history) all pop a history entry. Each open overlay pushes one
 * entry for the same URL, so routing never sees it. Closing an overlay from the
 * UI pops its entry again. An entry left behind (a link inside the drawer pushed
 * a route above it) is skipped when back reaches it.
 */
const KEY = "okaychatOverlay";

interface Entry {
  id: string;
  close: () => void;
  pushed: boolean;
}

const stack: Entry[] = [];
/** history.back() calls of our own whose popstate has not arrived yet. */
let ownPops = 0;
let listening = false;

const overlayId = (): string | undefined => (history.state as Record<string, unknown> | null)?.[KEY] as string | undefined;

function pushEntry(entry: Entry) {
  history.pushState({ ...(history.state as object | null), [KEY]: entry.id }, "");
  entry.pushed = true;
}

// A push issued before an own back() lands would be undone by that traversal, so it waits.
function flush() {
  for (const entry of stack) if (!entry.pushed) pushEntry(entry);
}

function goBack() {
  ownPops++;
  history.back();
}

function onPopState() {
  if (ownPops > 0) {
    ownPops--;
    if (ownPops === 0) flush();
    return;
  }
  const id = overlayId();
  const keep = id ? stack.findIndex((e) => e.id === id) : -1;
  while (stack.length > keep + 1) stack.pop()!.close();
  if (id && keep === -1) goBack();
}

function open(entry: Entry) {
  if (!listening) {
    addEventListener("popstate", onPopState);
    listening = true;
  }
  stack.push(entry);
  if (ownPops === 0) pushEntry(entry);
}

function release(entry: Entry) {
  const index = stack.indexOf(entry);
  // Already gone: back closed it.
  if (index === -1) return;
  stack.splice(index, 1);
  if (entry.pushed && overlayId() === entry.id) goBack();
}

/**
 * Registers an open overlay so back closes it. `media` limits it to layouts where
 * it is an overlay; it is checked when the overlay opens.
 */
export function useBackClose(isOpen: boolean, close: () => void, media?: string) {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!isOpen || (media && !window.matchMedia(media).matches)) return;
    const entry: Entry = { id: generateId(), close: () => closeRef.current(), pushed: false };
    open(entry);
    return () => release(entry);
  }, [isOpen, media]);
}
