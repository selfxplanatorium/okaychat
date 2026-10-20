import { converter, parse } from "culori/fn";
import "culori/css";

const hsl = converter("hsl");
const rgb = converter("rgb");
// A representative midtone of the supplied olive artwork.
const sourceColor = hsl("#9fb03e")!;
let original: Promise<ImageData> | undefined;
let requestedAccent = "";

function loadArtwork() {
  return original ??= (async () => {
    const image = new Image();
    image.src = "/icon.webp";
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    return context.getImageData(0, 0, canvas.width, canvas.height);
  })().catch((error) => {
    original = undefined;
    throw error;
  });
}

/** Shift hue and saturation while retaining the original lighting, whites and alpha. */
export function tintArtwork(source: Uint8ClampedArray, accent: string): Uint8ClampedArray<ArrayBuffer> {
  const target = hsl(parse(accent));
  const result = new Uint8ClampedArray(source);
  if (!target) return result;
  for (let i = 0; i < result.length; i += 4) {
    if (!source[i + 3]) continue;
    const color = hsl({ mode: "rgb", r: source[i]! / 255, g: source[i + 1]! / 255, b: source[i + 2]! / 255 })!;
    const tinted = rgb({
      mode: "hsl",
      h: (color.h ?? sourceColor.h!) + (target.h ?? sourceColor.h!) - sourceColor.h!,
      s: Math.min(1, color.s * target.s / sourceColor.s),
      l: color.l,
    })!;
    result[i] = Math.round(tinted.r * 255);
    result[i + 1] = Math.round(tinted.g * 255);
    result[i + 2] = Math.round(tinted.b * 255);
  }
  return result;
}

/** All brand instances and browser icons share one rendered version per accent. */
export async function applyBrandAccent(accent: string) {
  if (requestedAccent === accent) return;
  requestedAccent = accent;
  try {
    const source = await loadArtwork();
    if (requestedAccent !== accent) return;
    const canvas = document.createElement("canvas");
    canvas.width = source.width;
    canvas.height = source.height;
    canvas.getContext("2d")!.putImageData(new ImageData(tintArtwork(source.data, accent), source.width, source.height), 0, 0);
    const artwork = canvas.toDataURL("image/png");
    document.documentElement.style.setProperty("--brand-icon", `url("${artwork}")`);

    for (const [selector, size] of [["link[rel='icon']", 64], ["link[rel='apple-touch-icon']", 180]] as const) {
      const icon = document.createElement("canvas");
      icon.width = icon.height = size;
      const height = size * source.height / source.width;
      icon.getContext("2d")!.drawImage(canvas, 0, (size - height) / 2, size, height);
      document.querySelector<HTMLLinkElement>(selector)?.setAttribute("href", icon.toDataURL("image/png"));
    }
  } catch {
    // Static icons remain available if image decoding or canvas is unavailable.
    if (requestedAccent === accent) requestedAccent = "";
  }
}
