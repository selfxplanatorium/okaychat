import { SimpleMarkdown } from "@/components/ui/simple-markdown";
import { t } from "@/i18n";

/** Safe Markdown preview for a standalone note: no raw HTML, remote images need consent. */
export function NotePreview({ body }: { body: string }) {
  if (!body.trim()) {
    return <p className="text-muted-foreground py-8 text-sm">{t("notes.emptyBody")}</p>;
  }
  return (
    <div
      className="max-w-none"
      onClickCapture={(event) => {
        const anchor = (event.target as Element).closest("a");
        if (!anchor) return;
        const href = anchor.getAttribute("href") ?? "";
        const safe = /^https?:\/\//i.test(href) || (href.startsWith("/") && !href.startsWith("//"));
        if (!safe) event.preventDefault();
      }}
    >
      <SimpleMarkdown imagePolicy="remote">{body}</SimpleMarkdown>
    </div>
  );
}
