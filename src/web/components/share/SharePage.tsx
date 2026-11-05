import { AppWindowIcon, CodeIcon, FileSpreadsheetIcon, FileTextIcon, ImageIcon, WrenchIcon } from "lucide-react";
import { OwnedImage } from "@/components/ui/owned-image";
import { originalImageUrl } from "@/lib/media";
import { useAssistantUiThemeTokens } from "generative-frame/assistant-ui";
import { Widget } from "generative-frame/react";
import { SpecRenderer } from "generative-frame/spec/react";
import { useEffect, useState, type CSSProperties } from "react";
import type { ArtifactVersion, SharedPart, SharedThread } from "@shared/types";
import { DocumentPreview } from "@/components/artifacts/DocumentPreview";
import { FRAME_SANDBOX, frameDocument } from "@/components/artifacts/frame";
import { catalog, components } from "@/components/genui/catalog";
import { widgetOptions } from "@/components/genui/toolkit";
import { Brand } from "@/components/layout/Brand";
import { SimpleMarkdown } from "@/components/ui/simple-markdown";
import { t } from "@/i18n";
import { formatDate } from "@/i18n/format";
import { api, ApiError } from "@/lib/api";

function SharedArtifact({ token, part }: { token: string; part: Extract<SharedPart, { type: "artifact" }> }) {
  const [artifact, setArtifact] = useState<ArtifactVersion | null>(null);
  useEffect(() => {
    void api<ArtifactVersion[]>(`/public/shares/${token}/artifacts/${encodeURIComponent(part.id)}`)
      .then((versions) => setArtifact(versions.find((v) => v.version === part.version) ?? versions.at(-1) ?? null))
      .catch(() => {});
  }, [token, part.id, part.version]);
  const Icon =
    part.kind === "code"
      ? CodeIcon
      : part.kind === "markdown" || part.kind === "docx" || part.kind === "pdf"
        ? FileTextIcon
        : part.kind === "xlsx"
          ? FileSpreadsheetIcon
          : part.kind === "svg"
            ? ImageIcon
            : AppWindowIcon;
  const doc = artifact && frameDocument(artifact.kind, artifact.content);
  const isDocument = part.kind === "pdf" || part.kind === "docx" || part.kind === "xlsx";
  const base = `/api/public/shares/${token}/artifacts/${encodeURIComponent(part.id)}`;
  return (
    <div className="my-3 overflow-hidden rounded-xl border">
      <div className="bg-muted/40 flex items-center gap-2 border-b px-3 py-2 text-sm font-medium">
        <Icon className="size-4" /> {part.title}
      </div>
      {!artifact ? null : isDocument ? (
        <div className="h-[32rem]">
          <DocumentPreview
            kind={part.kind as "pdf" | "docx" | "xlsx"}
            fileUrl={`${base}/file?version=${artifact.version}`}
            previewUrl={`${base}/preview?version=${artifact.version}`}
            title={artifact.title}
          />
        </div>
      ) : doc ? (
        <iframe title={artifact.title} sandbox={FRAME_SANDBOX} srcDoc={doc} className="h-[28rem] w-full border-0 bg-white" />
      ) : artifact.kind === "markdown" ? (
        <SimpleMarkdown className="max-h-[28rem] overflow-auto px-4 py-3">{artifact.content}</SimpleMarkdown>
      ) : (
        <pre className="max-h-[28rem] overflow-auto p-4 font-mono text-xs">{artifact.content}</pre>
      )}
    </div>
  );
}

function SharedWidget({ code }: { code: string }) {
  const tokens = useAssistantUiThemeTokens();
  // Read-only: a prompt from the widget has no chat to go to.
  return <Widget code={code} {...widgetOptions} tokens={tokens} onPrompt={() => {}} className="my-3" />;
}

// Interactions still update the spec's local state; actions that would talk to the chat do nothing.
const readOnlyHandlers = {
  sendMessage: () => {},
  updateModelContext: () => {},
  copyText: (params: Record<string, unknown>) => (typeof params.text === "string" ? navigator.clipboard?.writeText(params.text) : undefined),
};

/** Public, read-only view of a shared thread. Rendered without login. */
export function SharePage({ token }: { token: string }) {
  const [thread, setThread] = useState<SharedThread | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const [password, setPassword] = useState("");
  const [unlocking, setUnlocking] = useState(false);
  const [unlockError, setUnlockError] = useState<string | null>(null);

  const load = () =>
    api<SharedThread>(`/public/shares/${token}`)
      .then((shared) => {
        setThread(shared);
        setLocked(false);
        document.title = t("shell.tabTitle", { title: shared.title ?? t("share.sharedChat") });
      })
      .catch((cause: unknown) => {
        // 423 is the only status that asks for a password; everything else is the shared 404 sentence.
        if (cause instanceof ApiError && cause.status === 423) setLocked(true);
        else setError(cause instanceof Error ? cause.message : t("share.loadFailed"));
      });

  useEffect(() => {
    void load();
    // The link is the only input; the fetch itself owns the state.
  }, [token]);

  const unlock = async () => {
    setUnlocking(true);
    setUnlockError(null);
    try {
      await api(`/public/shares/${token}/unlock`, { method: "POST", json: { password } });
      setPassword("");
      await load();
    } catch (cause) {
      const status = cause instanceof ApiError ? cause.status : 0;
      setUnlockError(status === 401 ? t("share.wrongPassword") : status === 429 ? t("share.tooManyAttempts") : t("share.unlockFailed"));
    } finally {
      setUnlocking(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <header data-glass-surface="toolbar" className=" animate-rise-in sticky top-0 z-10 border-b">
        <div className="mx-auto flex h-12 max-w-3xl items-center justify-between px-4">
          <a href="/" className="transition-opacity duration-(--motion-fast) ease-out-quart hover:opacity-80">
            <Brand />
          </a>
          <span className="text-muted-foreground text-xs">
            {thread?.mode === "frozen" ? t("share.frozenSnapshot") : t("share.sharedReadOnly")}
          </span>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-6">
        {error && <p className="text-muted-foreground animate-fade-in py-20 text-center">{error}</p>}
        {locked && !thread && (
          <form
            className="mx-auto flex max-w-sm flex-col gap-3 py-16"
            onSubmit={(event) => {
              event.preventDefault();
              void unlock();
            }}
          >
            <h1 className="text-lg font-semibold tracking-tight">{t("share.unlockTitle")}</h1>
            <p className="text-muted-foreground text-sm">{t("share.unlockBody")}</p>
            <label className="flex flex-col gap-1 text-sm">
              {t("share.unlockPassword")}
              <input
                autoFocus
                type="password"
                value={password}
                autoComplete="current-password"
                onChange={(event) => setPassword(event.target.value)}
                className="bg-muted h-10 rounded-lg border px-3"
              />
            </label>
            {unlockError && <p role="alert" className="text-destructive text-sm">{unlockError}</p>}
            <button type="submit" disabled={unlocking || !password} className="bg-primary text-primary-foreground h-10 rounded-lg text-sm font-medium disabled:opacity-50">
              {t("share.unlock")}
            </button>
          </form>
        )}
        {thread && (
          <>
            <h1 className="animate-rise-in mb-1 text-2xl font-semibold tracking-tight">{thread.title ?? t("share.sharedChat")}</h1>
            <p className="text-muted-foreground animate-fade-in mb-6 text-sm">
              {formatDate(thread.createdAt, { dateStyle: "long" })}
              {thread.mode === "frozen" && thread.frozenAt !== null && <> · {t("share.snapshotAt", { date: formatDate(thread.frozenAt) })}</>}
              {thread.expiresAt !== null && <> · {t("share.linkExpires", { date: formatDate(thread.expiresAt) })}</>}
              {thread.mode === "live" && <> · {t("share.liveLink")}</>}
            </p>
            <div className="flex flex-col gap-6">
              {thread.messages.map((m, index) =>
                m.role === "user" ? (
                  <div
                    key={m.id}
                    style={{ "--i": Math.min(index, 7) } as CSSProperties}
                    className="stagger animate-rise-in bg-muted ms-auto max-w-[85%] rounded-2xl px-4 py-2.5 whitespace-pre-wrap"
                  >
                    {m.parts.map((p, i) =>
                      p.type === "text" ? <span key={i}>{p.text}</span> : p.type === "image" ? (
                        <OwnedImage key={i} src={p.url} href={originalImageUrl(p.url)} linkClassName="block w-fit max-w-full" alt="" variant="medium" width={p.width} height={p.height} className="my-1 h-auto max-h-64 w-auto max-w-full rounded-lg" />
                      ) : null,
                    )}
                  </div>
                ) : (
                  <div
                    key={m.id}
                    style={{ "--i": Math.min(index, 7) } as CSSProperties}
                    className="stagger animate-rise-in leading-relaxed"
                  >
                    {m.parts.map((p, i) =>
                      p.type === "text" ? (
                        <SimpleMarkdown key={i} className="text-base">
                          {p.text}
                        </SimpleMarkdown>
                      ) : p.type === "image" ? (
                        <OwnedImage key={i} src={p.url} href={originalImageUrl(p.url)} linkClassName="block w-fit max-w-full" alt="" variant="large" width={p.width} height={p.height} sizes="(min-width: 768px) 42rem, 100vw" className="my-3 h-auto max-h-[32rem] w-auto max-w-full rounded-xl border" />
                      ) : p.type === "artifact" ? (
                        <SharedArtifact key={i} token={token} part={p} />
                      ) : p.type === "widget" ? (
                        <SharedWidget key={i} code={p.code} />
                      ) : p.type === "spec" ? (
                        <div key={i} className="my-3">
                          <SpecRenderer spec={p.spec} catalog={catalog} components={components} handlers={readOnlyHandlers} />
                        </div>
                      ) : (
                        <p key={i} className="text-muted-foreground my-1 flex items-center gap-1.5 text-xs">
                          <WrenchIcon className="size-3" /> {t("share.usedTool", { name: p.name.replaceAll("_", " ") })}
                        </p>
                      ),
                    )}
                  </div>
                ),
              )}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
