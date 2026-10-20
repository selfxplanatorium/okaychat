import { PanelLeftIcon, SquarePenIcon } from "lucide-react";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Route, Switch, useLocation } from "wouter";
import { useAui, useAuiState } from "@assistant-ui/react";
import { AppLoading } from "@/components/AppLoading";
import { ArtifactPanel } from "@/components/artifacts/ArtifactPanel";
import { ChatView } from "@/components/chat/ChatView";
import { Sidebar } from "@/components/layout/Sidebar";
import { useDrawerSwipe } from "@/components/layout/use-drawer-swipe";
import { Onboarding } from "@/components/Onboarding";
import { ChatPrivacyMenu } from "@/components/chat/ChatPrivacyMenu";
import { ThemeEditorHost } from "@/components/settings/theme/ThemeEditorHost";
import { RuntimeProvider } from "@/runtime/RuntimeProvider";
import { preloadable } from "@/lib/preloadable";
import { takePreloadedData, useData } from "@/state/data";
import { loadInstalledFonts } from "@/state/fonts";
import { useChatPrivacyStore } from "@/state/chat-privacy";

// Settings (theme editor, font discovery, VS Code import) are not needed to chat.
const NavigationPage = preloadable(() => import("@/components/layout/NavigationPage").then((m) => m.NavigationPage));
const SettingsLayout = preloadable(() => import("@/components/settings/SettingsLayout").then((m) => m.SettingsLayout));

function ChatHeader({ sidebarOpen, onToggle }: { sidebarOpen: boolean; onToggle: () => void }) {
  const aui = useAui();
  const [, navigate] = useLocation();
  if (sidebarOpen) return null;
  return (
    <div className="shell-chat-header absolute top-2 left-2 flex gap-1">
      <button
        type="button"
        onClick={onToggle}
        aria-label="Open sidebar"
        className="surface-glass text-muted-foreground hover:text-foreground relative z-20 rounded-lg border p-1.5 pointer-coarse:p-2.5 transition-colors duration-(--motion-fast) ease-out-quart"
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
        className="surface-glass text-muted-foreground hover:text-foreground relative z-20 rounded-lg border p-1.5 pointer-coarse:p-2.5 transition-colors duration-(--motion-fast) ease-out-quart"
      >
        <SquarePenIcon className="size-4" />
      </button>
    </div>
  );
}

// Fires when the active thread changes, so picking a chat in the drawer also closes it on mobile.
function ThreadSwitchWatcher({ onSwitch }: { onSwitch: () => void }) {
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const seen = useRef(threadId);
  useEffect(() => {
    if (seen.current === threadId) return;
    seen.current = threadId;
    onSwitch();
  }, [threadId, onSwitch]);
  return null;
}

export function Shell({ userId }: { userId: string }) {
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const load = useData((s) => s.load);
  const connected = useData((s) => s.providers.some((p) => p.connected));
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth >= 768);
  const [location] = useLocation();
  const inSettings = location.startsWith("/settings");
  const inNavigation = ["/scheduled", "/library", "/plugins", "/projects"].includes(location);
  const route = inSettings ? "settings" : inNavigation ? location : "chat";

  // Mobile drawer is an overlay: close it after navigation so the page underneath is visible.
  const closeOnMobile = useCallback(() => {
    if (window.matchMedia("(max-width: 767px)").matches) setSidebarOpen(false);
  }, []);
  useEffect(() => {
    closeOnMobile();
  }, [location, closeOnMobile]);
  useDrawerSwipe(sidebarOpen, setSidebarOpen, loaded && !inSettings);

  const reload = useCallback(() => {
    setLoadError(null);
    void (takePreloadedData(userId) ?? load()).then(() => setLoaded(true)).catch(() => setLoadError("Could not load your chats and settings."));
    // Uploaded fonts apply on every page, so they load with the shell. A failure here must not block the app.
    void loadInstalledFonts();
  }, [load, userId]);
  useEffect(reload, [reload]);

  // Fetch the other routes once the chat is idle, so the first visit renders without a wait.
  useEffect(() => {
    if (!loaded) return;
    const preload = () => {
      void SettingsLayout.preload().catch(() => {});
      void NavigationPage.preload().catch(() => {});
    };
    if (!("requestIdleCallback" in window)) {
      const timer = setTimeout(preload, 2000);
      return () => clearTimeout(timer);
    }
    const handle = requestIdleCallback(preload, { timeout: 5000 });
    return () => cancelIdleCallback(handle);
  }, [loaded]);

  if (loadError)
    return (
      <div role="alert" className="animate-fade-in grid h-full place-content-center gap-3 text-center text-sm">
        <p>{loadError}</p>
        <button type="button" className="text-primary underline underline-offset-4" onClick={reload}>
          Try again
        </button>
      </div>
    );
  if (!loaded) return <AppLoading />;
  if (!connected && !inSettings) return <Onboarding />;

  return (
    <RuntimeProvider>
      <div className="animate-fade-in depth-canvas safe-top safe-x flex h-full">
        <ThreadSwitchWatcher onSwitch={closeOnMobile} />
        {/* Settings has its own navigation rail. sidebarOpen is kept here, so the sidebar returns in the same state. */}
        {!inSettings && <Sidebar open={sidebarOpen} onToggle={() => setSidebarOpen(!sidebarOpen)} />}
        {/* Always mounted so the backdrop can fade out; pointer events are off while closed. */}
        {!inSettings && (
          <div
            aria-hidden
            data-open={sidebarOpen}
            onClick={() => setSidebarOpen(false)}
            className="shell-scrim fixed inset-0 z-30 bg-black/30 md:hidden"
          />
        )}
        <div className="relative flex min-w-0 flex-1">
          {/* Keyed by the top-level route: chat and settings crossfade, sections inside settings do not. */}
          <div key={route} className="shell-route-in relative flex min-w-0 flex-1 flex-col">
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
                    <SettingsLayout />
                  </Suspense>
                )}
              </Route>
              {["scheduled", "library", "plugins", "projects"].map((page) => (
                <Route key={page} path={`/${page}`}>
                  <div className={`flex h-12 shrink-0 items-center px-3 ${sidebarOpen ? "md:hidden" : ""}`}>
                    <button type="button" aria-label="Open sidebar" onClick={() => setSidebarOpen(true)} className="text-muted-foreground hover:bg-accent rounded-lg p-2 pointer-coarse:p-3"><PanelLeftIcon className="size-4" /></button>
                  </div>
                  <main className="min-h-0 flex-1 overflow-y-auto">
                    <Suspense fallback={<p role="status" className="text-muted-foreground p-8 text-sm">Loading…</p>}><NavigationPage page={page} /></Suspense>
                  </main>
                </Route>
              ))}
              <Route>
                {/* Phones have no header bar, so messages scrolling under the floating buttons blur out instead of colliding with them. */}
                <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 z-10 h-20 bg-background/75 backdrop-blur-md [mask-image:linear-gradient(to_bottom,black_55%,transparent)] md:hidden" />
                <ChatHeader sidebarOpen={sidebarOpen} onToggle={() => setSidebarOpen(true)} />
                <ChatPrivacyMenu />
                <ChatView />
              </Route>
            </Switch>
          </div>
          {!inSettings && !inNavigation && <ArtifactPanel />}
        </div>
      </div>
      <ThemeEditorHost />
    </RuntimeProvider>
  );
}
