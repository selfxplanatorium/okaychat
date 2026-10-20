import { useAui, useAuiState } from "@assistant-ui/react";
import { MoreHorizontalIcon, VenetianMaskIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { ShareButton } from "@/components/share/ShareButton";
import { api } from "@/lib/api";
import { chatPrivacyFor, useChatPrivacy, useChatPrivacyStore } from "@/state/chat-privacy";
import { useThreadMeta, useThreadMetaStore } from "@/state/thread-meta";

/** Chat-level choices belong to the header; the composer is reserved for writing and model controls. */
export function ChatPrivacyMenu() {
  const aui = useAui();
  const privacy = useChatPrivacy();
  const meta = useThreadMeta();
  const running = useAuiState((s) => s.thread.isRunning);
  const refresh = useThreadMetaStore((s) => s.refresh);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [memoryEnabled, setMemoryEnabled] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    const load = () => void api<{ enabled: boolean }>("/memory/preferences").then((p) => { if (active) setMemoryEnabled(p.enabled); }).catch(() => {});
    load();
    window.addEventListener("focus", load);
    window.addEventListener("okaychat:memory", load);
    return () => { active = false; window.removeEventListener("focus", load); window.removeEventListener("okaychat:memory", load); };
  }, []);

  const changeChat = async (temporary: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const previous = aui.threadListItem.getState();
      await aui.threads.switchToNewThread();
      const next = aui.threadListItem.getState();
      useChatPrivacyStore.getState().set(next.id, { temporary, personalized: !temporary });
      if (previous.id !== next.id && chatPrivacyFor(previous).temporary) await aui.threads.item({ id: previous.id }).delete();
      setOpen(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not start a chat. Try again."); }
    finally { setBusy(false); }
  };

  return (
    <div className="shell-chat-actions absolute top-2 right-2 z-20 flex items-center gap-1">
      {!privacy.temporary && <ShareButton />}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger className="surface-glass text-muted-foreground hover:text-foreground inline-flex h-8 items-center gap-2 rounded-lg border px-2 transition-colors duration-(--motion-fast)" aria-label={privacy.temporary ? "Anonymous chat options" : "Chat options"}>
          {privacy.temporary ? <><VenetianMaskIcon className="size-4" /><span className="text-xs font-medium">Anonymous</span></> : <MoreHorizontalIcon className="size-4" />}
        </PopoverTrigger>
        <PopoverContent align="end" className="w-80 max-w-[calc(100vw-1rem)] p-4">
          <h2 className="text-sm font-medium">{privacy.temporary ? "Anonymous chat" : "Chat options"}</h2>
          {privacy.temporary ? <>
            <p className="text-muted-foreground mt-1 text-xs">Not saved in history. Disappears when you reload. Never creates memories.</p>
            <div className="my-4 flex items-center justify-between gap-4">
              <div>
                <label htmlFor="anonymous-personalization" className="text-sm font-medium">Personalize this chat</label>
                <p className="text-muted-foreground mt-1 text-xs">Use your saved memories and custom instructions for this chat.</p>
              </div>
              <Switch id="anonymous-personalization" checked={privacy.personalized} disabled={busy || running} onCheckedChange={(personalized) => {
                const item = aui.threadListItem.getState();
                useChatPrivacyStore.getState().set(item.remoteId ?? item.id, { temporary: true, personalized });
              }} />
            </div>
            <Button variant="outline" className="w-full" disabled={busy || running} onClick={() => void changeChat(false)}>End anonymous chat</Button>
          </> : <>
            <div className="my-4 flex items-center justify-between gap-4">
              <div>
                <label htmlFor="chat-memory" className="text-sm font-medium">Use memory for this chat</label>
                <p className="text-muted-foreground mt-1 text-xs">{memoryEnabled === false ? "Memory is paused in your account settings." : "Allow saved memories and new memories in this chat."}</p>
              </div>
              <Switch id="chat-memory" checked={memoryEnabled === true && !meta?.memoryDisabled} disabled={busy || running || memoryEnabled !== true} onCheckedChange={async (enabled) => {
                setBusy(true);
                setError(null);
                try {
                  const { remoteId } = await aui.threadListItem.initialize();
                  await api(`/threads/${remoteId}`, { method: "PATCH", json: { memoryDisabled: !enabled } });
                  await refresh(remoteId);
                } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not change memory. Try again."); }
                finally { setBusy(false); }
              }} />
            </div>
            <Link href="/settings/memory" onClick={() => setOpen(false)} className="text-muted-foreground hover:text-foreground mb-4 block text-xs underline underline-offset-4">Memory settings</Link>
            <Button variant="outline" className="w-full" disabled={busy || running} onClick={() => void changeChat(true)}><VenetianMaskIcon /> Start anonymous chat</Button>
            <p className="text-muted-foreground mt-2 text-xs">Start fresh without saving history or using personalization.</p>
          </>}
          {error && <p role="alert" className="text-destructive mt-3 text-xs">{error}</p>}
        </PopoverContent>
      </Popover>
    </div>
  );
}
