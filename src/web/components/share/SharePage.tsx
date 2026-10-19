import { AppWindowIcon, CodeIcon, FileTextIcon, ImageIcon, WrenchIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { ArtifactVersion, SharedPart, SharedThread } from "@shared/types";
import { FRAME_SANDBOX, frameDocument } from "@/components/artifacts/frame";
import { Brand } from "@/components/layout/Brand";
import { SimpleMarkdown } from "@/components/ui/simple-markdown";
import { api } from "@/lib/api";

function SharedArtifact({ token, part }: { token: string; part: Extract<SharedPart, { type: "artifact" }> }) {
  const [artifact, setArtifact] = useState<ArtifactVersion | null>(null);
  useEffect(() => {
    void api<ArtifactVersion[]>(`/public/shares/${token}/artifacts/${encodeURIComponent(part.id)}`)
      .then((versions) => setArtifact(versions.find((v) => v.version === part.version) ?? versions.at(-1) ?? null))
      .catch(() => {});
  }, [token, part.id, part.version]);
  const Icon = part.kind === "code" ? CodeIcon : part.kind === "markdown" ? FileTextIcon : part.kind === "svg" ? ImageIcon : AppWindowIcon;
  const doc = artifact && frameDocument(artifact.kind, artifact.content);
  return (
    <div className="my-3 overflow-hidden rounded-xl border">
      <div className="bg-muted/40 flex items-center gap-2 border-b px-3 py-2 text-sm font-medium">
        <Icon className="size-4" /> {part.title}
      </div>
      {!artifact ? null : doc ? (
        <iframe title={artifact.title} sandbox={FRAME_SANDBOX} srcDoc={doc} className="h-[28rem] w-full border-0 bg-white" />
      ) : artifact.kind === "markdown" ? (
        <SimpleMarkdown className="max-h-[28rem] overflow-auto px-4 py-3">{artifact.content}</SimpleMarkdown>
      ) : (
        <pre className="max-h-[28rem] overflow-auto p-4 font-mono text-xs">{artifact.content}</pre>
      )}
    </div>
  );
}

/** Public, read-only view of a shared thread. Rendered without login. */
export function SharePage({ token }: { token: string }) {
  const [thread, setThread] = useState<SharedThread | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<SharedThread>(`/public/shares/${token}`)
      .then((t) => {
        setThread(t);
        document.title = `${t.title ?? "Shared chat"} · okaychat`;
      })
      .catch((e: Error) => setError(e.message));
  }, [token]);

  return (
    <div className="h-full overflow-y-auto">
      <header className="bg-background/80 sticky top-0 z-10 border-b backdrop-blur">
        <div className="mx-auto flex h-12 max-w-3xl items-center justify-between px-4">
          <a href="/">
            <Brand />
          </a>
          <span className="text-muted-foreground text-xs">Shared chat · read only</span>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-6">
        {error && <p className="text-muted-foreground py-20 text-center">{error}</p>}
        {thread && (
          <>
            <h1 className="mb-1 text-2xl font-semibold tracking-tight">{thread.title ?? "Shared chat"}</h1>
            <p className="text-muted-foreground mb-6 text-sm">{new Date(thread.createdAt).toLocaleDateString(undefined, { dateStyle: "long" })}</p>
            <div className="flex flex-col gap-6">
              {thread.messages.map((m) =>
                m.role === "user" ? (
                  <div key={m.id} className="bg-muted ms-auto max-w-[85%] rounded-2xl px-4 py-2.5 whitespace-pre-wrap">
                    {m.parts.map((p, i) =>
                      p.type === "text" ? <span key={i}>{p.text}</span> : p.type === "image" ? <img key={i} src={p.url} alt="" className="my-1 max-h-64 rounded-lg" /> : null,
                    )}
                  </div>
                ) : (
                  <div key={m.id} className="leading-relaxed">
                    {m.parts.map((p, i) =>
                      p.type === "text" ? (
                        <SimpleMarkdown key={i} className="text-base">
                          {p.text}
                        </SimpleMarkdown>
                      ) : p.type === "image" ? (
                        <img key={i} src={p.url} alt="" className="my-3 max-h-[32rem] rounded-xl border" />
                      ) : p.type === "artifact" ? (
                        <SharedArtifact key={i} token={token} part={p} />
                      ) : (
                        <p key={i} className="text-muted-foreground my-1 flex items-center gap-1.5 text-xs">
                          <WrenchIcon className="size-3" /> Used {p.name.replaceAll("_", " ")}
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
