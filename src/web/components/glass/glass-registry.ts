import { assignLeases, createDowngradeMonitor, mapDensity, TIER_BUDGETS, type LeaseCandidate, type GlassEnvironment } from './glass-policy';
import { effectiveGlass } from './glass-policy';
import { readGlassEnvironment, setGlassEngineFailed, setGlassDowngrade, subscribeGlassEffective } from './glass-environment';
import type { AppearanceSettings } from '../../../shared/appearance';
import { onGlassInvalidate } from '@/theme/glass';
import type { MaterialOptions, SurfaceHandle } from '@/vendor/glisse/material-engine';
import { intersect, type Rect } from '@/vendor/glisse/lens-math';

type Engine = typeof import('@/vendor/glisse/material-engine');
export interface SourceBinding { element: HTMLElement; clip: HTMLElement }
export interface SurfaceBinding { element: HTMLElement; source: string; priority: number; family: 'sidebar' | 'composer' | 'overlay' | 'toolbar' | 'card' | 'control' }
export function validSource(source: HTMLElement, lens: HTMLElement): boolean {
  if (source === lens || source.contains(lens) || lens.contains(source)) return false;
  if (source === document.body || source.id === 'root') return false;
  const style = getComputedStyle(source);
  return (!style.filter || style.filter === 'none' || style.filter.includes('#oc-glass-')) && (!style.maskImage || style.maskImage === 'none') && style.position !== 'fixed';
}
export function clippedRect(source: Rect, clip: Rect): Rect { return intersect(source, clip); }

/** One shell owns the registry; refs may register before its effect mounts. */
const globalSources = new Map<string, SourceBinding>();
const globalSurfaces = new Map<HTMLElement, SurfaceBinding>();
let current: ReturnType<typeof createGlassRegistry> | null = null;
export function registerSource(id: string, binding: SourceBinding): () => void {
  globalSources.set(id, binding); current?.refresh();
  return () => { if (globalSources.get(id) === binding) globalSources.delete(id); current?.refresh(); };
}
export function registerSurface(binding: SurfaceBinding): () => void {
  globalSurfaces.set(binding.element, binding); current?.refresh();
  return () => { globalSurfaces.delete(binding.element); current?.release(binding.element); current?.refresh(); };
}
const rect = (r: DOMRect): Rect => ({ x: r.left, y: r.top, width: r.width, height: r.height });

export interface RegistryDependencies {
  preferences(): AppearanceSettings;
  environment?: () => GlassEnvironment;
  sources?: ReadonlyMap<string, SourceBinding>;
  surfaces?: ReadonlyMap<HTMLElement, SurfaceBinding>;
  now?: () => number;
  subscribe(callback: () => void): () => void;
  loadEngine?: () => Promise<Engine>;
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (id: number) => void;
}
export function createGlassRegistry(deps: RegistryDependencies) {
  const requestFrame = deps.requestFrame ?? requestAnimationFrame;
  const cancelFrame = deps.cancelFrame ?? cancelAnimationFrame;
  const sources = deps.sources ?? globalSources;
  const surfaces = deps.surfaces ?? globalSurfaces;
  const environment = () => deps.environment?.() ?? readGlassEnvironment(deps.preferences().motionOff);
  const nowMs = deps.now ?? (() => performance.now());
  let alive = true;
  let pageHidden = false;
  let frame = 0;
  let engine: Engine | null = null;
  let loading = false;
  let generation = 0;
  let lastFrame = 0;
  let activeUntil = 0;
  let sampleFrame = 0;
  let sampleAt = 0;
  let windowAt = 0;
  let engineWork = 0;
  let settle = 0;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  const monitor = createDowngradeMonitor(effectiveGlass(deps.preferences(), environment()).tier);
  const sample = (now: number) => {
    sampleFrame = 0;
    if (!alive || document.hidden || now >= activeUntil || deps.preferences().glassPerformance !== 'auto') { sampleAt = 0; return; }
    const next = sampleAt ? monitor.frame(now - sampleAt, { active: true, visible: true }) : null;
    if (next === 'balanced' || next === 'css') setGlassDowngrade(next);
    sampleAt = now;
    sampleFrame = requestFrame(sample);
  };
  const interact = () => {
    activeUntil = nowMs() + 200;
    if (!sampleFrame) sampleFrame = requestFrame(sample);
    refresh();
  };
  const resizing = () => {
    settle = nowMs() + 120;
    for (const element of handles.keys()) release(element);
    clearTimeout(settleTimer); settleTimer = setTimeout(refresh, 125);
  };
  const handles = new Map<HTMLElement, { handle: SurfaceHandle; source: HTMLElement }>();
  const roots = new Set<HTMLElement>();
  const observed = new Set<HTMLElement>();
  const invisible = new Set<Element>();
  const release = (element: HTMLElement) => {
    handles.get(element)?.handle.destroy(); handles.delete(element);
    if (!surfaces.has(element)) { resize?.unobserve(element); intersection?.unobserve(element); observed.delete(element); invisible.delete(element); }
    element.dataset.glassRenderer = document.documentElement.dataset.glassEffective === 'solid' ? 'solid' : 'css';
  };
  const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resizing);
  const intersection = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver((entries) => {
    for (const entry of entries) { if (entry.isIntersecting) invisible.delete(entry.target); else { invisible.add(entry.target); release(entry.target as HTMLElement); } }
    refresh();
  });
  const refresh = () => {
    if (!alive || frame) return;
    frame = requestFrame(flush);
  };
  const flush = () => {
    frame = 0;
    if (!alive) return;
    const now = nowMs();
    if (now < settle) return;
    for (const root of roots) if (![...sources.values()].some(source => source.clip === root)) { root.removeEventListener('scroll', interact); roots.delete(root); resize?.unobserve(root); }
    for (const node of observed) if (!surfaces.has(node) && ![...sources.values()].some(source => source.element === node)) { resize?.unobserve(node); intersection?.unobserve(node); observed.delete(node); invisible.delete(node); }
    const prefs = deps.preferences();
    const { tier } = effectiveGlass(prefs, environment());
    const budget = TIER_BUDGETS[tier];
    if (document.hidden || pageHidden || !budget.large) { for (const element of handles.keys()) release(element); return; }
    if (now - lastFrame < budget.frameMs) { refresh(); return; }
    lastFrame = now;
    const candidates: LeaseCandidate[] = [];
    const measured = new Map<string, { binding: SurfaceBinding; source: SourceBinding; options: MaterialOptions }>();
    const callActive = [...surfaces.values()].some(b => b.element.classList.contains('call-surface') && b.element.getClientRects().length);
    const modal = [...surfaces.values()].filter(b => b.element.getAttribute('aria-modal') === 'true' && b.element.getClientRects().length).at(-1);
    const topOverlay = [...surfaces.values()].filter(b => b.family === 'overlay' && b.element.getClientRects().length).at(-1);
    let order = 0;
    // Read every candidate before touching a filter graph.
    for (const binding of surfaces.values()) {
      const element = binding.element;
      const source = binding.source === 'active-content' ? sources.get('route-content') ?? sources.get('chat-messages') : binding.source === 'sidebar-content' ? sources.get(window.innerWidth < 768 ? 'chat-messages' : 'shell-canvas') : sources.get(binding.source);
      if (!source || !element.isConnected || invisible.has(element) || !validSource(source.element, element)) continue;
      if (!observed.has(source.element)) { observed.add(source.element); resize?.observe(source.element); }
      if (!observed.has(element)) { observed.add(element); resize?.observe(element); intersection?.observe(element); }
      if (!roots.has(source.clip)) { roots.add(source.clip); source.clip.addEventListener('scroll', interact, { passive: true }); resize?.observe(source.clip); }
      const box = element.getBoundingClientRect();
      const clip = clippedRect(rect(source.element.getBoundingClientRect()), rect(source.clip.getBoundingClientRect()));
      const density = mapDensity(box.width, box.height, devicePixelRatio, tier);
      const familyKey = { sidebar: 'glassSidebar', composer: 'glassComposer', overlay: 'glassOverlays', toolbar: 'glassToolbars', card: 'glassCards', control: 'glassControls' } as const;
      const visible = !!box.width && !!box.height && clip.width > 0 && clip.height > 0 && getComputedStyle(element).visibility !== 'hidden' && !element.closest('[inert], [data-open="false"]');
      const id = String(order++);
      candidates.push({ id, order, priority: binding.family === 'composer' && element.contains(document.activeElement) ? 80 : binding.priority, control: false, sourceId: source.element.dataset.glassSource ?? binding.source, sourcePixels: (clip.width + 48) * (clip.height + 48), visible, suspended: callActive || !density || !prefs[familyKey[binding.family]] || (binding.family === 'sidebar' && window.innerWidth >= 768 && document.documentElement.dataset.sidebar === 'docked') || (binding.family === 'overlay' && binding !== topOverlay) || !!(modal && binding !== topOverlay) });
      measured.set(id, { binding, source, options: { bend: prefs.glassBend, dispersion: prefs.glassDispersion, rim: prefs.glassRimShine, density: density ?? 1, dark: document.documentElement.classList.contains('dark'), clip, overscan: 24 } });
    }
    const leases = assignLeases(candidates, tier);
    const leased = new Set<HTMLElement>();
    for (const id of leases) { const entry = measured.get(id); if (entry) leased.add(entry.binding.element); }
    for (const element of handles.keys()) if (!leased.has(element)) release(element);
    if (leases.size && !engine && !loading) {
      loading = true; const expected = generation;
      void (deps.loadEngine?.() ?? import('@/vendor/glisse/material-engine')).then(module => { if (alive && expected === generation) { engine = module; refresh(); } }).catch(() => { if (alive) setGlassEngineFailed(); });
    }
    if (!engine) return;
    try {
      for (const id of leases) {
        const entry = measured.get(id); if (!entry) continue;
        const { binding, source, options } = entry;
        let held = handles.get(binding.element);
        if (held && held.source !== source.element) { release(binding.element); held = undefined; }
        if (!held) { held = { handle: engine.attachSurface(binding.element, source.element, options), source: source.element }; handles.set(binding.element, held); }
        held.handle.update(options); held.handle.setActive(true);
      }
      engineWork += engine.flushMaterial();
      if (now - windowAt >= 1000) {
        const next = monitor.window(engineWork, { active: prefs.glassPerformance === 'auto' && now < activeUntil, visible: !document.hidden });
        if (next === 'balanced' || next === 'css') setGlassDowngrade(next);
        engineWork = 0; windowAt = now;
      }
    } catch { for (const element of handles.keys()) release(element); setGlassEngineFailed(); }
  };
  const unwatch = onGlassInvalidate(() => { for (const held of handles.values()) held.handle.invalidate(); refresh(); });
  const unsub = deps.subscribe(refresh);
  const unenv = subscribeGlassEffective(refresh);
  const visibility = () => { if (document.hidden) { cancelFrame(sampleFrame); sampleFrame = 0; sampleAt = 0; for (const element of handles.keys()) release(element); } else refresh(); };
  const pagehide = () => { pageHidden = true; cancelFrame(frame); frame = 0; cancelFrame(sampleFrame); sampleFrame = 0; sampleAt = 0; for (const element of handles.keys()) release(element); };
  const pageshow = () => { pageHidden = false; refresh(); };
  document.addEventListener('visibilitychange', visibility);
  document.addEventListener('focusin', refresh);
  document.addEventListener('focusout', refresh);
  window.addEventListener('pageshow', pageshow);
  window.visualViewport?.addEventListener('resize', resizing);
  void document.fonts?.ready.then(() => { if (alive) refresh(); });
  window.addEventListener('pagehide', pagehide);
  window.addEventListener('resize', resizing, { passive: true });
  refresh();
  return { refresh, release, destroy() {
    if (!alive) return; alive = false; generation++;
    cancelFrame(frame); cancelFrame(sampleFrame); clearTimeout(settleTimer); unwatch(); unsub(); unenv(); resize?.disconnect(); intersection?.disconnect();
    for (const root of roots) root.removeEventListener('scroll', interact);
    for (const element of handles.keys()) release(element);
    document.removeEventListener('focusin', refresh); document.removeEventListener('focusout', refresh); window.removeEventListener('pageshow', pageshow); window.visualViewport?.removeEventListener('resize', resizing);
    document.removeEventListener('visibilitychange', visibility); window.removeEventListener('pagehide', pagehide); window.removeEventListener('resize', resizing);
  } };
}
export function mountGlassRegistry(deps: RegistryDependencies): () => void {
  current?.destroy(); const registry = createGlassRegistry(deps); current = registry;
  return () => { registry.destroy(); if (current === registry) current = null; };
}
