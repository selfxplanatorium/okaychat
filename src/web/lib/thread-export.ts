import { t } from "@/i18n";

export type ThreadExportFormat = "markdown" | "pdf";

/** Downloads a chat export. The server names the file; the title is only a fallback. */
export async function exportThread(threadId: string, format: ThreadExportFormat, title?: string | null) {
  const res = await fetch(`/api/threads/${encodeURIComponent(threadId)}/export?format=${format}`, { credentials: "same-origin" });
  if (!res.ok) {
    const body = res.headers.get("content-type")?.includes("json") ? ((await res.json()) as { error?: string }) : null;
    throw new Error(body?.error ?? t("composer.exportFailed"));
  }
  const disposition = res.headers.get("content-disposition") ?? "";
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const plain = disposition.match(/filename="?([^";]+)"?/i)?.[1];
  const name = (encoded && decodeURIComponent(encoded)) || plain || `${(title || "chat").replace(/[\\/:*?"<>|]+/g, " ").trim() || "chat"}.${format === "pdf" ? "pdf" : "md"}`;
  const href = URL.createObjectURL(await res.blob());
  Object.assign(document.createElement("a"), { href, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}
