import { TriangleAlertIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useData } from "@/state/data";
import { storagePercent } from "./StorageMeter";

// Shown once the account passes 90% of its storage quota. Dismissing hides it for the rest of the
// browser session; a fresh session warns again. At 100% the level changes, which reopens the notice.
const DISMISS_KEY = "okaychat:storage-notice-dismissed";

export function StorageNotice() {
  const storage = useData((s) => s.storage);
  useEffect(() => {
    const refresh = () => { void useData.getState().refreshStorage().catch(() => {}); };
    window.addEventListener("okaychat:storage-changed", refresh);
    window.addEventListener("focus", refresh);
    return () => { window.removeEventListener("okaychat:storage-changed", refresh); window.removeEventListener("focus", refresh); };
  }, []);
  const userId = useData((s) => s.me?.id);
  const dismissKey = `${DISMISS_KEY}:${userId ?? ""}`;
  const [dismissed, setDismissed] = useState(() => {
    try {
      return sessionStorage.getItem(dismissKey);
    } catch {
      return null;
    }
  });
  if (!storage) return null;
  const pct = storagePercent(storage);
  const full = storage.used >= storage.limit;
  if (pct < 90 || dismissed === (full ? "full" : "near")) return null;

  const dismiss = () => {
    try {
      sessionStorage.setItem(dismissKey, full ? "full" : "near");
    } catch {
      // Session storage may be disabled; the notice then just stays.
    }
    setDismissed(full ? "full" : "near");
  };

  return (
    <div
      role={full ? "alert" : "status"}
      className={`depth-float animate-fade-in absolute top-2 left-1/2 z-20 flex max-w-[calc(100%-4rem)] -translate-x-1/2 items-center gap-2 rounded-lg border px-3 py-1.5 text-xs ${
        full ? "border-destructive/30 bg-destructive/10 text-destructive" : "border-warning/30 bg-warning-surface text-warning-foreground"
      }`}
    >
      <TriangleAlertIcon className="size-3.5 shrink-0" aria-hidden />
      <p className="min-w-0">
        {full
          ? "Your storage is full — uploads and generated files are rejected until you delete old chats, attachments, or fonts."
          : "You are close to your storage limit."}
      </p>
      <button type="button" aria-label="Dismiss" onClick={dismiss} className="hover:text-foreground shrink-0 rounded p-0.5 transition-colors duration-(--motion-fast)">
        <XIcon className="size-3.5" />
      </button>
    </div>
  );
}
