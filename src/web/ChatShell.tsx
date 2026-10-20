import { PanelLeftIcon, SquarePenIcon } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { Route, Switch, useLocation } from "wouter";
import { useAui } from "@assistant-ui/react";
import { ArtifactPanel } from "@/components/artifacts/ArtifactPanel";
import { ChatView } from "@/components/chat/ChatView";
import { Sidebar } from "@/components/layout/Sidebar";
import { Onboarding } from "@/components/Onboarding";
import { ChatPrivacyMenu } from "@/components/chat/ChatPrivacyMenu";
import { ThemeEditorHost } from "@/components/settings/theme/ThemeEditorHost";
import { RuntimeProvider } from "@/runtime/RuntimeProvider";
import { useData } from "@/state/data";
import { loadInstalledFonts } from "@/state/fonts";
import { useChatPrivacyStore } from "@/state/chat-privacy";

// Settings (theme editor, font discovery, VS Code import) are not needed to chat.
const SettingsLayout = lazy(() => import("@/components/settings/SettingsLayout").then((m) => ({ default: m.SettingsLayout })));

function ChatHeader({ sidebarOpen, onToggle }: { sidebarOpen: boolean; onToggle: () => void }) {
  const aui = useAui();
  const [, navigate] = useLocation();
  if (sidebarOpen) return null;
  return (
    <div className="shell-chat-header absolute top-2 left-2 z-20 flex gap-1">
      <button
        type="button"
        onClick={onToggle}
        aria-label="Open sidebar"
        className="surface-glass text-muted-foreground hover:text-foreground rounded-lg border p-1.5 transition-colors duration-(--motion-fast) ease-out-quart"
      >
        <PanelLeftIcon className="size-4" />
      </button>
      <button
        type="button"
        aria-label="New chat"
        onClick={async () => {
          await aui.threads.switchToNewThread();
          useChatPrivacyStore.getState().set(aui.threadListItem.getState().id, { temporary: false, personalized: true });
          navigate("/");
        }}
        className="surface-glass text-muted-foreground hover:text-foreground rounded-lg border p-1.5 transition-colors duration-(--motion-fast) ease-out-quart"
      >
        <SquarePenIcon className="size-4" />
      </button>
    </div>
  );
}

export function Shell() {
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const load = useData((s) => s.load);
  const connected = useData((s) => s.providers.some((p) => p.connected));
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth >= 768);
  const [location] = useLocation();
  const route = location.startsWith("/settings") ? "settings" : "chat";

  const reload = useCallback(() => {
    setLoadError(null);
    void load().then(() => setLoaded(true)).catch(() => setLoadError("Could not load your chats and settings."));
    // Uploaded fonts apply on every page, so they load with the shell. A failure here must not block the app.
    void loadInstalledFonts();
  }, [load]);
  useEffect(reload, [reload]);

  if (loadError)
    return (
      <div role="alert" className="animate-fade-in grid h-full place-content-center gap-3 text-center text-sm">
        <p>{loadError}</p>
        <button type="button" className="text-primary underline underline-offset-4" onClick={reload}>
          Try again
        </button>
      </div>
    );
  if (!loaded)
    return (
      <div role="status" className="text-muted-foreground animate-fade-in grid h-full place-items-center text-sm">
        Loading your chats…
      </div>
    );
  if (!connected && !location.startsWith("/settings")) return <Onboarding />;

  return (
    <RuntimeProvider>
      <div className="animate-fade-in flex h-full">
        <Sidebar open={sidebarOpen} onToggle={() => setSidebarOpen(!sidebarOpen)} />
        {/* Always mounted so the backdrop can fade out; pointer events are off while closed. */}
        <div
          aria-hidden
          data-open={sidebarOpen}
          onClick={() => setSidebarOpen(false)}
          className="shell-scrim fixed inset-0 z-30 bg-black/30 md:hidden"
        />
        <div className="relative flex min-w-0 flex-1">
          {/* Keyed by the top-level route: chat and settings crossfade, sections inside settings do not. */}
          <div key={route} className="animate-rise-in relative flex min-w-0 flex-1 flex-col">
            <Switch>
              <Route path="/settings/:section">
                {(p) => (
                  <Suspense fallback={null}>
                    <SettingsLayout section={p.section} />
                  </Suspense>
                )}
              </Route>
              <Route path="/settings">
                {() => (
                  <Suspense fallback={null}>
                    <SettingsLayout section="general" />
                  </Suspense>
                )}
              </Route>
              <Route>
                <ChatHeader sidebarOpen={sidebarOpen} onToggle={() => setSidebarOpen(true)} />
                <ChatPrivacyMenu />
                <ChatView />
              </Route>
            </Switch>
          </div>
          {!location.startsWith("/settings") && <ArtifactPanel />}
        </div>
      </div>
      <ThemeEditorHost />
    </RuntimeProvider>
  );
}
