import { createRequire } from "node:module";
import path from "node:path";
import { JobError, withBrowserPage, type ScreenshotResult } from "./render.js";

// Offline viewers for built documents: pdf.js for PDFs and docx-preview for Word files, both served from this
// worker's own node_modules on the document origin. Nothing reaches the network.

const require = createRequire(import.meta.url);
const pdfjsRoot = () => path.dirname(require.resolve("pdfjs-dist/package.json"));
const docxPreviewFile = () => require.resolve("docx-preview");
const jszipFile = () => path.join(path.dirname(require.resolve("jszip/package.json")), "dist", "jszip.min.js");

export interface PageShot extends ScreenshotResult {
  label: string;
}

function pdfViewer(pageNumber: number): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<style>
  html,body{margin:0;background:#e9e9ec;font:12px system-ui,sans-serif}
  #stage{display:flex;justify-content:center;padding:16px}
  canvas{display:block;background:#fff;box-shadow:0 1px 8px rgba(0,0,0,.18);max-width:100%;height:auto}
</style></head><body><div id="stage"></div>
<script type="module">
try {
  const pdfjs = await import("/pdfjs/build/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdfjs/build/pdf.worker.mjs";
  const doc = await pdfjs.getDocument({
    url: "/file.pdf",
    cMapUrl: "/pdfjs/cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/pdfjs/standard_fonts/",
  }).promise;
  window.__pages = doc.numPages;
  if (${pageNumber} > doc.numPages) throw new Error("This PDF has " + doc.numPages + " page" + (doc.numPages === 1 ? "" : "s") + ".");
  const page = await doc.getPage(${pageNumber});
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: Math.min(2.5, 1000 / base.width) });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  document.getElementById("stage").append(canvas);
  await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
  window.__ready = true;
} catch (error) {
  window.__error = error?.message ?? String(error);
}
</script></body></html>`;
}

const capitalize = (text: string) => (text ? text[0]!.toUpperCase() + text.slice(1) : text);

export async function screenshotPdfPage(data: Uint8Array, pageNumber: number, signal?: AbortSignal): Promise<PageShot> {
  return withBrowserPage(
    pdfViewer(pageNumber),
    {
      width: 1060,
      resources: { "/file.pdf": { contentType: "application/pdf", bytes: data } },
      roots: { "/pdfjs/": pdfjsRoot() },
      waitFor: "window.__ready === true || !!window.__error",
    },
    async ({ page, errors }) => {
      const failure = await page.evaluate(() => (window as unknown as { __error?: string }).__error);
      if (failure) throw new JobError(capitalize(failure));
      const canvas = page.locator("#stage canvas");
      const box = await canvas.boundingBox();
      const png = await canvas.screenshot({ type: "png" });
      const pages = await page.evaluate(() => (window as unknown as { __pages?: number }).__pages ?? 1);
      return {
        png: new Uint8Array(png),
        width: Math.round(box?.width ?? 1000),
        height: Math.round(box?.height ?? 1400),
        label: `page ${pageNumber} of ${pages}`,
        errors,
      };
    },
    signal,
  );
}

function docxViewer(): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<style>
  html,body{margin:0;background:#e9e9ec}
  #doc{display:flex;justify-content:center;padding:16px}
</style></head><body><div id="doc"></div>
<script src="/vendor/jszip.min.js"></script>
<script src="/vendor/docx-preview.js"></script>
<script>
(async () => {
  try {
    const buf = await (await fetch("/file.docx")).arrayBuffer();
    await docx.renderAsync(buf, document.getElementById("doc"), null, {
      className: "docx",
      inWrapper: true,
      breakPages: true,
      renderHeaders: true,
      renderFooters: true,
      ignoreWidth: false,
      ignoreHeight: false,
    });
    window.__pages = document.querySelectorAll("#doc .docx-wrapper > section.docx").length;
    window.__ready = true;
  } catch (error) {
    window.__error = error?.message ?? String(error);
  }
})();
</script></body></html>`;
}

export async function screenshotDocxPage(data: Uint8Array, pageNumber: number, signal?: AbortSignal): Promise<PageShot> {
  return withBrowserPage(
    docxViewer(),
    {
      width: 1000,
      resources: {
        "/file.docx": { contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", bytes: data },
        "/vendor/jszip.min.js": { contentType: "text/javascript", file: jszipFile() },
        "/vendor/docx-preview.js": { contentType: "text/javascript", file: docxPreviewFile() },
      },
      waitFor: "window.__ready === true || !!window.__error",
    },
    async ({ page, errors }) => {
      const failure = await page.evaluate(() => (window as unknown as { __error?: string }).__error);
      if (failure) throw new JobError(capitalize(failure));
      const pages = await page.evaluate(() => (window as unknown as { __pages?: number }).__pages ?? 0);
      if (!pages) throw new JobError("The Word file rendered no pages.");
      if (pageNumber > pages) throw new JobError(`This Word file has ${pages} page${pages === 1 ? "" : "s"}.`);
      const section = page.locator("#doc .docx-wrapper > section.docx").nth(pageNumber - 1);
      const box = await section.boundingBox();
      const png = await section.screenshot({ type: "png" });
      return {
        png: new Uint8Array(png),
        width: Math.round(box?.width ?? 816),
        height: Math.round(box?.height ?? 1056),
        label: `page ${pageNumber} of ${pages}`,
        errors,
      };
    },
    signal,
  );
}
