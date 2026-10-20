import { FileSpreadsheetIcon, Loader2Icon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { DocumentArtifactKind, SheetPreview } from "@shared/types";
import { cn } from "@/lib/utils";

// Document previews run in the user's browser only:
//  - PDF: the browser's own viewer,
//  - DOCX: docx-preview renders the OOXML on a canvas-free DOM, so Word pages look close to Word,
//  - XLSX: a grid built from the server's SheetPreview JSON.
// Nothing here needs the server browser that builds the files.

interface Props {
  kind: DocumentArtifactKind;
  /** Same-origin URL that serves the file bytes. */
  fileUrl: string;
  /** Same-origin URL that serves SheetPreview[] for xlsx. */
  previewUrl: string;
  title: string;
  className?: string;
}

export function DocumentPreview({ kind, fileUrl, previewUrl, title, className }: Props) {
  if (kind === "pdf") {
    return <iframe title={title} src={fileUrl} className={cn("h-full w-full border-0 bg-white", className)} />;
  }
  if (kind === "docx") return <DocxPreview url={fileUrl} title={title} className={className} />;
  return <SheetPreviewGrid url={previewUrl} title={title} className={className} />;
}

// Also used by the Library for uploaded Word files, which have no sheet-preview endpoint.
export { DocxPreview };

function DocxPreview({ url, title, className }: { url: string; title: string; className?: string }) {
  const container = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      const response = await fetch(url);
      if (!response.ok) throw new Error("Could not load the document.");
      const data = await response.arrayBuffer();
      const { renderAsync } = await import("docx-preview");
      if (cancelled || !container.current) return;
      container.current.replaceChildren();
      await renderAsync(data, container.current, undefined, {
        className: "docx",
        inWrapper: true,
        breakPages: true,
        renderHeaders: true,
        renderFooters: true,
      });
    })()
      .catch((e: Error) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [url]);
  return (
    <div className={cn("bg-muted/30 h-full overflow-auto", className)}>
      {loading && !error && (
        <div className="text-muted-foreground flex h-24 items-center justify-center gap-2 text-sm">
          <Loader2Icon className="size-4 animate-spin" /> Loading {title}
        </div>
      )}
      {error && <p className="text-muted-foreground p-4 text-sm">{error}</p>}
      {/* docx-preview injects its own stylesheet and page wrappers here. */}
      <div ref={container} className="docx-host mx-auto max-w-[900px] p-4" />
    </div>
  );
}

function SheetPreviewGrid({ url, title, className }: { url: string; title: string; className?: string }) {
  const [sheets, setSheets] = useState<SheetPreview[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setSheets(null);
    fetch(url)
      .then((r) => (r.ok ? (r.json() as Promise<SheetPreview[]>) : Promise.reject(new Error("Could not read the spreadsheet."))))
      .then((data) => !cancelled && setSheets(data))
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [url]);
  const sheet = sheets?.[active];
  return (
    <div className={cn("flex h-full flex-col bg-white", className)}>
      {error && <p className="text-muted-foreground p-4 text-sm">{error}</p>}
      {!sheets && !error && (
        <div className="text-muted-foreground flex h-24 items-center justify-center gap-2 text-sm">
          <Loader2Icon className="size-4 animate-spin" /> Loading {title}
        </div>
      )}
      {sheets && sheets.length > 1 && (
        <div className="bg-muted/40 flex shrink-0 gap-1 overflow-x-auto border-b px-2 py-1.5">
          {sheets.map((s, i) => (
            <button
              key={s.name}
              type="button"
              onClick={() => setActive(i)}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs whitespace-nowrap transition-colors",
                i === active ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
      {sheet && (
        <div className="min-w-0 flex-1 overflow-auto p-4">
          <table className="border-collapse text-xs" style={{ tableLayout: "fixed" }}>
            <colgroup>
              <col style={{ width: 44 }} />
              {sheet.columns.map((width, i) => (
                <col key={i} style={{ width: Math.min(Math.max(width, 6), 60) * 7 + 10 }} />
              ))}
            </colgroup>
            <tbody>
              <tr>
                <th className="bg-muted text-muted-foreground border px-1 py-0.5 font-normal" />
                {sheet.columns.map((_, i) => (
                  <th key={i} className="bg-muted text-muted-foreground border px-1 py-0.5 text-center font-normal">
                    {columnName(i + 1)}
                  </th>
                ))}
              </tr>
              {sheet.rows.map((row, r) => (
                <tr key={r} style={row.height ? { height: row.height } : undefined}>
                  <th className="bg-muted text-muted-foreground border px-1 py-0.5 text-center font-normal">{r + 1}</th>
                  {row.cells.map((cell, c) => {
                    if (cell === null) return null;
                    const merge = sheet.merges.find((m) => m.top === r + 1 && m.left === c + 1);
                    return (
                      <td
                        key={c}
                        colSpan={merge ? merge.right - merge.left + 1 : undefined}
                        rowSpan={merge ? merge.bottom - merge.top + 1 : undefined}
                        title={cell.t}
                        className="max-w-0 truncate border px-1.5 py-0.5 align-top"
                        style={{
                          color: cell.color,
                          background: cell.bg,
                          fontWeight: cell.b ? 600 : undefined,
                          fontStyle: cell.i ? "italic" : undefined,
                          textDecoration: cell.u ? "underline" : undefined,
                          textAlign: cell.align,
                          fontSize: cell.size ? `${cell.size}pt` : undefined,
                          whiteSpace: cell.wrap ? "pre-wrap" : undefined,
                        }}
                      >
                        {cell.t}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          {sheet.truncated && <p className="text-muted-foreground mt-2 text-xs">Preview limited to the first rows and columns.</p>}
        </div>
      )}
      {!sheet && sheets && <p className="text-muted-foreground p-4 text-sm">This workbook has no sheets.</p>}
      {sheet && sheet.rows.length === 0 && (
        <p className="text-muted-foreground flex items-center gap-2 px-4 pb-4 text-sm">
          <FileSpreadsheetIcon className="size-4" /> Empty sheet
        </p>
      )}
    </div>
  );
}

function columnName(n: number): string {
  let name = "";
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) name = String.fromCharCode(65 + ((x - 1) % 26)) + name;
  return name;
}
