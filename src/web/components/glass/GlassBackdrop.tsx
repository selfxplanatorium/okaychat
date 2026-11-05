import { useCallback, useRef, type RefObject } from 'react';
import { registerSource } from './glass-registry';
export function useGlassBackdrop(id: string, clip?: RefObject<HTMLElement | null>) {
  const cleanup = useRef<(() => void) | null>(null);
  const ref = useCallback((element: HTMLElement | null) => {
    cleanup.current?.(); cleanup.current = null;
    if (!element) return;
    element.dataset.glisseBackdrop = id; element.dataset.glassSource = id;
    cleanup.current = registerSource(id, { element, get clip() { return clip?.current ?? element; } });
  }, [id, clip]);
  return ref;
}
