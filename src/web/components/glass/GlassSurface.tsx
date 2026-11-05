import { useCallback, useRef } from 'react';
import { registerSurface, type SurfaceBinding } from './glass-registry';
/** Bind the existing node; never clone a primitive or replace its semantics. */
export function useGlassSurface(options: Omit<SurfaceBinding, 'element'>) {
  const cleanup = useRef<(() => void) | null>(null);
  const { source, family, priority } = options;
  const ref = useCallback((element: HTMLElement | null) => {
    cleanup.current?.(); cleanup.current = null;
    if (!element) return;
    element.dataset.glassSurface = family; element.dataset.glassRenderer = 'css';
    cleanup.current = registerSurface({ element, source, family, priority });
  }, [source, family, priority]);
  return ref;
}
