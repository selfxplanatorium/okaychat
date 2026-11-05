import test from 'node:test';
import assert from 'node:assert/strict';
import { createMapCache } from '../../vendor/glisse/map-cache';
import { intersect, placementKey, cornerRadius } from '../../vendor/glisse/lens-math';

test('map cache enforces aggregate bytes, refcounts and LRU eviction', () => {
  const cache = createMapCache<string>({ entries: 2, bytes: 12 });
  let builds = 0;
  const acquire = (key: string) => cache.acquire(key, 6, () => { builds++; return { value: key, bytes: 6 }; });
  assert.equal(acquire('a'), 'a'); assert.equal(acquire('a'), 'a');
  assert.equal(builds, 1);
  assert.equal(acquire('b'), 'b');
  assert.equal(acquire('c'), null);
  cache.release('a'); assert.equal(acquire('c'), null);
  cache.release('a'); assert.equal(acquire('c'), 'c');
  assert.deepEqual(cache.stats(), { entries: 2, bytes: 12, live: 2 });
  cache.clear(); assert.deepEqual(cache.stats(), { entries: 0, bytes: 0, live: 0 });
});

test('cache refuses an encoded image whose measured size exceeds estimate', () => {
  const cache = createMapCache<string>({ entries: 24, bytes: 12 });
  assert.equal(cache.acquire('oversize', 1, () => ({ value: 'url', bytes: 13 })), null);
  assert.equal(cache.stats().bytes, 0);
});

test('visible source intersection stays bounded and square radius remains zero', () => {
  assert.deepEqual(intersect({ x: 0, y: -10000, width: 700, height: 20000 }, { x: 0, y: 0, width: 700, height: 800 }), { x: 0, y: 0, width: 700, height: 800 });
  assert.equal(cornerRadius('0px', 700, 100), 0);
  assert.equal(placementKey([1, 2, 3]), placementKey([1, 2, 3]));
});

import { createGlassRegistry, validSource } from './glass-registry';
import { GLASS_DEFAULTS, type AppearanceSettings } from '../../../shared/appearance';
import { invalidateGlass } from '../../theme/glass';

test('registry batches invalidation, cancels its queue, and does no hidden work', () => {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const doc = Object.assign(new EventTarget(), { hidden: true, documentElement: { dataset: {} } });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: doc });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
  const callbacks = new Map<number, FrameRequestCallback>();
  let serial = 0;
  let imports = 0;
  let unsubscribed = 0;
  const prefs = { ...GLASS_DEFAULTS, glassOpacity: 50, motionOff: [] } as unknown as AppearanceSettings;
  const registry = createGlassRegistry({
    preferences: () => prefs,
    subscribe: () => () => { unsubscribed++; },
    requestFrame: callback => { callbacks.set(++serial, callback); return serial; },
    cancelFrame: id => { callbacks.delete(id); },
    loadEngine: async () => { imports++; throw new Error('must not load while hidden'); },
  });
  try {
    registry.refresh(); registry.refresh(); invalidateGlass('theme');
    assert.equal(callbacks.size, 1);
    const callback = callbacks.values().next().value!; callbacks.clear(); callback(0);
    assert.equal(callbacks.size, 0); assert.equal(imports, 0);
    registry.refresh(); assert.equal(callbacks.size, 1);
    registry.destroy(); registry.destroy();
    assert.equal(callbacks.size, 0); assert.equal(unsubscribed, 1);
    registry.refresh(); invalidateGlass('tokens'); assert.equal(callbacks.size, 0);
  } finally {
    registry.destroy();
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument); else Reflect.deleteProperty(globalThis, 'document');
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('source validation rejects either ancestor direction before reading styles', () => {
  const child = { contains: () => false } as unknown as HTMLElement;
  const parent = { contains: (node: HTMLElement) => node === child } as unknown as HTMLElement;
  assert.equal(validSource(parent, child), false);
  assert.equal(validSource(child, parent), false);
  assert.equal(validSource(child, child), false);
});

test('registry reads candidates before attachment and rejects a stale async engine', async () => {
  const keys = ['document', 'window', 'getComputedStyle', 'devicePixelRatio'] as const;
  const previous = keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const log: string[] = [];
  const box = { x: 0, y: 0, left: 0, top: 0, width: 100, height: 100 } as DOMRect;
  const node = (id: string) => ({
    id, dataset: { glassSource: id }, isConnected: true,
    contains: () => false, closest: () => null, getAttribute: () => null,
    classList: { contains: () => false },
    getClientRects: () => [box],
    getBoundingClientRect: () => { log.push(`read:${id}`); return box; },
    addEventListener() {}, removeEventListener() {},
  }) as unknown as HTMLElement;
  const source = node('source'); const first = node('first'); const second = node('second');
  const doc = Object.assign(new EventTarget(), { hidden: false, body: node('body'), activeElement: null, documentElement: { dataset: {}, classList: { contains: () => false } } });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: doc });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: Object.assign(new EventTarget(), { innerWidth: 1440 }) });
  Object.defineProperty(globalThis, 'devicePixelRatio', { configurable: true, value: 1 });
  Object.defineProperty(globalThis, 'getComputedStyle', { configurable: true, value: () => ({ filter: 'none', maskImage: 'none', position: 'static', visibility: 'visible' }) });
  const callbacks = new Map<number, FrameRequestCallback>(); let serial = 0; let clock = 100;
  let resolve: ((engine: typeof import('../../vendor/glisse/material-engine')) => void) | undefined;
  const enginePromise = new Promise<typeof import('../../vendor/glisse/material-engine')>(done => { resolve = done; });
  let destroyed = 0;
  const engine = {
    attachSurface: () => { log.push('attach'); return { update() {}, setActive() {}, invalidate() {}, destroy() { destroyed++; } }; },
    flushMaterial: () => 0,
  } as unknown as typeof import('../../vendor/glisse/material-engine');
  const prefs = { ...GLASS_DEFAULTS, glassOpacity: 50, motionOff: [] } as unknown as AppearanceSettings;
  const deps = {
    preferences: () => prefs, subscribe: () => () => {}, now: () => clock += 20,
    environment: () => ({ forcedColors: false, reducedTransparency: false, reducedMotion: false, motionOff: false, backdropFilter: true, coarsePointer: false, deviceMemory: 8 }),
    sources: new Map([['source', { element: source, clip: source }]]),
    surfaces: new Map([first, second].map(element => [element, { element, source: 'source', priority: 70, family: 'composer' as const }])),
    requestFrame: (callback: FrameRequestCallback) => { callbacks.set(++serial, callback); return serial; },
    cancelFrame: (id: number) => { callbacks.delete(id); }, loadEngine: () => enginePromise,
  };
  const runFrame = () => { const callback = callbacks.values().next().value; callbacks.clear(); callback?.(clock); };
  const registry = createGlassRegistry(deps);
  try {
    runFrame(); assert.equal(log.includes('attach'), false);
    resolve!(engine); await Promise.resolve();
    log.length = 0; runFrame();
    const attach = log.indexOf('attach'); assert.ok(attach > log.lastIndexOf('read:second'));
    assert.equal(log.filter(entry => entry === 'attach').length, 2);
    doc.hidden = true; doc.dispatchEvent(new Event('visibilitychange'));
    assert.equal(destroyed, 2);
    registry.destroy();
    // A second shell is destroyed while import is pending: its resolution cannot attach.
    doc.hidden = false;
    let finish: ((value: typeof engine) => void) | undefined;
    const pending = new Promise<typeof engine>(done => { finish = done; });
    const stale = createGlassRegistry({ ...deps, loadEngine: () => pending });
    runFrame(); stale.destroy(); log.length = 0;
    finish!(engine); await Promise.resolve();
    assert.equal(callbacks.size, 0); assert.equal(log.includes('attach'), false);
  } finally {
    registry.destroy();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
