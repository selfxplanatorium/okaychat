import { useAuiState, type ToolCallMessagePartProps } from "@assistant-ui/react";
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FileTextIcon,
  Loader2Icon,
  MailIcon,
  SendIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Link } from "wouter";
import {
  EMAIL_DRAFT_LIMITS,
  hasLineBreak,
  joinRecipients,
  looksLikeAddress,
  parseRecipient,
  splitRecipients,
  type EmailDraft,
  type EmailDraftFields,
  type EmailDraftReview,
  type EmailDraftSendResult,
} from "@shared/email-draft";
import type { EmailAccount } from "@shared/email";
import type { InjectionReport } from "@shared/types";
import { Button, buttonVariants } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { t } from "@/i18n";
import { formatDateTime, formatList } from "@/i18n/format";
import { api } from "@/lib/api";
import { settingsHref } from "@/lib/settings-link";
import { cn } from "@/lib/utils";
import { useData } from "@/state/data";
import {
  DraftAutosave,
  clearOutbox,
  draftOutboxKey,
  draftWordCount,
  type DraftSaveStatus,
} from "./email-draft-state";

// The inline editable email draft. The model writes a draft record; this card edits that same record
// in place. Every save is revision-checked, Send first asks the server for the exact payload and then
// sends only its single-use review token, and nothing here ever calls SMTP directly. See
// docs/implementation/email.md ("Draft card").

type DraftToolResult = { action?: "created" | "read" | "updated"; draft?: EmailDraft; injection?: InjectionReport };

const NONE = "__none";

const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((entry) => typeof entry === "string");

function draftOf(value: unknown): EmailDraft | null {
  if (typeof value !== "object" || value === null) return null;
  const draft = (value as { draft?: unknown }).draft;
  if (typeof draft !== "object" || draft === null) return null;
  const raw = draft as Partial<EmailDraft>;
  if (typeof raw.id !== "string" || typeof raw.threadId !== "string" || typeof raw.revision !== "number") return null;
  if (!isStringArray(raw.to) || !isStringArray(raw.cc) || !isStringArray(raw.bcc)) return null;
  if (typeof raw.subject !== "string" || typeof raw.body !== "string") return null;
  return raw as EmailDraft;
}

function fieldsOf(draft: EmailDraft): EmailDraftFields {
  return {
    accountId: draft.accountId,
    to: [...draft.to],
    cc: [...draft.cc],
    bcc: [...draft.bcc],
    subject: draft.subject,
    body: draft.body,
    inReplyTo: draft.inReplyTo,
  };
}

function previewFields(args: unknown): EmailDraftFields {
  // Tool arguments can still be streaming, so a preview must tolerate a partial or wrong-shaped value.
  const value = (args ?? {}) as Partial<Record<keyof EmailDraftFields, unknown>>;
  const list = (entry: unknown) => (isStringArray(entry) ? entry : []);
  return {
    accountId: typeof value.accountId === "string" ? value.accountId : null,
    to: list(value.to),
    cc: list(value.cc),
    bcc: list(value.bcc),
    subject: typeof value.subject === "string" ? value.subject : "",
    body: typeof value.body === "string" ? value.body : "",
    inReplyTo: typeof value.inReplyTo === "string" ? value.inReplyTo : null,
  };
}

const draftBase = (threadId: string, draftId: string) => `/email/threads/${encodeURIComponent(threadId)}/drafts/${encodeURIComponent(draftId)}`;

function useDraftAccounts(userId: string | undefined) {
  const [accounts, setAccounts] = useState<EmailAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const list = await api<EmailAccount[]>("/email/accounts", { signal });
      if (signal?.aborted) return;
      setAccounts(list);
      setError(false);
    } catch (cause) {
      if (signal?.aborted) return;
      setAccounts([]);
      setError(true);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);
  useEffect(() => {
    if (!userId) return;
    // The previous account's cards must not keep showing its mailbox while the new list loads.
    setAccounts([]);
    setError(false);
    const abort = new AbortController();
    void load(abort.signal);
    return () => abort.abort();
  }, [load, userId]);
  return { accounts, loading, error, reload: load };
}

function blurOnEscape(event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) {
  if (event.key !== "Escape") return;
  event.preventDefault();
  event.stopPropagation();
  event.currentTarget.blur();
}

function RecipientField({
  id,
  label,
  value,
  onChange,
  readOnly,
  placeholder,
}: {
  id: string;
  label: string;
  value: string[];
  onChange: (next: string[]) => void;
  readOnly: boolean;
  placeholder: string;
}) {
  const joined = joinRecipients(value);
  const [text, setText] = useState(joined);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setText(joined);
  }, [joined]);
  const invalid = value.filter((entry) => !looksLikeAddress(entry));
  return (
    <div className="grid min-w-0 grid-cols-[3.25rem_minmax(0,1fr)] items-start gap-2 sm:grid-cols-[3.75rem_minmax(0,1fr)]">
      <label htmlFor={id} className="text-muted-foreground pt-1.5 text-xs">
        {label}
      </label>
      <div className="min-w-0">
        <Input
          id={id}
          value={text}
          readOnly={readOnly}
          placeholder={placeholder}
          aria-invalid={invalid.length > 0 || undefined}
          aria-describedby={invalid.length ? `${id}-invalid` : undefined}
          className="bg-transparent px-1.5 focus-visible:bg-muted/50"
          onChange={(event) => {
            const next = event.target.value;
            setText(next);
            onChange(splitRecipients(next));
          }}
          onFocus={() => { focused.current = true; }}
          onBlur={() => { focused.current = false; setText(joinRecipients(value)); }}
          onKeyDown={blurOnEscape}
        />
        {invalid.length ? (
          <p id={`${id}-invalid`} className="text-warning mt-0.5 px-1.5 text-[11px]">
            {t("email.draftRecipientInvalid")}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function StatusLine({ state, error, onRetry, onReload }: { state: DraftSaveStatus; error: string | null; onRetry: () => void; onReload: () => void }) {
  if (state === "conflict") {
    return (
      <span className="text-warning inline-flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
        <AlertCircleIcon aria-hidden className="size-3.5 shrink-0" />
        <span>{t("email.draftConflict")}</span>
        <button type="button" className="inline-flex min-h-10 items-center underline underline-offset-2 rounded focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2 pointer-coarse:min-h-11" onClick={onRetry}>{t("email.draftKeepMine")}</button>
        <button type="button" className="inline-flex min-h-10 items-center underline underline-offset-2 rounded focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2 pointer-coarse:min-h-11" onClick={onReload}>{t("email.draftReload")}</button>
      </span>
    );
  }
  if (state === "offline" || state === "error") {
    return (
      <span className="text-warning inline-flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
        <AlertCircleIcon aria-hidden className="size-3.5 shrink-0" />
        <span>{state === "offline" ? t("email.draftOffline") : t("email.draftSaveError", { message: error ?? "" })}</span>
        <button type="button" className="inline-flex min-h-10 items-center underline underline-offset-2 rounded focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2 pointer-coarse:min-h-11" onClick={onRetry}>{t("email.draftRetry")}</button>
      </span>
    );
  }
  if (state === "saving") {
    return <span className="text-muted-foreground inline-flex items-center gap-1.5 text-[11px]"><Loader2Icon aria-hidden className="size-3 animate-spin motion-reduce:animate-none" />{t("email.draftSaving")}</span>;
  }
  if (state === "pending") {
    return <span className="text-muted-foreground text-[11px]">{t("email.draftPending")}</span>;
  }
  return <span className="text-muted-foreground inline-flex items-center gap-1 text-[11px]"><CheckIcon aria-hidden className="size-3" />{t("email.draftSaved")}</span>;
}

export function TextDraftCard(props: ToolCallMessagePartProps) {
  return <EmailDraftCard {...props} textDraft />;
}

export function EmailDraftCard(props: ToolCallMessagePartProps & { textDraft?: boolean }) {
  const textDraft = props.textDraft === true;
  const { args, result, status } = props;
  const threadId = useAuiState((s) => s.threadListItem.remoteId ?? undefined);
  const messageId = useAuiState((s) => s.message.id);
  const userId = useData((s) => s.me?.id);
  const { accounts, loading: accountsLoading, error: accountsError, reload: reloadAccounts } = useDraftAccounts(textDraft ? undefined : userId);

  const resultDraft = draftOf(result);
  const resultAction = typeof result === "object" && result ? (result as DraftToolResult).action : undefined;
  const injection = typeof result === "object" && result ? (result as DraftToolResult).injection : undefined;
  const draftId = resultDraft?.id;
  const base = threadId && draftId ? draftBase(threadId, draftId) : null;

  const [draft, setDraft] = useState<EmailDraft | null>(resultDraft);
  const [fields, setFields] = useState<EmailDraftFields | null>(resultDraft ? fieldsOf(resultDraft) : null);
  const [autosave, setAutosave] = useState<DraftSaveStatus>("saved");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [discarded, setDiscarded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [justUpdated, setJustUpdated] = useState(false);
  const [showCc, setShowCc] = useState(false);
  const [showBcc, setShowBcc] = useState(false);
  const [review, setReview] = useState<EmailDraftReview | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const controllerRef = useRef<DraftAutosave | null>(null);
  const messageIdRef = useRef(messageId);
  messageIdRef.current = messageId;
  const { isCopied, copyToClipboard } = useCopyToClipboard();
  const fieldId = useId();

  const saveFields = useCallback(
    async ({ revision, fields: next, signal }: { revision: number; fields: EmailDraftFields; signal: AbortSignal }) => {
      if (!base) throw Object.assign(new Error(t("email.draftLoadFailed")), { status: 404 });
      return api<EmailDraft>(base, { method: "PATCH", json: { revision, fields: next, ...(messageIdRef.current ? { messageId: messageIdRef.current } : {}) }, signal });
    },
    [base],
  );

  const fetchLatest = useCallback(
    async ({ signal }: { signal: AbortSignal }) => {
      if (!base) throw Object.assign(new Error(t("email.draftLoadFailed")), { status: 404 });
      return api<EmailDraft>(base, { signal });
    },
    [base],
  );

  // Hydrate from the server record, never from the tool output alone: an old result may show the
  // model's text while the user's later edits are already stored.
  useEffect(() => {
    if (!base || !threadId || !draftId || !userId) return;
    const abort = new AbortController();
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    void api<EmailDraft>(base, { signal: abort.signal })
      .then((server) => {
        if (cancelled || abort.signal.aborted) return;
        const controller = new DraftAutosave(server, {
          key: draftOutboxKey(userId, threadId, draftId),
          save: saveFields,
          fetchLatest,
        });
        controller.subscribe(() => {
          const snapshot = controller.snapshot();
          setDraft(snapshot.draft);
          setFields(snapshot.fields);
          setAutosave(snapshot.status);
          setSaveError(snapshot.error);
        });
        controllerRef.current?.dispose();
        controllerRef.current = controller;
        setDraft(server);
        setFields(fieldsOf(server));
        setAutosave("saved");
        setSaveError(null);
        setShowCc(server.cc.length > 0);
        setShowBcc(server.bcc.length > 0);
        setLoading(false);
        controller.applyServer(server);
        if (messageIdRef.current && server.messageId !== messageIdRef.current) {
          // Binding is bookkeeping only: no content revision changes and a failure is harmless.
          void api(`${base}`, { method: "PATCH", json: { revision: server.revision, fields: {}, messageId: messageIdRef.current } }).catch(() => {});
        }
      })
      .catch((cause: unknown) => {
        if (cancelled || abort.signal.aborted) return;
        setLoading(false);
        if ((cause as { status?: number }).status === 404) {
          setDiscarded(true);
          if (threadId && draftId && userId) {
            try {
              clearOutbox(window.localStorage, draftOutboxKey(userId, threadId, draftId));
            } catch {
              // Private mode has no storage; there is nothing to clear.
            }
          }
        } else setLoadError(cause instanceof Error ? cause.message : t("email.draftLoadFailed"));
      });
    return () => {
      cancelled = true;
      abort.abort();
      controllerRef.current?.dispose();
      controllerRef.current = null;
    };
  }, [base, draftId, fetchLatest, loadAttempt, saveFields, threadId, userId]);

  // A later tool result can update the same draft. Fetch the authoritative revision and keep unsaved
  // local text instead of letting a stale/older response overwrite it.
  useEffect(() => {
    const controller = controllerRef.current;
    if (!base || !resultDraft || !controller || resultDraft.revision <= controller.snapshot().revision) return;
    const abort = new AbortController();
    void api<EmailDraft>(base, { signal: abort.signal })
      .then((server) => {
        if (abort.signal.aborted) return;
        controller.applyServer(server, { preserveLocal: true });
        setJustUpdated(true);
      })
      .catch(() => {});
    return () => abort.abort();
  }, [base, resultDraft?.revision, resultDraft]);

  useEffect(() => {
    if (!justUpdated) return;
    const timer = setTimeout(() => setJustUpdated(false), 5000);
    return () => clearTimeout(timer);
  }, [justUpdated]);

  // A save can fail because its account was removed or had sending turned off since the list loaded.
  useEffect(() => {
    if (!textDraft && saveError) void reloadAccounts();
  }, [reloadAccounts, saveError, textDraft]);

  // A failed first load is retried when the connection returns or the reader comes back to the tab.
  useEffect(() => {
    if (!loadError) return;
    const retry = () => setLoadAttempt((value) => value + 1);
    window.addEventListener("online", retry);
    window.addEventListener("focus", retry);
    return () => {
      window.removeEventListener("online", retry);
      window.removeEventListener("focus", retry);
    };
  }, [loadError]);

  // A lost connection is retried when it returns or when the card regains focus; the outbox holds the
  // text meanwhile, and no request is sent with a guessed revision.
  useEffect(() => {
    const retry = () => {
      const controller = controllerRef.current;
      if (!controller) return;
      const state = controller.snapshot();
      if (state.status === "offline" || state.status === "error") void controller.retry();
    };
    window.addEventListener("online", retry);
    window.addEventListener("focus", retry);
    return () => {
      window.removeEventListener("online", retry);
      window.removeEventListener("focus", retry);
    };
  }, []);

  // Reloading during SMTP must eventually leave the sending state when that request finishes.
  useEffect(() => {
    if (!base || draft?.status !== "sending") return;
    const abort = new AbortController();
    const refresh = () => {
      void api<EmailDraft>(base, { signal: abort.signal }).then((server) => {
        if (!abort.signal.aborted) controllerRef.current?.applyServer(server);
      }).catch(() => {});
    };
    const timer = setInterval(refresh, 2000);
    return () => { abort.abort(); clearInterval(timer); };
  }, [base, draft?.status]);

  const viewFields = fields ?? previewFields(textDraft ? { ...(args as object), subject: (args as { title?: string })?.title } : args);
  const wordCount = draftWordCount(viewFields.body);
  const edited = !!draft && (draft.updatedBy === "user" || autosave !== "saved");
  const selectedAccount = viewFields.accountId ? accounts.find((entry) => entry.id === viewFields.accountId) : undefined;
  const sendableAccounts = accounts.filter((entry) => entry.sendEnabled);
  const noSender = !accountsLoading && !accountsError && sendableAccounts.length === 0;
  const senderOptions = accounts.map((entry) => ({
    value: entry.id,
    label: entry.sendEnabled
      ? t("email.draftSenderOption", { label: entry.label, address: entry.address })
      : t("email.draftSenderOptionOff", { label: entry.label, address: entry.address }),
  }));
  if (!accounts.some((entry) => entry.id === viewFields.accountId)) senderOptions.unshift({ value: NONE, label: t("email.draftChooseAccount") });
  if (!senderOptions.length) senderOptions.push({ value: NONE, label: t("email.draftChooseAccount") });
  const signatureBlock = selectedAccount?.signature.trim() ? `\n\n-- \n${selectedAccount.signature.trim()}` : "";
  const missingSignature = !!signatureBlock && !viewFields.body.endsWith(signatureBlock);
  // Editing waits for the server record; a tool output can be older than the user's saved text.
  const sendingByServer = draft?.status === "sending";
  const readOnly = !draft || loading || draft.status === "sent" || sendingByServer || discarded || !!loadError;
  const saveSettled = autosave === "saved";
  const sendActionAllowed = !!draft && !!base && (draft.status === "draft" || draft.status === "sent") && !discarded && !loadError && !loading && !!selectedAccount?.sendEnabled && !accountsLoading && saveSettled && viewFields.to.length > 0;

  const updateFields = (patch: Partial<EmailDraftFields>) => {
    setActionError(null);
    setFields((current) => (current ? { ...current, ...patch } : current));
    controllerRef.current?.update(patch);
  };

  const retrySave = () => {
    void controllerRef.current?.retry().catch(() => {});
  };

  const reloadLatest = () => {
    void controllerRef.current?.reload().catch((cause: unknown) => {
      setActionError(cause instanceof Error ? cause.message : t("email.draftLoadFailed"));
    });
  };

  const startReview = async () => {
    const controller = controllerRef.current;
    if (textDraft || !base || !controller) return;
    setActionError(null);
    // Never review while a save is pending: the payload must be the record the server holds.
    for (let attempt = 0; attempt < 3; attempt++) {
      await controller.flush();
      const state = controller.snapshot();
      if (!state.dirty && state.status === "saved") break;
      if (state.status !== "pending" && state.status !== "saving") break;
    }
    const state = controller.snapshot();
    if (state.dirty || state.status !== "saved") {
      setActionError(state.status === "conflict" ? t("email.draftConflict") : t("email.draftSendFirst"));
      return;
    }
    try {
      const next = await api<EmailDraftReview>(`${base}/review`, { method: "POST", json: { revision: state.revision } });
      setReview(next);
      setSendError(null);
      setReviewOpen(true);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : t("email.draftReviewFailed"));
      // The account's signature or send switch may have changed since the list loaded.
      void reloadAccounts();
      if ((cause as { status?: number }).status === 409) void controller.reload().catch(() => {});
    }
  };

  const confirmSend = async () => {
    const controller = controllerRef.current;
    if (!base || !review || !controller) return;
    setSending(true);
    setSendError(null);
    try {
      const sent = await api<EmailDraftSendResult>(`${base}/send`, { method: "POST", json: { reviewId: review.reviewId, revision: review.revision } });
      controller.markSent(sent.draft);
      setReviewOpen(false);
      setReview(null);
      setActionError(sent.rejected.length ? t("email.draftRejected", { addresses: formatList(sent.rejected) }) : null);
    } catch (cause) {
      setSendError(cause instanceof Error ? cause.message : t("email.draftSendFailed"));
      // The server wrote the mapped error (and may have returned a resend to read-only); show that.
      void controllerRef.current?.reload().catch(() => {});
    } finally {
      setSending(false);
    }
  };

  const copyDraft = () => {
    if (textDraft) {
      copyToClipboard(viewFields.body);
      return;
    }
    const header = [
      viewFields.to.length ? `To: ${joinRecipients(viewFields.to)}` : "",
      viewFields.cc.length ? `Cc: ${joinRecipients(viewFields.cc)}` : "",
      viewFields.bcc.length ? `Bcc: ${joinRecipients(viewFields.bcc)}` : "",
      `Subject: ${viewFields.subject}`,
    ].filter(Boolean).join("\n");
    copyToClipboard(`${header}\n\n${viewFields.body}`);
  };

  const mailtoHref = (() => {
    const addresses = (list: string[]) => list.map((entry) => parseRecipient(entry)?.address).filter((entry): entry is string => !!entry);
    const to = addresses(viewFields.to).map(encodeURIComponent).join(",");
    const params: string[] = [`subject=${encodeURIComponent(viewFields.subject)}`, `body=${encodeURIComponent(viewFields.body)}`];
    const cc = addresses(viewFields.cc);
    const bcc = addresses(viewFields.bcc);
    if (cc.length) params.push(`cc=${cc.map(encodeURIComponent).join(",")}`);
    if (bcc.length) params.push(`bcc=${bcc.map(encodeURIComponent).join(",")}`);
    return `mailto:${to}?${params.join("&")}`;
  })();

  const downloadEml = async () => {
    if (!base) return;
    setDownloading(true);
    setActionError(null);
    try {
      // The file comes from the server record, so unsaved text must reach it first.
      const controller = controllerRef.current;
      if (controller) {
        await controller.flush();
        if (controller.snapshot().dirty) {
          setActionError(t("email.draftSendFirst"));
          return;
        }
      }
      const response = await fetch(`/api${base}/eml`, { credentials: "same-origin" });
      if (!response.ok) throw new Error(t("email.draftDownloadFailed", { status: response.status }));
      const blob = await response.blob();
      const disposition = response.headers.get("content-disposition") ?? "";
      const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? "email-draft.eml";
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : t("email.draftDownloadFailed", { status: 0 }));
    } finally {
      setDownloading(false);
    }
  };

  const discardDraft = async () => {
    if (!base) return;
    setDiscarding(true);
    setActionError(null);
    try {
      await api(base, { method: "DELETE" });
      controllerRef.current?.forget();
      controllerRef.current = null;
      setDiscarded(true);
      setDiscardOpen(false);
      setReviewOpen(false);
    } catch (cause) {
      setDiscardOpen(false);
      setActionError(cause instanceof Error ? cause.message : t("email.draftDiscardFailed"));
    } finally {
      setDiscarding(false);
    }
  };

  const onCardKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (textDraft) return;
    if (!(event.metaKey || event.ctrlKey) || event.key !== "Enter") return;
    event.preventDefault();
    event.stopPropagation();
    if (sendActionAllowed) void startReview();
  };

  const fieldKeyDown = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => blurOnEscape(event);

  const statusText = draft?.status === "sent" && draft.sentAt
    ? t("email.draftSent", { date: formatDateTime(draft.sentAt) })
    : null;

  return (
    <section
      data-slot={textDraft ? "text-draft-card" : "email-draft-card"}
      data-no-drawer-swipe
      role="group"
      aria-label={textDraft ? t("email.textDraftTitle") : t("email.draftTitle")}
      tabIndex={-1}
      onKeyDown={onCardKeyDown}
      className="depth-float bg-card my-3 min-w-0 rounded-2xl border p-3 sm:p-4"
    >
      <div className="mb-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        {textDraft ? <FileTextIcon aria-hidden className="text-muted-foreground size-4 shrink-0" /> : <MailIcon aria-hidden className="text-muted-foreground size-4 shrink-0" />}
        <h3 className="min-w-0 flex-1 truncate text-sm font-medium">{textDraft ? t("email.textDraftTitle") : t("email.draftTitle")}</h3>
        {draft?.status === "sent" ? <span className="text-success inline-flex items-center gap-1 text-[11px]"><CheckCircle2Icon aria-hidden className="size-3.5" />{t("email.draftSentStatus")}</span> : null}
        {edited ? (
          <span className="text-muted-foreground inline-flex items-center gap-1 text-[11px]">
            <span aria-hidden className="bg-primary size-1.5 rounded-full" />
            {t("email.draftEdited")}
          </span>
        ) : null}
        {justUpdated || (resultAction === "updated" && !edited) ? <span className="text-muted-foreground text-[11px]">{t("email.draftUpdated")}</span> : null}
        {injection?.flagged ? (
          <span title={t("tools.injectionBadgeHint")} className="text-muted-foreground inline-flex max-w-full items-center gap-1.5 text-[11px]">
            <TriangleAlertIcon aria-hidden className="text-warning size-3.5 shrink-0" />
            <span className="truncate">{t("tools.injectionBadge")}</span>
          </span>
        ) : null}
      </div>

      {discarded ? (
        <div className="flex flex-col gap-1 py-2">
          <p className="text-sm font-medium">{t("email.draftDiscarded")}</p>
          <p className="text-muted-foreground text-xs">{t("email.draftDiscardedBody")}</p>
        </div>
      ) : (
        <>
          {loadError ? (
            <div role="alert" className="text-warning mb-2 flex flex-wrap items-center gap-2 text-xs">
              <AlertCircleIcon aria-hidden className="size-4 shrink-0" />
              <span className="min-w-0 flex-1">{t("email.draftLoadFailed")}</span>
              <Button type="button" variant="outline" size="sm" onClick={() => setLoadAttempt((value) => value + 1)}>{t("email.draftRetry")}</Button>
            </div>
          ) : null}

          {!textDraft && draft?.status !== "sent" && !readOnly && ((draft?.accountMissing && !selectedAccount) || noSender) ? (
            <div className="bg-muted/50 mb-2 flex min-w-0 flex-col gap-1 rounded-lg p-2.5 text-xs">
              <p className="font-medium">{draft?.accountMissing && !selectedAccount ? t("email.draftAccountMissing") : t("email.draftNoAccount")}</p>
              <p className="text-muted-foreground">{t("email.draftNoAccountBody")}</p>
              <Link href={settingsHref("email")} className="text-primary inline-flex min-h-10 items-center gap-1 self-start text-xs font-medium underline-offset-4 hover:underline pointer-coarse:min-h-11">
                {t("email.draftOpenSettings")} <ExternalLinkIcon aria-hidden className="size-3" />
              </Link>
            </div>
          ) : null}

          {!textDraft && draft?.status !== "sent" && selectedAccount && !selectedAccount.sendEnabled ? (
            <div className="text-warning mb-2 flex flex-wrap items-center gap-2 text-xs">
              <AlertCircleIcon aria-hidden className="size-4 shrink-0" />
              <span className="min-w-0 flex-1">{t("email.draftSendingOff", { address: selectedAccount.address })}</span>
              <Link href={settingsHref("email")} className="underline underline-offset-2 rounded focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2">{t("email.draftOpenSettings")}</Link>
            </div>
          ) : null}

          <div className="flex flex-col gap-1.5">
            {!textDraft ? (
              <>
                <div className="grid min-w-0 grid-cols-[3.25rem_minmax(0,1fr)] items-center gap-2 sm:grid-cols-[3.75rem_minmax(0,1fr)]">
                  <span className="text-muted-foreground text-xs">{t("email.draftFrom")}</span>
                  <Select<string>
                    value={viewFields.accountId && accounts.some((entry) => entry.id === viewFields.accountId) ? viewFields.accountId : NONE}
                    disabled={readOnly || accountsLoading || accounts.length === 0}
                    aria-label={t("email.draftFrom")}
                    className="bg-transparent pointer-coarse:min-h-11"
                    placeholder={t("email.draftChooseAccount")}
                    options={senderOptions}
                    onValueChange={(value) => {
                      if (value === NONE) updateFields({ accountId: null });
                      else updateFields({ accountId: value });
                    }}
                  />
                </div>

                <RecipientField
                  id={`${fieldId}-to`}
                  label={t("email.draftTo")}
                  value={viewFields.to}
                  readOnly={readOnly}
                  placeholder={t("email.draftToPlaceholder")}
                  onChange={(to) => updateFields({ to })}
                />
                {showCc || viewFields.cc.length ? (
                  <RecipientField
                    id={`${fieldId}-cc`}
                    label={t("email.draftCc")}
                    value={viewFields.cc}
                    readOnly={readOnly}
                    placeholder={t("email.draftRecipientPlaceholder")}
                    onChange={(cc) => updateFields({ cc })}
                  />
                ) : null}
                {showBcc || viewFields.bcc.length ? (
                  <RecipientField
                    id={`${fieldId}-bcc`}
                    label={t("email.draftBcc")}
                    value={viewFields.bcc}
                    readOnly={readOnly}
                    placeholder={t("email.draftRecipientPlaceholder")}
                    onChange={(bcc) => updateFields({ bcc })}
                  />
                ) : null}
                {!readOnly && (!showCc || !showBcc) ? (
                  <div className="flex flex-wrap gap-2 ps-[calc(3.25rem+0.5rem)] text-[11px] sm:ps-[calc(3.75rem+0.5rem)]">
                    {!showCc && !viewFields.cc.length ? <button type="button" aria-expanded={showCc} className="text-muted-foreground hover:text-foreground inline-flex min-h-10 items-center underline underline-offset-2 rounded focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2 pointer-coarse:min-h-11" onClick={() => setShowCc(true)}>{t("email.draftAddCc")}</button> : null}
                    {!showBcc && !viewFields.bcc.length ? <button type="button" aria-expanded={showBcc} className="text-muted-foreground hover:text-foreground inline-flex min-h-10 items-center underline underline-offset-2 rounded focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2 pointer-coarse:min-h-11" onClick={() => setShowBcc(true)}>{t("email.draftAddBcc")}</button> : null}
                  </div>
                ) : null}

                <div className="border-border/70 mt-1 border-t" />

              </>
            ) : null}

            <label htmlFor={`${fieldId}-subject`} className="sr-only">{textDraft ? t("email.textDraftTitleLabel") : t("email.draftSubject")}</label>
            <Input
              id={`${fieldId}-subject`}
              value={viewFields.subject}
              readOnly={readOnly}
              maxLength={EMAIL_DRAFT_LIMITS.subject}
              placeholder={textDraft ? t("email.textDraftTitleLabel") : t("email.draftSubjectPlaceholder")}
              aria-invalid={hasLineBreak(viewFields.subject) || undefined}
              className="bg-transparent px-1.5 text-base font-medium focus-visible:bg-muted/50 md:text-sm"
              onChange={(event) => updateFields({ subject: event.target.value })}
              onKeyDown={fieldKeyDown}
            />

            <label htmlFor={`${fieldId}-body`} className="sr-only">{textDraft ? t("email.textDraftBodyLabel") : t("email.draftBody")}</label>
            <Textarea
              id={`${fieldId}-body`}
              value={viewFields.body}
              readOnly={readOnly}
              maxLength={EMAIL_DRAFT_LIMITS.body}
              placeholder={textDraft ? t("email.textDraftBodyPlaceholder") : t("email.draftBodyPlaceholder")}
              className="min-h-32 resize-none bg-transparent px-1.5 text-sm leading-relaxed focus-visible:bg-muted/50"
              onChange={(event) => updateFields({ body: event.target.value })}
              onKeyDown={fieldKeyDown}
            />
          </div>

          {!textDraft && viewFields.inReplyTo ? <p className="text-muted-foreground mt-1 text-[11px]">{t("email.draftReplyNote")}</p> : null}

          {!textDraft && missingSignature && !readOnly ? (
            <div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-2 text-[11px]">
              <span>{t("email.draftSignatureMissing")}</span>
              <button type="button" data-command="email.draftSignature" className="text-primary min-h-10 underline underline-offset-2 rounded focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2 pointer-coarse:min-h-11" onClick={() => updateFields({ body: `${viewFields.body}${signatureBlock}` })}>
                {t("email.draftAddSignature")}
              </button>
            </div>
          ) : null}

          {actionError || draft?.lastError ? <p role="alert" className="text-warning mt-1.5 text-xs break-words whitespace-pre-wrap">{actionError ?? draft?.lastError}</p> : null}

          <div className="mt-3 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
            <span role="status" aria-live="polite" className="min-w-0">
              {status?.type === "incomplete" && !draft ? <span className="text-warning inline-flex items-center gap-1 text-[11px]"><AlertCircleIcon aria-hidden className="size-3.5" />{t("email.draftLoadFailed")}</span> : null}
              {status?.type !== "incomplete" && loading && !draft ? <span className="text-muted-foreground inline-flex items-center gap-1.5 text-[11px]"><Loader2Icon aria-hidden className="size-3 animate-spin motion-reduce:animate-none" />{t("email.draftLoading")}</span> : null}
              {sendingByServer ? <span className="text-muted-foreground inline-flex items-center gap-1.5 text-[11px]"><Loader2Icon aria-hidden className="size-3 animate-spin motion-reduce:animate-none" />{t("email.draftSending")}</span> : null}
              {statusText ? <span className="text-success inline-flex items-center gap-1 text-[11px]"><CheckCircle2Icon aria-hidden className="size-3.5" />{statusText}</span> : draft?.status === "sent" ? <span className="text-success text-[11px]">{t("email.draftSentStatus")}</span> : null}
              {!loading && !sendingByServer && status?.type !== "incomplete" && !statusText && draft?.status !== "sent" ? <StatusLine state={autosave} error={saveError} onRetry={retrySave} onReload={reloadLatest} /> : null}
            </span>
            <span className="text-muted-foreground text-[11px]">{t("email.draftWordCount", { count: wordCount })}</span>
            {draft?.status === "sent" ? <span className="text-muted-foreground text-[11px]">{t("email.draftSentCount", { count: draft.sendCount })}</span> : null}
          </div>

          <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5">
            {!textDraft ? (
              <>
                <Button
                  type="button"
                  size="sm"
                  className="pointer-coarse:min-h-11"
                  data-command="email.draftSend"
                  aria-keyshortcuts="Control+Enter Meta+Enter"
                  disabled={!sendActionAllowed}
                  onClick={() => void startReview()}
                >
                  <SendIcon aria-hidden />
                  {draft?.status === "sent" ? t("email.draftSendAgain") : t("email.draftSend")}
                </Button>
                {noSender || (draft?.accountMissing && !selectedAccount) ? (
                  <Link href={settingsHref("email")} className="text-primary inline-flex min-h-10 items-center gap-1 px-1 text-xs underline-offset-4 hover:underline pointer-coarse:min-h-11">
                    {t("email.draftOpenSettings")} <ExternalLinkIcon aria-hidden className="size-3" />
                  </Link>
                ) : null}
              </>
            ) : null}
            <Button type="button" variant="ghost" size="sm" className="pointer-coarse:min-h-11" data-command={textDraft ? "textDraft.copy" : "email.draftCopy"} onClick={copyDraft}>
              {isCopied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
              <span aria-live="polite">{isCopied ? t("email.draftCopied") : t("email.draftCopy")}</span>
            </Button>
            {!textDraft ? (
              <>
                <Button type="button" variant="ghost" size="sm" className="pointer-coarse:min-h-11" data-command="email.draftDownload" disabled={downloading || !base} onClick={() => void downloadEml()}>
                  {downloading ? <Loader2Icon aria-hidden className="animate-spin motion-reduce:animate-none" /> : <DownloadIcon aria-hidden />}
                  {t("email.draftDownload")}
                </Button>
                <a
                  href={mailtoHref}
                  data-command="email.draftMailto"
                  className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "pointer-coarse:min-h-11")}
                >
                  <ExternalLinkIcon aria-hidden />
                  {t("email.draftMailto")}
                </a>
              </>
            ) : null}
            <Button type="button" variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive pointer-coarse:min-h-11 ms-auto" data-command={textDraft ? "textDraft.discard" : "email.draftDiscard"} disabled={discarding || !base} onClick={() => setDiscardOpen(true)}>
              <Trash2Icon aria-hidden />
              {t("email.draftDiscard")}
            </Button>
          </div>

          {!textDraft && accountsError ? (
            <div className="text-muted-foreground mt-2 flex items-center gap-2 text-[11px]">
              <span>{t("email.draftAccountsError")}</span>
              <button type="button" className="inline-flex min-h-10 items-center underline underline-offset-2 rounded focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2 pointer-coarse:min-h-11" onClick={() => void reloadAccounts()}>{t("email.draftRetry")}</button>
            </div>
          ) : null}
        </>
      )}

      <Dialog open={reviewOpen} onOpenChange={(open) => { if (!sending) setReviewOpen(open); }}>
        <DialogContent showCloseButton={!sending} className="max-h-[min(42rem,90dvh)] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("email.draftReviewTitle")}</DialogTitle>
            <DialogDescription>{review ? t("email.draftReviewBody", { account: `${review.accountLabel} <${review.from}>` }) : ""}</DialogDescription>
          </DialogHeader>
          {review ? (
            <div className="flex min-w-0 flex-col gap-2 text-sm">
              <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
                <dt className="text-muted-foreground">{t("email.draftReviewFrom")}</dt><dd className="min-w-0 break-words">{review.accountLabel} &lt;{review.from}&gt;</dd>
                <dt className="text-muted-foreground">{t("email.draftReviewTo")}</dt><dd className="min-w-0 break-words">{formatList(review.to) || t("email.draftNoRecipients")}</dd>
                {review.cc.length ? <><dt className="text-muted-foreground">{t("email.draftReviewCc")}</dt><dd className="min-w-0 break-words">{formatList(review.cc)}</dd></> : null}
                {review.bcc.length ? <><dt className="text-muted-foreground">{t("email.draftReviewBcc")}</dt><dd className="min-w-0 break-words">{formatList(review.bcc)}</dd></> : null}
                <dt className="text-muted-foreground">{t("email.draftReviewSubject")}</dt><dd className="min-w-0 break-words">{review.subject || t("email.noSubject")}</dd>
              </dl>
              <div className="max-h-72 min-w-0 overflow-auto rounded-lg border p-3 text-xs whitespace-pre-wrap break-words">{review.body}</div>
              {review.signature ? (
                <div className="text-muted-foreground flex min-w-0 flex-col gap-1 text-[11px]">
                  <span>{t("email.draftReviewSignature")}</span>
                  <pre className="bg-muted/40 max-h-24 overflow-auto rounded-lg p-2 font-sans text-[11px] whitespace-pre-wrap break-words">{review.signature}</pre>
                </div>
              ) : null}
              {review.reply ? <p className="text-muted-foreground text-xs">{t("email.draftReviewReply")}</p> : null}
              {sendError ? <p role="alert" className="text-warning text-xs break-words">{t("email.draftSendFailedDetail", { message: sendError })}</p> : null}
            </div>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={sending} onClick={() => setReviewOpen(false)}>{t("common.cancel")}</Button>
            <Button type="button" disabled={sending || !review} onClick={() => void confirmSend()}>
              {sending ? <Loader2Icon aria-hidden className="animate-spin motion-reduce:animate-none" /> : <SendIcon aria-hidden />}
              {sending ? t("email.draftSending") : t("email.draftConfirmSend")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={discardOpen} onOpenChange={(open) => { if (!discarding) setDiscardOpen(open); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("email.draftDiscardTitle")}</DialogTitle>
            <DialogDescription>{textDraft ? t("email.textDraftDiscardBody") : t("email.draftDiscardBody")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={discarding} onClick={() => setDiscardOpen(false)}>{t("common.cancel")}</Button>
            <Button type="button" variant="destructive" disabled={discarding} onClick={() => void discardDraft()}>
              {discarding ? <Loader2Icon aria-hidden className="animate-spin motion-reduce:animate-none" /> : <Trash2Icon aria-hidden />}
              {t("email.draftDiscardConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
