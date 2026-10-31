import { AlertCircleIcon, CheckCircle2Icon, DownloadIcon, MailIcon, MailOpenIcon, PaperclipIcon, SearchIcon, SendIcon, FolderIcon } from "lucide-react";
import type { EmailAttachmentInfo, EmailFolder, EmailMessage, EmailMessageSummary } from "@shared/email";
import type { InjectionReport } from "@shared/types";
import { t } from "@/i18n";
import { formatBytes, formatDateTime, formatList } from "@/i18n/format";
import { cn } from "@/lib/utils";
import { ToolShell } from "./tool-ui";

// Email tool cards. List/search/read rows show who, what, when, unread state, and attachment names;
// read bodies are plain text from the server, never HTML. Send/reply cards show the exact approved
// payload (recipients, subject, body) before the approval is answered.

type Unknown = Record<string, unknown> | undefined;

const addresses = (list: Array<{ name?: string; address: string }> | undefined) =>
  formatList((list ?? []).map((entry) => entry.name ? `${entry.name} <${entry.address}>` : entry.address));

function safeDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : formatDateTime(date);
}

function MessageRow({ message }: { message: EmailMessageSummary }) {
  const date = safeDate(message.date);
  return (
    <li className="flex min-w-0 flex-col gap-0.5 border-b py-2 last:border-b-0">
      <div className="flex min-w-0 items-center gap-2">
        {message.unread ? <span aria-hidden className="bg-primary size-1.5 shrink-0 rounded-full" /> : null}
        {message.unread ? <span className="sr-only">{t("email.unread")}</span> : null}
        <span className={cn("min-w-0 flex-1 truncate text-xs", message.unread && "font-medium")}>{message.subject || t("email.noSubject")}</span>
        {date ? <time dateTime={message.date ?? undefined} className="text-muted-foreground shrink-0 text-[10px]">{date}</time> : null}
      </div>
      <div className="flex min-w-0 items-center gap-2 text-[10px] text-muted-foreground">
        <span className="truncate">{addresses(message.from)}</span>
        {message.hasAttachments ? <PaperclipIcon aria-label={t("email.hasAttachments")} className="size-3 shrink-0" /> : null}
      </div>
    </li>
  );
}

export function EmailFoldersCard({ args, result, status }: { args: Unknown; result?: unknown; status: { type: string } | undefined }) {
  const a = (args ?? {}) as { accountId?: string };
  const r = typeof result === "object" && result ? (result as { account?: { address?: string }; folders?: EmailFolder[]; injection?: unknown }) : undefined;
  const running = status?.type === "running";
  const folders = r?.folders ?? [];
  const address = r?.account?.address ?? a.accountId ?? "";
  return (
    <ToolShell
      icon={<FolderIcon className="size-4" />}
      running={running}
      error={typeof result === "string" ? result : undefined}
      injection={r?.injection as InjectionReport | undefined}
      label={running ? t("email.toolFoldersRunning", { address }) : t("email.toolFoldersDone", { count: folders.length, address })}
    >
      <ul className="grid gap-1 text-xs sm:grid-cols-2">
        {folders.map((folder) => (
          <li key={folder.path} className="truncate rounded border px-2 py-1">
            {folder.path}
            {folder.specialUse ? <span className="text-muted-foreground ms-1 text-[10px]">{folder.specialUse}</span> : null}
          </li>
        ))}
      </ul>
    </ToolShell>
  );
}

export function EmailListCard({ args, result, status }: { args: Unknown; result?: unknown; status: { type: string } | undefined }) {
  const a = (args ?? {}) as { mailbox?: string };
  const r = typeof result === "object" && result ? (result as { account?: { address?: string }; mailbox?: string; messages?: EmailMessageSummary[]; injection?: unknown }) : undefined;
  const running = status?.type === "running";
  const mailbox = r?.mailbox ?? a.mailbox ?? "INBOX";
  const messages = r?.messages ?? [];
  return (
    <ToolShell
      icon={<MailIcon className="size-4" />}
      running={running}
      error={typeof result === "string" ? result : undefined}
      injection={r?.injection as InjectionReport | undefined}
      label={running ? t("email.toolListRunning", { mailbox }) : t("email.toolListDone", { count: messages.length, mailbox })}
    >
      {messages.length === 0 ? <p className="text-muted-foreground text-xs">{t("email.toolListEmpty", { mailbox })}</p> : <ul>{messages.map((message) => <MessageRow key={message.id} message={message} />)}</ul>}
    </ToolShell>
  );
}

export function EmailSearchCard({ args, result, status }: { args: Unknown; result?: unknown; status: { type: string } | undefined }) {
  const a = (args ?? {}) as { query?: string; subject?: string; from?: string };
  const r = typeof result === "object" && result ? (result as { mailbox?: string; messages?: EmailMessageSummary[]; injection?: unknown }) : undefined;
  const running = status?.type === "running";
  const messages = r?.messages ?? [];
  const query = a.query ?? a.subject ?? a.from ?? "";
  return (
    <ToolShell
      icon={<SearchIcon className="size-4" />}
      running={running}
      error={typeof result === "string" ? result : undefined}
      injection={r?.injection as InjectionReport | undefined}
      label={running ? t("email.toolSearchRunning", { query }) : t("email.toolSearchDone", { count: messages.length })}
    >
      {messages.length === 0 ? <p className="text-muted-foreground text-xs">{t("email.toolSearchEmpty")}</p> : <ul>{messages.map((message) => <MessageRow key={message.id} message={message} />)}</ul>}
    </ToolShell>
  );
}

function Body({ message }: { message: EmailMessage }) {
  return (
    <>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">{t("email.toolFrom")}</dt><dd className="min-w-0 break-words">{addresses(message.from)}</dd>
        <dt className="text-muted-foreground">{t("email.toolTo")}</dt><dd className="min-w-0 break-words">{addresses(message.to)}</dd>
        {message.cc.length ? <><dt className="text-muted-foreground">{t("email.toolCc")}</dt><dd className="min-w-0 break-words">{addresses(message.cc)}</dd></> : null}
        <dt className="text-muted-foreground">{t("email.toolSubject")}</dt><dd className="min-w-0 break-words">{message.subject || t("email.noSubject")}</dd>
        {message.date ? <><dt className="text-muted-foreground">{t("email.toolDate")}</dt><dd>{safeDate(message.date)}</dd></> : null}
      </dl>
      <div className="mt-2 max-h-80 overflow-auto rounded-lg border p-3 text-xs whitespace-pre-wrap">{message.body || t("email.noBody")}</div>
      {message.bodyTruncated ? <p className="text-muted-foreground mt-1 text-[10px]">{t("email.toolTruncated")}</p> : null}
      {message.attachments.length ? (
        <div className="mt-2 flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">{t("email.toolAttachments")}</span>
          <ul className="flex flex-col gap-0.5">
            {message.attachments.map((attachment: EmailAttachmentInfo) => (
              <li key={attachment.part} className="flex min-w-0 items-center gap-2">
                <PaperclipIcon aria-hidden className="text-muted-foreground size-3 shrink-0" />
                <span className="truncate">{attachment.filename}</span>
                <span className="text-muted-foreground shrink-0 text-[10px]">{formatBytes(attachment.size)}</span>
              </li>
            ))}
          </ul>
          <span className="text-muted-foreground text-[10px]">{t("email.toolAttachmentsNote")}</span>
        </div>
      ) : null}
    </>
  );
}

export function EmailReadCard({ args, result, status }: { args: Unknown; result?: unknown; status: { type: string } | undefined }) {
  const a = (args ?? {}) as { messageId?: string };
  const r = typeof result === "object" && result ? (result as { message?: EmailMessage; storedAttachments?: Array<{ filename: string; size: number; url: string }>; injection?: unknown }) : undefined;
  const running = status?.type === "running";
  const message = r?.message;
  const subject = message?.subject || t("email.noSubject");
  return (
    <ToolShell
      icon={<MailOpenIcon className="size-4" />}
      running={running}
      error={typeof result === "string" ? result : undefined}
      injection={r?.injection as InjectionReport | undefined}
      label={running ? t("email.toolReadRunning", { subject }) : t("email.toolReadDone", { subject })}
    >
      {message ? (
        <div className="flex flex-col gap-2">
          <Body message={message} />
          {(r?.storedAttachments ?? []).map((attachment) => (
            <a key={attachment.url} href={attachment.url} className="flex min-h-10 min-w-0 items-center gap-2 rounded-lg border px-2 py-1.5 text-xs hover:bg-muted/60" download>
              <DownloadIcon aria-hidden className="size-3.5 shrink-0" />
              <span className="truncate">{t("email.toolSavedAttachment", { name: attachment.filename, size: formatBytes(attachment.size) })}</span>
            </a>
          ))}
        </div>
      ) : (
        <p className="text-muted-foreground text-xs">{a.messageId ?? ""}</p>
      )}
    </ToolShell>
  );
}

type OutgoingArgs = { from?: string; to?: Array<{ address: string; name?: string }>; cc?: Array<{ address: string; name?: string }>; subject?: string; body?: string };

function OutgoingPreview({ args, result, running, reply, approval }: { args: Unknown; result: unknown; running: boolean; reply: boolean; approval?: { approved?: boolean } }) {
  const a = (args ?? {}) as OutgoingArgs;
  const recipients = formatList([...(a.to ?? []), ...(a.cc ?? [])].map((entry) => entry.address));
  const r = typeof result === "object" && result ? (result as { accepted?: string[]; rejected?: string[] }) : undefined;
  const failed = typeof result === "string";
  const sent = !!r && !failed;
  const pending = !running && !failed && !r;
  const label = running
    ? reply ? t("email.toolReplyRunning", { recipients }) : t("email.toolSendRunning", { recipients })
    : pending
      ? t("email.toolAwaitingApproval")
      : sent
        ? reply ? t("email.toolReplyDone", { recipients }) : t("email.toolSendDone", { recipients })
        : reply ? t("email.toolReplyFailed") : t("email.toolSendFailed");
  return (
    <ToolShell
      icon={sent ? <CheckCircle2Icon className="size-4" /> : failed ? <AlertCircleIcon className="size-4" /> : <SendIcon className="size-4" />}
      running={running}
      error={typeof result === "string" ? result : undefined}
      label={label}
      // While an outbound call waits for approval, the exact reviewed payload is open, not hidden
      // behind a collapsed row. The approval controls render directly below this card.
      defaultOpen={pending || approval !== undefined}
    >
      <div className="flex flex-col gap-2 text-xs">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          <dt className="text-muted-foreground">{t("email.toolFrom")}</dt><dd className="min-w-0 break-words">{a.from ?? ""}</dd>
          <dt className="text-muted-foreground">{t("email.toolTo")}</dt><dd className="min-w-0 break-words">{addresses(a.to)}</dd>
          {(a.cc ?? []).length ? <><dt className="text-muted-foreground">{t("email.toolCc")}</dt><dd className="min-w-0 break-words">{addresses(a.cc)}</dd></> : null}
          <dt className="text-muted-foreground">{t("email.toolSubject")}</dt><dd className="min-w-0 break-words">{a.subject ?? ""}</dd>
        </dl>
        <div className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border p-3">{a.body ?? ""}</div>
        {sent && r?.rejected?.length ? <p className="text-warning">{t("email.toolRejected", { addresses: formatList(r.rejected) })}</p> : null}
      </div>
    </ToolShell>
  );
}

export function EmailSendCard({ args, result, status, approval }: { args: Unknown; result?: unknown; status: { type: string } | undefined; approval?: { approved?: boolean } }) {
  return <OutgoingPreview args={args} result={result} running={status?.type === "running"} reply={false} approval={approval} />;
}

export function EmailReplyCard({ args, result, status, approval }: { args: Unknown; result?: unknown; status: { type: string } | undefined; approval?: { approved?: boolean } }) {
  return <OutgoingPreview args={args} result={result} running={status?.type === "running"} reply approval={approval} />;
}
