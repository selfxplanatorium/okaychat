import { t } from "@/i18n";
import { responseError } from "@/lib/api";

export type ThreadExportFormat = "markdown" | "pdf";

/** Downloads a chat export. The server names the file; the title is only a fallback. */
export async function exportThread(threadId: string, format: ThreadExportFormat, title?: string | null) {
  const path = `/threads/${encodeURIComponent(threadId)}/export?format=${format}`;
  const res = await fetch(`/api${path}`, { credentials: "same-origin" });
  // A PDF export runs on the server: its outage must refresh the registry, like any other failed action.
  if (!res.ok) throw await responseError(res, path, t("composer.exportFailed"));
  const disposition = res.headers.get("content-disposition") ?? "";
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const plain = disposition.match(/filename="?([^";]+)"?/i)?.[1];
  const name = (encoded && decodeURIComponent(encoded)) || plain || `${(title || "chat").replace(/[\\/:*?"<>|]+/g, " ").trim() || "chat"}.${format === "pdf" ? "pdf" : "md"}`;
  const href = URL.createObjectURL(await res.blob());
  Object.assign(document.createElement("a"), { href, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}
