import { type ComponentProps, type FC, useRef, useState } from "react";
import { DownloadIcon, Maximize2Icon, Minimize2Icon, CodeXmlIcon, TextIcon } from "lucide-react";

import { CopyFeedbackIcon } from "@/components/assistant-ui/elements/surfaces";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { cn } from "@/lib/utils";

type Format = "csv" | "markdown" | "plain";

const readRows = (table: HTMLTableElement): string[][] =>
  Array.from(table.rows, (row) =>
    Array.from(row.cells, (cell) => (cell.textContent ?? "").replace(/\s+/g, " ").trim()),
  );

const csvCell = (value: string) => (/[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);

function serialize(rows: string[][], format: Format): string {
  if (format === "csv") return rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
  // Tab-separated, so a paste into a spreadsheet keeps the columns.
  if (format === "plain") return rows.map((r) => r.join("\t")).join("\n");
  const line = (r: string[]) => `| ${r.map((c) => c.replace(/\|/g, "\\|")).join(" | ")} |`;
  const [head = [], ...body] = rows;
  return [line(head), line(head.map(() => "---")), ...body.map(line)].join("\n");
}

function download(text: string, format: "csv" | "markdown") {
  // The BOM makes Excel read the CSV as UTF-8.
  const blob = format === "csv"
    ? new Blob(["﻿", text], { type: "text/csv;charset=utf-8" })
    : new Blob([text], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = format === "csv" ? "table.csv" : "table.md";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

const MarkdownIcon: FC<{ className?: string }> = ({ className }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden className={className}>
    <path d="M3 17V7l4 5 4-5v10" />
    <path d="M17 7v10m-3-3 3 3 3-3" />
  </svg>
);

const formatItems = [
  { format: "csv", label: "CSV", icon: <CodeXmlIcon /> },
  { format: "markdown", label: "Markdown", icon: <MarkdownIcon /> },
] as const;

export const MarkdownTable: FC<ComponentProps<"table">> = ({ className, children, ...props }) => {
  const tableRef = useRef<HTMLTableElement>(null);
  const copyRef = useRef<HTMLButtonElement>(null);
  // Column widths measured before expanding, so wrapping cells keep the collapsed layout.
  const [widths, setWidths] = useState<number[] | null>(null);
  const expanded = widths !== null;

  const toggleExpanded = () => {
    const table = tableRef.current;
    if (expanded || !table?.rows[0]) return setWidths(null);
    setWidths(Array.from(table.rows[0].cells, (cell) => cell.getBoundingClientRect().width));
  };
  const [copyMenuOpen, setCopyMenuOpen] = useState(false);
  const { isCopied, copyToClipboard } = useCopyToClipboard();

  const text = (format: Format) => (tableRef.current ? serialize(readRows(tableRef.current), format) : "");

  return (
    <div
      className="aui-md-table-wrapper border-border/60 bg-muted/20 my-3 overflow-hidden rounded-xl border"
      data-expanded={expanded}
    >
      <div
        className={cn(
          "overflow-x-auto overscroll-x-none",
          expanded
            ? "max-h-[32rem] overflow-y-auto [&_td]:align-top [&_td]:break-words [&_thead]:sticky [&_thead]:top-0 [&_thead]:z-10"
            : "[&_td]:max-w-72 [&_td]:truncate [&_td]:whitespace-nowrap",
        )}
      >
        <table
          ref={tableRef}
          className={cn("aui-md-table w-full border-separate border-spacing-0 text-sm", expanded && "table-fixed", className)}
          style={widths ? { width: widths.reduce((a, b) => a + b, 0) } : undefined}
          {...props}
        >
          {widths && (
            <colgroup>
              {widths.map((w, i) => <col key={i} style={{ width: w }} />)}
            </colgroup>
          )}
          {children}
        </table>
      </div>
      <div className="border-border/60 flex items-center justify-between gap-2 border-t px-2 py-1.5">
        <TooltipIconButton
          tooltip={expanded ? "Collapse all cells" : "Expand all cells"}
          side="top"
          aria-pressed={expanded}
          onClick={toggleExpanded}
        >
          {expanded ? <Minimize2Icon aria-hidden /> : <Maximize2Icon aria-hidden />}
        </TooltipIconButton>
        <div className="flex items-center gap-1">
          <Menu>
            <MenuTrigger render={<TooltipIconButton tooltip="Download table" side="top" />}>
              <DownloadIcon aria-hidden />
            </MenuTrigger>
            <MenuContent side="bottom" align="end" className="min-w-36">
              {formatItems.map(({ format, label, icon }) => (
                <MenuItem key={format} onClick={() => download(text(format), format)}>
                  {icon} {label}
                </MenuItem>
              ))}
            </MenuContent>
          </Menu>
          <TooltipIconButton
            ref={copyRef}
            tooltip={<>Copy table contents<br /><span className="text-muted-foreground">(right click for more)</span></>}
            side="top"
            onClick={() => copyToClipboard(text("plain"))}
            onContextMenu={(e) => {
              e.preventDefault();
              setCopyMenuOpen(true);
            }}
          >
            <CopyFeedbackIcon copied={isCopied} />
          </TooltipIconButton>
          <Menu open={copyMenuOpen} onOpenChange={setCopyMenuOpen}>
            <MenuContent side="bottom" align="end" anchor={copyRef} className="min-w-36">
              {formatItems.map(({ format, label, icon }) => (
                <MenuItem key={format} onClick={() => copyToClipboard(text(format))}>
                  {icon} {label}
                </MenuItem>
              ))}
              <MenuItem onClick={() => copyToClipboard(text("plain"))}>
                <TextIcon /> Plain
              </MenuItem>
            </MenuContent>
          </Menu>
        </div>
      </div>
    </div>
  );
};
