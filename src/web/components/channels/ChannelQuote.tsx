import { CornerUpLeftIcon } from "lucide-react";
import type { ChannelQuote as Quote } from "@shared/channels";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";

export function ChannelQuote({ quote, onClick, className }: { quote: Quote; onClick?: () => void; className?: string }) {
  const content = quote.deleted || !quote.excerpt ? t("channels.quoteUnavailable") : quote.excerpt;
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "border-border/70 bg-muted/40 text-muted-foreground hover:bg-muted/60 flex max-w-full items-start gap-1.5 rounded-lg border-s-2 px-2 py-1 text-start text-xs transition-colors",
        className,
      )}
    >
      <CornerUpLeftIcon aria-hidden className="mt-0.5 size-3 shrink-0" />
      <span className="min-w-0">
        {quote.authorName && !quote.deleted && <span className="text-foreground font-medium">{quote.authorName}: </span>}
        <span className="line-clamp-2 break-words">{content}</span>
      </span>
    </button>
  );
}
