import type { ArtifactKind } from "./types.js";

// Shared by the web artifact frame and the server screenshotter, so the model sees the same document
// the user sees. No DOM APIs here: each function returns an HTML string.

export const FRAME_SANDBOX = "allow-scripts allow-forms allow-modals allow-popups allow-downloads";

/** Public hosts a rendered artifact may load from. Everything else stays blocked. */
export const FRAME_NETWORK_HOSTS = ["cdn.jsdelivr.net", "esm.sh", "unpkg.com", "fonts.googleapis.com", "fonts.gstatic.com"];

const CDN = FRAME_NETWORK_HOSTS.map((host) => `https://${host}`).join(" ");

/**
 * Artifact code is model-written and can be steered by anything the model read. It may load libraries and
 * fonts from the CDNs above but cannot send data anywhere else: no fetch, beacons, images, or form posts
 * to other hosts. Meta CSPs only tighten, so content later in the document cannot loosen this.
 */
const FRAME_CSP = [
  "default-src 'none'",
  `script-src 'unsafe-inline' 'unsafe-eval' blob: ${CDN}`,
  `style-src 'unsafe-inline' ${CDN}`,
  `font-src data: ${CDN}`,
  `img-src data: blob: ${CDN}`,
  "media-src data: blob:",
  `connect-src ${CDN}`,
  "worker-src blob:",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");
const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">`;

/** The policy goes first, before any model-written markup can run or open a request. */
function withCsp(html: string): string {
  const doctype = html.match(/^\s*<!doctype[^>]*>/i)?.[0] ?? "";
  return doctype + CSP_META + html.slice(doctype.length);
}

const json = (value: string) => JSON.stringify(value).replaceAll("</", "<\\/");

// Sandboxed frames throw on storage access, which breaks many libraries. Give them per-frame memory storage.
const FRAME_PRELUDE = `<script>
for (const name of ["localStorage", "sessionStorage"]) {
  try { window[name].length; } catch {
    const data = new Map();
    const storage = {
      get length() { return data.size; },
      key: (i) => [...data.keys()][i] ?? null,
      getItem: (k) => (data.has(String(k)) ? data.get(String(k)) : null),
      setItem: (k, v) => void data.set(String(k), String(v)),
      removeItem: (k) => void data.delete(String(k)),
      clear: () => data.clear(),
    };
    Object.defineProperty(window, name, { value: storage, configurable: true });
  }
}
function __showError(message) {
  let el = document.getElementById("__artifact_error");
  if (!el) {
    el = document.createElement("pre");
    el.id = "__artifact_error";
    el.style.cssText = "position:fixed;inset:auto 8px 8px 8px;max-height:40%;overflow:auto;margin:0;padding:10px 12px;border-radius:8px;background:#fef2f2;color:#991b1b;font:12px/1.5 ui-monospace,monospace;white-space:pre-wrap;z-index:2147483647;border:1px solid #fecaca";
    (document.body ?? document.documentElement).appendChild(el);
  }
  el.textContent = message;
}
addEventListener("error", (e) => __showError(e.message || String(e.error)));
addEventListener("unhandledrejection", (e) => __showError(String(e.reason?.message ?? e.reason)));
</script>`;

/**
 * React artifacts: Babel compiles TSX in the frame, bare imports resolve through esm.sh with React kept
 * external so every package shares one React, and Tailwind's browser build styles class names.
 */
function reactDocument(source: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${FRAME_PRELUDE}
<script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>
<script src="https://cdn.jsdelivr.net/npm/@babel/standalone@7/babel.min.js"></script>
<script type="importmap">{"imports":{"react":"https://esm.sh/react@19","react/":"https://esm.sh/react@19/","react-dom":"https://esm.sh/react-dom@19","react-dom/":"https://esm.sh/react-dom@19/"}}</script>
</head><body><div id="root"></div>
<script type="module">
const source = ${json(source)};
const isReact = (spec) => /^react(-dom)?(\\/|$)/.test(spec);
const toUrl = (spec) => spec.includes("://") || isReact(spec) ? spec : "https://esm.sh/" + spec + (spec.includes("?") ? "&" : "?") + "external=react,react-dom";
try {
  const { code } = Babel.transform(source, {
    filename: "artifact.tsx",
    presets: [["react", { runtime: "automatic" }], ["typescript", { isTSX: true, allExtensions: true }]],
  });
  const rewritten = code.replace(/(\\bfrom\\s*|\\bimport\\s*\\(?\\s*)(["'])([^"'.\\/][^"']*)\\2/g, (_, pre, q, spec) => pre + q + toUrl(spec) + q);
  const mod = await import(URL.createObjectURL(new Blob([rewritten], { type: "text/javascript" })));
  const App = mod.default ?? Object.values(mod).find((v) => typeof v === "function");
  if (!App) throw new Error("The artifact has no default-exported component.");
  const [{ createElement }, { createRoot }] = await Promise.all([import("react"), import("react-dom/client")]);
  createRoot(document.getElementById("root")).render(createElement(App));
} catch (e) {
  __showError(e?.message ?? String(e));
}
</script></body></html>`;
}

function svgDocument(source: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{height:100%;margin:0}body{display:grid;place-items:center;padding:16px;box-sizing:border-box}svg{max-width:100%;max-height:100%;height:auto}</style></head><body>${source}</body></html>`;
}

function htmlDocument(source: string): string {
  // Inject the prelude first so storage works and runtime errors are visible instead of a blank frame.
  return /<head[^>]*>/i.test(source) ? source.replace(/<head[^>]*>/i, (m) => m + FRAME_PRELUDE) : FRAME_PRELUDE + source;
}

export function frameDocument(kind: ArtifactKind, content: string): string | null {
  if (kind === "html") return withCsp(htmlDocument(content));
  if (kind === "react") return withCsp(reactDocument(content));
  if (kind === "svg") return withCsp(svgDocument(content));
  return null;
}
