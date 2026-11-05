// Adapted from Glisse 0.5.0 (MIT, Copyright (c) 2026 Kelvin Zhang),
// sections src/internal/svg.ts, src/internal/lens.ts (encode, graph, place,
// createLens, mask) and src/internal/refraction.ts (paintRim). See UPSTREAM.md
// for every local change. Loaded lazily by the Glass runtime; nothing here
// touches the document at import time.
import {
  clamp,
  cornerRadius,
  DARK_LIGHT,
  intersect,
  LIGHT_LIGHT,
  lensMap,
  type LensOptions,
  mapSize,
  placementKey,
  type Rect,
  rimMap,
  type Shape,
  SURFACE_LENS,
  SWITCH_LENS,
} from "./lens-math";
import { createMapCache } from "./map-cache";

export interface MaterialOptions {
  bend: number;
  dispersion: number;
  rim: number;
  /** Map pixels per CSS px, already fitted to the tier's caps. */
  density: number;
  dark: boolean;
  /** Visible part of the source (its scroll root), in viewport px. Raster work stays inside it. */
  clip: Rect | null;
  /** Extra px kept around the clip so a scroll step does not uncover unfiltered edges. */
  overscan: number;
}

export interface SurfaceHandle {
  update(options: MaterialOptions): void;
  invalidate(reason?: string): void;
  setActive(active: boolean): void;
  destroy(): void;
}

export interface SwitchLensHandle {
  update(options: { bend: number; dispersion: number; density: number; dark: boolean; amount: number }): void;
  setActive(active: boolean): void;
  destroy(): void;
}

const SVG_NS = "http://www.w3.org/2000/svg";
let host: SVGSVGElement | null = null;
let defs: SVGDefsElement | null = null;
let made = 0;

function svg<K extends keyof SVGElementTagNameMap>(name: K, attributes: Record<string, string | number>): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  return element;
}

/** The page's one hidden `<defs>`. Removed again when the last lens goes. */
function container(): SVGDefsElement {
  if (defs?.isConnected) return defs;
  host = svg("svg", { width: 0, height: 0, "aria-hidden": "true", focusable: "false" });
  host.style.cssText = "position:absolute;width:0;height:0;pointer-events:none;overflow:hidden";
  defs = svg("defs", {});
  host.append(defs);
  document.body.append(host);
  return defs;
}

interface Maps {
  across: string;
  down: string;
  light: string;
  shape: string;
}

// Lens and rim entries share one aggregate budget.
const cache = createMapCache<Maps | string>();
const maps = {
  acquire(key: string, estimate: number, build: () => { value: Maps; bytes: number } | null): Maps | null {
    const value = cache.acquire(`map:${key}`, estimate, build);
    return typeof value === 'object' ? value : null;
  },
  release(key: string) { cache.release(`map:${key}`); },
};
const rims = {
  acquire(key: string, estimate: number, build: () => { value: string; bytes: number } | null): string | null {
    const value = cache.acquire(`rim:${key}`, estimate, build);
    return typeof value === 'string' ? value : null;
  },
  release(key: string) { cache.release(`rim:${key}`); },
};

function encode(key: string, shape: Shape, lens: LensOptions, dark: boolean, density: number): Maps | null {
  const { columns, rows } = mapSize(shape, density);
  // Four decoded images plus their PNG data URLs, which rarely exceed the raw size.
  const estimate = columns * rows * 4 * 4 * 2;
  return maps.acquire(key, estimate, () => {
    const map = lensMap(shape, lens, dark ? DARK_LIGHT : LIGHT_LIGHT, density);
    const canvas = document.createElement("canvas");
    canvas.width = map.columns;
    canvas.height = map.rows;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Glass canvas unavailable");
    const image = context.createImageData(map.columns, map.rows);
    const png = (data: Uint8ClampedArray) => {
      image.data.set(data);
      context.putImageData(image, 0, 0);
      return canvas.toDataURL();
    };
    const value = { across: png(map.across), down: png(map.down), light: png(map.light), shape: png(map.shape) };
    const bytes = map.columns * map.rows * 4 * 4 + value.across.length + value.down.length + value.light.length + value.shape.length;
    return { value, bytes };
  });
}

/** WebKit needs filters in bounding-box units. */
const boxUnits = () => /AppleWebKit\//.test(navigator.userAgent) && !/Chrom(?:e|ium)\//.test(navigator.userAgent);

const CHANNELS = ["1 0 0 0 0  0 0 0 0 0  0 0 0 0 0", "0 0 0 0 0  0 1 0 0 0  0 0 0 0 0", "0 0 0 0 0  0 0 0 0 0  0 0 1 0 0"];
const matrix = (input: string, values: string, result: string) => svg("feColorMatrix", { in: input, type: "matrix", values, result });
const sum = (a: string, b: string, k2: number, k3: number, result: string) => svg("feComposite", { in: a, in2: b, operator: "arithmetic", k2, k3, result });

function spread(k: number) {
  return [
    ...CHANNELS.map((channel, i) => matrix(`ray-${k}-${i}`, `${channel}  0 0 0 0.3333 0`, `light-${k}-${i}`)),
    sum(`light-${k}-0`, `light-${k}-1`, 1, 1, `light-${k}-01`),
    sum(`light-${k}-01`, `light-${k}-2`, 1, 1, `spread-${k}`),
    matrix(`spread-${k}`, "3 0 0 0 0  0 3 0 0 0  0 0 3 0 0  0 0 0 1 0", `bent-${k}`),
  ];
}

interface Graph {
  filter: SVGFilterElement;
  parts: Array<{ boxed: SVGElement[]; rays: Array<[SVGFEDisplacementMapElement, SVGFEDisplacementMapElement]> }>;
}

/**
 * The shared filter for every lens over one source. Upstream's ink and blur
 * stages are dropped: the paint host owns frost through backdrop-filter, so
 * the source graph supplies refraction only and blur is applied once.
 */
function graph(lenses: Array<{ maps: Maps }>, box: boolean, standIn: boolean): Graph {
  const unit = box ? "objectBoundingBox" : "userSpaceOnUse";
  const filter = svg("filter", { filterUnits: unit, primitiveUnits: unit, "color-interpolation-filters": "sRGB" });
  const single = lenses.length === 1;
  const parts = lenses.map(({ maps: lensMaps }, k) => {
    const merged = (name: string) => (single ? name : `${name}-${k}`);
    const image = (href: string, result: string) => svg("feImage", { href, preserveAspectRatio: "none", result });
    const boxed: SVGElement[] = [
      image(lensMaps.across, `across-${k}`),
      image(lensMaps.down, `down-${k}`),
      image(lensMaps.light, merged("raw")),
      svg("feFlood", { "flood-color": "rgb(128, 128, 128)", result: `neutral-${k}` }),
    ];
    if (standIn) boxed.push(image(lensMaps.shape, merged("shape")));
    filter.append(...boxed);
    for (const pull of ["across", "down"]) {
      const half = svg("feComponentTransfer", { in: `${pull}-grey-${k}`, result: `${pull}-pull-${k}` });
      half.append(svg("feFuncA", { type: "linear", slope: 0, intercept: 0.5 }));
      filter.append(svg("feComposite", { in: `${pull}-${k}`, in2: `neutral-${k}`, operator: "over", result: `${pull}-grey-${k}` }), half);
    }
    const rays = CHANNELS.map((_, i) => {
      const across = svg("feDisplacementMap", { in: "SourceGraphic", in2: `across-pull-${k}`, xChannelSelector: "R", yChannelSelector: "A", result: `across-${k}-${i}` });
      const down = svg("feDisplacementMap", { in: `across-${k}-${i}`, in2: `down-pull-${k}`, xChannelSelector: "A", yChannelSelector: "R", result: `ray-${k}-${i}` });
      boxed.push(across);
      filter.append(across, down);
      return [across, down] as [SVGFEDisplacementMapElement, SVGFEDisplacementMapElement];
    });
    filter.append(...spread(k));
    filter.append(svg("feComposite", { in: `bent-${k}`, in2: merged("raw"), operator: "in", result: merged("inside") }));
    return { boxed, rays };
  });
  if (!single) {
    for (const name of ["raw", "inside", ...(standIn ? ["shape"] : [])]) {
      const merge = svg("feMerge", { result: name });
      lenses.forEach((_, k) => merge.append(svg("feMergeNode", { in: `${name}-${k}` })));
      filter.append(merge);
    }
  }
  filter.append(
    svg("feComposite", { in: "SourceGraphic", in2: "raw", operator: "out", result: "outside" }),
    svg("feComposite", { in: "inside", in2: "outside", operator: "arithmetic", k2: 1, k3: 1, result: "seen" }),
  );
  if (standIn) filter.append(svg("feComposite", { in: "seen", in2: "shape", operator: "in" }));
  return { filter, parts };
}

interface Placed extends Rect {
  reach: number;
  dispersion: number;
}

function place(built: Graph, placed: Placed[], region: Rect, across: number, down: number, box: boolean) {
  const area = box
    ? { x: region.x / across, y: region.y / down, width: region.width / across, height: region.height / down }
    : region;
  for (const [key, value] of Object.entries(area)) built.filter.setAttribute(key, String(value));
  placed.forEach((lens, k) => {
    const part = built.parts[k];
    if (!part) return;
    const spectrum = [1 + 0.2 * lens.dispersion, 1 + 0.1 * lens.dispersion, 1];
    part.rays.forEach(([pullAcross, pullDown], i) => {
      pullAcross.setAttribute("scale", String((box ? lens.reach / across : lens.reach) * (spectrum[i] ?? 1)));
      pullDown.setAttribute("scale", String((box ? lens.reach / down : lens.reach) * (spectrum[i] ?? 1)));
    });
    const rect = box
      ? { x: lens.x / across, y: lens.y / down, width: lens.width / across, height: lens.height / down }
      : { x: lens.x, y: lens.y, width: lens.width, height: lens.height };
    for (const element of part.boxed) for (const [key, value] of Object.entries(rect)) element.setAttribute(key, String(value));
  });
}

const MASKING = ["image", "position", "size", "repeat", "composite"] as const;
function mask(element: HTMLElement, layers?: { image: string; position: string; size: string }) {
  for (const part of MASKING) {
    element.style.removeProperty(`-webkit-mask-${part}`);
    element.style.removeProperty(`mask-${part}`);
  }
  if (!layers) return;
  const values: Record<(typeof MASKING)[number], string> = { ...layers, repeat: "no-repeat", composite: "exclude" };
  for (const part of MASKING) {
    element.style.setProperty(`-webkit-mask-${part}`, part === "composite" ? "xor" : values[part]);
    element.style.setProperty(`mask-${part}`, values[part]);
  }
}

interface Member {
  glass: HTMLElement;
  lens: LensOptions;
  replaces?: HTMLElement;
  bend: number;
  dispersion: number;
  density: number;
  dark: boolean;
  amount: number;
  clip: Rect | null;
  overscan: number;
  active: boolean;
  /** Needs a new shape/map: size, radius, or theme changed. */
  stale: boolean;
  shape?: Shape;
  mapKey?: string;
  maps?: Maps;
  placed?: Placed;
}

interface Source {
  content: HTMLElement;
  members: Set<Member>;
  name: string;
  built: string;
  placed: string;
  version: number;
  graph?: Graph;
  standIn: boolean;
}

const sources = new Map<HTMLElement, Source>();
const dirty = new Set<Source>();
let switchLenses = 0;

function sourceFor(content: HTMLElement): Source {
  let source = sources.get(content);
  if (!source) {
    source = { content, members: new Set(), name: `oc-glass-${made++}`, built: "", placed: "", version: 0, standIn: false };
    sources.set(content, source);
  }
  return source;
}

function releaseMaps(member: Member) {
  if (member.mapKey) maps.release(member.mapKey);
  member.mapKey = undefined;
  member.maps = undefined;
}

/** Drops the hidden SVG and every cached map once no lens is left. */
function collect() {
  if (sources.size || switchLenses) return;
  host?.remove();
  host = null;
  defs = null;
  cache.clear();
}

interface Measured {
  source: Source;
  across: number;
  down: number;
  unit: number;
  from: DOMRect;
  region: Rect;
  members: Array<{ member: Member; at: DOMRect; radius: string }>;
}

/** Read phase: every rect and computed style for one source, no writes. */
function measure(source: Source): Measured {
  const { content } = source;
  const across = content.offsetWidth;
  const down = content.offsetHeight;
  const from = content.getBoundingClientRect();
  const unit = from.width / (across || 1) || 1;
  const members: Measured["members"] = [];
  for (const member of source.members) {
    if (!member.active) continue;
    members.push({ member, at: member.glass.getBoundingClientRect(), radius: getComputedStyle(member.glass).borderTopLeftRadius });
  }
  // Raster only the visible part of the source plus overscan, never its full scroll height.
  const clip = [...source.members].find((member) => member.active && member.clip)?.clip ?? null;
  const overscan = Math.max(0, ...[...source.members].map((member) => member.overscan));
  const visible = clip
    ? intersect({ x: from.left, y: from.top, width: from.width, height: from.height }, { x: clip.x - overscan, y: clip.y - overscan, width: clip.width + 2 * overscan, height: clip.height + 2 * overscan })
    : { x: from.left, y: from.top, width: from.width, height: from.height };
  const region = { x: (visible.x - from.left) / unit, y: (visible.y - from.top) / unit, width: visible.width / unit, height: visible.height / unit };
  return { source, across, down, unit, from, region, members };
}

/** Write phase: maps, graph, and attributes, skipped entirely when the placement is unchanged. */
function write({ source, across, down, unit, from, region, members }: Measured) {
  const { content } = source;
  const shown: Member[] = [];
  if (across && down && region.width > 0 && region.height > 0) {
    for (const { member, at, radius } of members) {
      if (!at.width || !at.height) continue;
      const width = at.width / unit;
      const height = at.height / unit;
      const shape = { width: Math.round(width), height: Math.round(height), radius: cornerRadius(radius, width, height) };
      const key = [shape.width, shape.height, shape.radius.toFixed(1), member.density.toFixed(3), member.dark ? 1 : 0, JSON.stringify(member.lens)].join("|");
      if (member.stale || key !== member.mapKey) {
        releaseMaps(member);
        const encoded = encode(key, shape, member.lens, member.dark, member.density);
        if (!encoded) continue;
        member.maps = encoded;
        member.mapKey = key;
        member.shape = shape;
        member.stale = false;
      }
      member.placed = {
        x: (at.left - from.left) / unit,
        y: (at.top - from.top) / unit,
        width,
        height,
        reach: member.bend * Math.min(width, height) * member.amount,
        dispersion: member.dispersion,
      };
      shown.push(member);
    }
  }
  if (!shown.length) {
    source.placed = "";
    content.style.removeProperty("filter");
    if (source.standIn) content.style.removeProperty("visibility");
    source.standIn = false;
    return;
  }
  const box = boxUnits();
  const standIn = shown.some((member) => member.replaces);
  source.standIn = standIn;
  const structure = shown.map((member) => member.mapKey).join("\n") + (standIn ? "\nstand-in" : "");
  if (structure !== source.built || !source.graph) {
    source.graph?.filter.remove();
    source.graph = graph(shown.map((member) => ({ maps: member.maps as Maps })), box, standIn);
    container().append(source.graph.filter);
    source.built = structure;
    source.placed = "";
  }
  const placed = shown.map((member) => member.placed as Placed);
  const next = placementKey([across, down, region.x, region.y, region.width, region.height, ...placed.flatMap((p) => [p.x, p.y, p.width, p.height, p.reach, p.dispersion])]);
  if (next === source.placed) return;
  source.placed = next;
  for (const member of shown) member.glass.dataset.glassRenderer = "refractive";
  place(source.graph, placed, region, across, down, box);
  source.graph.filter.id = `${source.name}-${++source.version}`;
  content.style.filter = `url("#${source.graph.filter.id}")`;
  for (const member of shown) {
    if (!member.replaces || !member.placed || !member.maps) continue;
    content.style.visibility = "visible";
    const { x, y, width, height } = member.placed;
    const behind = member.replaces.getBoundingClientRect();
    mask(member.replaces, {
      image: `url("${member.maps.shape}"), linear-gradient(#000, #000)`,
      position: `${x + (from.left - behind.left) / unit}px ${y + (from.top - behind.top) / unit}px, 0 0`,
      size: `${width}px ${height}px, 100% 100%`,
    });
  }
}

function teardown(source: Source) {
  source.graph?.filter.remove();
  source.graph = undefined;
  source.built = "";
  source.placed = "";
  source.content.style.removeProperty("filter");
  if (source.standIn) source.content.style.removeProperty("visibility");
  source.standIn = false;
}

/**
 * Runs every pending lens update: all reads first, then all writes, so layout
 * is never forced between attribute writes. Returns the time spent, for the
 * runtime's budget.
 */
export function flushMaterial(): number {
  if (!dirty.size) return 0;
  const started = performance.now();
  const pending = [...dirty];
  dirty.clear();
  const measured = pending.filter((source) => sources.get(source.content) === source).map(measure);
  for (const entry of measured) write(entry);
  return performance.now() - started;
}

export function hasPendingMaterial(): boolean {
  return dirty.size > 0;
}

function addMember(content: HTMLElement, member: Member) {
  const source = sourceFor(content);
  source.members.add(member);
  return source;
}

/** Makes `glass` a lens over `content`. The host keeps its CSS material whether or not the lens is active. */
export function attachSurface(glass: HTMLElement, content: HTMLElement, options: MaterialOptions): SurfaceHandle {
  const member: Member = { glass, lens: SURFACE_LENS, amount: 1, active: false, stale: true, ...pick(options) };
  let source: Source | null = addMember(content, member);
  let rimKey: string | undefined;
  const paintRim = () => {
    if (rimKey) rims.release(rimKey);
    rimKey = undefined;
    const width = glass.offsetWidth;
    const height = glass.offsetHeight;
    const shine = clamp(options.rim, 0, 1);
    if (!width || !height || shine <= 0) {
      glass.style.removeProperty("--lg-rim");
      glass.removeAttribute("data-rim");
      return;
    }
    const shape = { width, height, radius: cornerRadius(getComputedStyle(glass).borderTopLeftRadius, width, height) };
    const density = Math.min(member.density, 2);
    const key = [width, height, shape.radius.toFixed(1), shine.toFixed(3), density.toFixed(3)].join("|");
    const { columns, rows } = mapSize(shape, density);
    const url = rims.acquire(key, columns * rows * 4 * 2, () => {
      const map = rimMap(shape, shine, density);
      const canvas = document.createElement("canvas");
      canvas.width = map.columns;
      canvas.height = map.rows;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Glass canvas unavailable");
      const image = context.createImageData(map.columns, map.rows);
      image.data.set(map.data);
      context.putImageData(image, 0, 0);
      const value = `url("${canvas.toDataURL()}")`;
      return { value, bytes: map.columns * map.rows * 4 + value.length };
    });
    if (!url) return;
    rimKey = key;
    glass.style.setProperty("--lg-rim", url);
    glass.setAttribute("data-rim", "");
  };
  const mark = () => {
    if (source) dirty.add(source);
  };
  const handle: SurfaceHandle = {
    update(next) {
      const before = JSON.stringify([member.bend, member.dispersion, member.density, member.dark, options.rim]);
      Object.assign(options, next);
      Object.assign(member, pick(next));
      if (JSON.stringify([member.bend, member.dispersion, member.density, member.dark, options.rim]) !== before && member.active) paintRim();
      if (member.active) mark();
    },
    invalidate() {
      member.stale = true;
      if (!member.active) return;
      paintRim();
      mark();
    },
    setActive(active) {
      if (!source || active === member.active) return;
      member.active = active;
      if (active) {
        member.stale = true;
        paintRim();
        mark();
        return;
      }
      // Inactive means no filter, no maps, no frame work, not just a flag.
      releaseMaps(member);
      if (rimKey) rims.release(rimKey);
      rimKey = undefined;
      glass.style.removeProperty("--lg-rim");
      glass.removeAttribute("data-rim");
      if ([...source.members].some((other) => other.active)) mark();
      else {
        dirty.delete(source);
        teardown(source);
      }
    },
    destroy() {
      if (!source) return;
      handle.setActive(false);
      source.members.delete(member);
      if (!source.members.size) {
        teardown(source);
        dirty.delete(source);
        sources.delete(source.content);
      }
      source = null;
      collect();
    },
  };
  return handle;
}

function pick(options: MaterialOptions) {
  return { bend: options.bend, dispersion: options.dispersion, density: options.density, dark: options.dark, clip: options.clip, overscan: options.overscan };
}

/**
 * The switch thumb's lens over its own inset track, shown in place of the
 * visible bed while the thumb is lifted (upstream Switch's createLens with
 * `replaces`). Rendered synchronously within the spring frame that moves it.
 */
export function enhanceSwitch(refs: { thumb: HTMLElement; inset: HTMLElement; bed: HTMLElement }, options: { bend: number; dispersion: number; density: number; dark: boolean }): SwitchLensHandle {
  switchLenses++;
  const member: Member = {
    glass: refs.thumb,
    lens: SWITCH_LENS,
    replaces: refs.bed,
    amount: 0,
    active: false,
    stale: true,
    clip: null,
    overscan: 0,
    ...options,
  };
  let source: Source | null = addMember(refs.inset, member);
  const render = () => {
    if (!source) return;
    dirty.delete(source);
    write(measure(source));
  };
  return {
    update(next) {
      const stale = next.density !== member.density || next.dark !== member.dark;
      Object.assign(member, { bend: next.bend, dispersion: next.dispersion, density: next.density, dark: next.dark, amount: clamp(next.amount, 0, 1) });
      if (stale) member.stale = true;
      if (member.active) render();
    },
    setActive(active) {
      if (!source || active === member.active) return;
      member.active = active;
      if (!active) {
        mask(refs.bed);
        releaseMaps(member);
        teardown(source);
        return;
      }
      render();
    },
    destroy() {
      if (!source) return;
      member.active = false;
      mask(refs.bed);
      releaseMaps(member);
      teardown(source);
      sources.delete(source.content);
      source = null;
      switchLenses--;
      collect();
    },
  };
}

/** Counts for diagnostics and tests in a browser. */
export function materialStats() {
  return { sources: sources.size, switches: switchLenses, cache: cache.stats(), svg: !!host?.isConnected };
}
