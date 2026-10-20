import { lazy, type ComponentType } from "react";

/**
 * React.lazy suspends on first render even when the chunk has already arrived, and React then holds the
 * fallback for up to 300 ms. Once `preload()` has resolved, this renders the module directly instead.
 */
export function preloadable<P extends object>(load: () => Promise<ComponentType<P>>) {
  let loaded: ComponentType<P> | undefined;
  let pending: Promise<ComponentType<P>> | undefined;
  const preload = () =>
    (pending ??= load().then(
      (component) => (loaded = component),
      (error: unknown) => {
        // A failed chunk request may succeed on the next attempt.
        pending = undefined;
        throw error;
      },
    ));
  const Lazy = lazy(() => preload().then((component) => ({ default: component })));
  function Preloadable(props: P) {
    const Component = loaded ?? Lazy;
    return <Component {...props} />;
  }
  return Object.assign(Preloadable, { preload });
}
