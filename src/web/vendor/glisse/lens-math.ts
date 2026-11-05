// Adapted from Glisse 0.5.0 (MIT, Copyright (c) 2026 Kelvin Zhang),
// sections src/internal/lens.ts (distance, arc, slope, lensMap) and
// src/internal/refraction.ts (rimMap). See UPSTREAM.md. Pure: no DOM.

export interface Shape {
  width: number;
  height: number;
  radius: number;
}

export interface LensOptions {
  depth: number;
  dome: number;
  splay: number;
  /** Depth and dome are fractions of the short side rather than px. */
  relative?: boolean;
}

export interface Light {
  angle: number;
  glow: number;
  spread: number;
  glowPower: number;
  edge: number;
  edgeWidth: number;
  edgePower: number;
}

export const DARK_LIGHT: Light = { angle: 45, glow: 0.4, spread: 0.5, glowPower: 1.5, edge: 0.5, edgeWidth: 2, edgePower: 1.5 };
export const LIGHT_LIGHT: Light = { angle: 30, glow: 0.4, spread: 0.5, glowPower: 2, edge: 0.5, edgeWidth: 1.5, edgePower: 1 };

/** Generic glass: a shallow dome over a quarter of the short side (upstream GLASS). */
export const SURFACE_LENS: LensOptions = { depth: 0.25, dome: 0.5, splay: 1, relative: true };
/** The switch thumb's lens over its own track (upstream switch LENS). */
export const SWITCH_LENS: LensOptions = { depth: 2, dome: 6, splay: 0.4 };

export const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const erf = (x: number) => Math.tanh(1.7724538509 * x);

/** Signed distance to a rounded rectangle centred on the origin. */
export function distance(x: number, y: number, halfWidth: number, halfHeight: number, radius: number): number {
  const qx = Math.abs(x) - halfWidth + radius;
  const qy = Math.abs(y) - halfHeight + radius;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

function arc(sag: number, half: number) {
  const radius = (half * half + sag * sag) / (2 * sag);
  let sum = 0;
  for (let i = 0; i <= 200; i++) {
    const x = (i / 200) * half;
    const slope = x / Math.sqrt(radius * radius - x * x);
    sum += i === 0 || i === 200 ? slope / 2 : slope;
  }
  const mean = sum / 200;
  return { radius, scale: mean > 0 ? 0.5 / mean : 1 };
}

const slope = (x: number, { radius, scale }: { radius: number; scale: number }) => {
  const inside = Math.min(x, 0.999 * radius);
  return (inside / Math.sqrt(radius * radius - inside * inside)) * scale;
};

export interface LensMap {
  columns: number;
  rows: number;
  across: Uint8ClampedArray;
  down: Uint8ClampedArray;
  light: Uint8ClampedArray;
  shape: Uint8ClampedArray;
}

export function mapSize(shape: Shape, density: number) {
  return { columns: Math.max(1, Math.round(shape.width * density)), rows: Math.max(1, Math.round(shape.height * density)) };
}

/**
 * A lens's displacement maps: within a band about `depth` wide around the
 * rim, each point shows content from further in, by the slope of a shallow
 * dome; the middle is left exactly as it is. Unchanged from upstream.
 */
export function lensMap(shape: Shape, options: LensOptions, light: Light, density: number): LensMap {
  const { width, height } = shape;
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const radius = clamp(shape.radius, 0, Math.min(halfWidth, halfHeight));
  const { columns, rows } = mapSize(shape, density);
  const pullAcross = new Uint8ClampedArray(columns * rows * 4);
  const pullDown = new Uint8ClampedArray(columns * rows * 4);
  const caught = new Uint8ClampedArray(columns * rows * 4);
  const shapeMask = new Uint8ClampedArray(columns * rows * 4);
  const grey = (data: Uint8ClampedArray, i: number, value: number, alpha = 255) => {
    data[i] = data[i + 1] = data[i + 2] = value;
    data[i + 3] = alpha;
  };
  const share = options.relative ? Math.min(width, height) : 1;
  const depth = options.depth * share;
  const dome = options.dome * share;
  const { splay } = options;
  const innerWidth = Math.max(0, halfWidth - depth);
  const innerHeight = Math.max(0, halfHeight - depth);
  const innerRadius = clamp(radius, 0, Math.min(innerWidth, innerHeight));
  const ramp = depth > 0 ? 1 / (depth * Math.SQRT2) : 1e6;
  const sag = Math.max(0.01, Math.min(dome, Math.min(halfWidth, halfHeight) - 1));
  const across = dome > 0 ? arc(sag, halfWidth) : null;
  const down = dome > 0 ? arc(sag, halfHeight) : null;
  const reach = 0.5 * Math.min(halfWidth, halfHeight);
  const cos = Math.cos((light.angle * Math.PI) / 180);
  const sin = Math.sin((light.angle * Math.PI) / 180);
  const glowStart = (1 - light.spread) * Math.SQRT2;
  const glowRange = light.spread * Math.SQRT2;
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const i = (row * columns + column) * 4;
      const x = ((column + 0.5) / columns) * width - halfWidth;
      const y = ((row + 0.5) / rows) * height - halfHeight;
      const edge = distance(x, y, halfWidth, halfHeight, radius);
      const inside = Math.round(255 * clamp(-edge, 0, 1));
      grey(shapeMask, i, 0, inside);
      if (edge >= 0) {
        grey(pullAcross, i, 128);
        grey(pullDown, i, 128);
        grey(caught, i, 128, 0);
        continue;
      }
      const ax = Math.abs(x);
      const ay = Math.abs(y);
      let dx = across ? Math.sign(x) * slope(ax, across) : clamp(x / halfWidth, -1, 1);
      let dy = down ? Math.sign(y) * slope(ay, down) : clamp(y / halfHeight, -1, 1);
      if (splay < 1 && reach > 0) {
        const keepX = Math.max(0, 1 - (halfHeight - ay) / reach) * (1 - splay);
        const keepY = Math.max(0, 1 - (halfWidth - ax) / reach) * (1 - splay);
        if (keepX > 0.001 || keepY > 0.001) {
          const before = Math.hypot(dx, dy);
          dx *= 1 - keepX;
          dy *= 1 - keepY;
          const after = Math.hypot(dx, dy);
          if (after > 0.001) {
            dx *= before / after;
            dy *= before / after;
          }
        }
      }
      const falloff = 0.5 * (1 + erf(distance(x, y, innerWidth, innerHeight, innerRadius) * ramp));
      grey(shapeMask, i, Math.round(255 * falloff), inside);
      grey(pullAcross, i, Math.round((0.5 - 0.5 * dx * falloff) * 255));
      grey(pullDown, i, Math.round((0.5 - 0.5 * dy * falloff) * 255));
      const facing = Math.abs(clamp(x / halfWidth, -1, 1) * cos + clamp(y / halfHeight, -1, 1) * sin);
      const glow = glowRange > 0.001 ? light.glow * clamp((facing - glowStart) / glowRange, 0, 1) ** light.glowPower * falloff : 0;
      const rim = light.edge * Math.max(0, 1 + edge / light.edgeWidth) * facing ** light.edgePower;
      const amount = Math.min(1, glow + rim);
      const bends = Math.min(1, falloff * 20, -edge);
      grey(caught, i, Math.round(127 * amount + 128), Math.round(255 * bends));
    }
  }
  return { columns, rows, across: pullAcross, down: pullDown, light: caught, shape: shapeMask };
}

const RIM_WIDTH = 1.22;
const EDGE_WIDTH = 0.5;

/** The rim's white light over its edge line. Unchanged from upstream apart from types. */
export function rimMap({ width, height, radius }: Shape, shine: number, density: number, edge: [number, number, number, number] = [0, 0, 0, 0]) {
  const columns = Math.max(1, Math.round(width * density));
  const rows = Math.max(1, Math.round(height * density));
  const data = new Uint8ClampedArray(columns * rows * 4);
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const corner = clamp(radius, 0, Math.min(halfWidth, halfHeight));
  const half = 0.5 / density;
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const x = ((column + 0.5) / columns) * width - halfWidth;
      const y = ((row + 0.5) / rows) * height - halfHeight;
      const depth = -distance(x, y, halfWidth, halfHeight, corner);
      if (depth < -half || depth > 2 * RIM_WIDTH) continue;
      const qx = Math.abs(x) - halfWidth + corner;
      const qy = Math.abs(y) - halfHeight + corner;
      let nx = 0;
      let ny = 0;
      if (qx > 0 && qy > 0) {
        const length = Math.hypot(qx, qy);
        nx = (Math.sign(x) * qx) / length;
        ny = (Math.sign(y) * qy) / length;
      } else if (qx > qy) nx = Math.sign(x);
      else ny = Math.sign(y);
      const facing = Math.abs(nx + ny);
      const along = Math.max(0, depth) / (RIM_WIDTH * Math.sqrt(Math.max(1, facing)));
      const cover = clamp((depth + half) * density, 0, 1);
      const lined = clamp((Math.min(EDGE_WIDTH, depth + half) - Math.max(0, depth - half)) * density, 0, 1);
      const light = along < 1 ? shine * Math.min(1, facing) ** 1.5 * (1 - along ** 1.5) * cover : 0;
      const line = edge[3] * lined * (1 - light);
      const alpha = light + line;
      if (alpha <= 0) continue;
      const i = (row * columns + column) * 4;
      for (let channel = 0; channel < 3; channel++) data[i + channel] = Math.round((255 * light + (edge[channel] ?? 0) * line) / alpha);
      data[i + 3] = Math.round(255 * alpha);
    }
  }
  return { columns, rows, data };
}

/** Radius of a computed `border-top-left-radius`, clamped to the box. Square-corner mode yields 0. */
export function cornerRadius(corner: string, width: number, height: number): number {
  const value = corner.endsWith("%") ? (Math.min(width, height) * parseFloat(corner)) / 100 : parseFloat(corner) || 0;
  return Math.min(width / 2, height / 2, value);
}

/** Intersection of two rects; zero-sized when they do not overlap. */
export function intersect(a: Rect, b: Rect): Rect {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Placement string compared before writing, so unchanged geometry costs no SVG writes. */
export function placementKey(values: readonly number[]): string {
  return values.map((value) => value.toFixed(2)).join(" ");
}
