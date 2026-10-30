import { PanelLeftIcon, SquarePenIcon } from "lucide-react";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Route, Switch, useLocation } from "wouter";
import { useAui, useAuiState } from "@assistant-ui/react";
import { AppLoading } from "@/components/AppLoading";
import { ArtifactPanel } from "@/components/artifacts/ArtifactPanel";
import { ChatView } from "@/components/chat/ChatView";
import { Sidebar } from "@/components/layout/Sidebar";
import { useDrawerSwipe } from "@/components/layout/use-drawer-swipe";
import { useBackClose } from "@/hooks/use-back-close";
import { Onboarding } from "@/components/Onboarding";
import { ChatPrivacyMenu } from "@/components/chat/ChatPrivacyMenu";
import { StorageNotice } from "@/components/StorageNotice";
import { ThemeEditorHost } from "@/components/settings/theme/ThemeEditorHost";
import { RuntimeProvider } from "@/runtime/RuntimeProvider";
import { preloadable } from "@/lib/preloadable";
import { chatIdFromPath, chatPath, showChat, takePreloadedData, useData } from "@/state/data";
import { loadInstalledFonts } from "@/state/fonts";
import { isTemporaryChat, useChatPrivacyStore } from "@/state/chat-privacy";
import { KeyboardShortcuts } from "@/keyboard/KeyboardShortcuts";
import { useCommand, useShortcutProps } from "@/keyboard/registry";

// Settings (theme editor, font discovery, VS Code import) are not needed to chat.
const NavigationPage = preloadable(() => import("@/components/layout/NavigationPage").then((m) => m.NavigationPage));
const SettingsLayout = preloadable(() => import("@/components/settings/SettingsLayout").then((m) => m.SettingsLayout));

function ChatHeader({ sidebarOpen, onToggle }: { sidebarOpen: boolean; onToggle: () => void }) {
  const aui = useAui();
  const [, navigate] = useLocation();
  const sidebarHint = useShortcutProps("app.toggleSidebar", "Open sidebar");
  const newChatHint = useShortcutProps("nav.newChat", "New chat");
  if (sidebarOpen) return null;
  return (
    <div className="shell-chat-header absolute top-2 left-2 flex gap-1">
      <button
        type="button"
        onClick={onToggle}
        aria-label="Open sidebar"
        {...sidebarHint}
        className="surface-glass text-muted-foreground hover:text-foreground relative z-20 rounded-lg border p-1.5 pointer-coarse:p-2.5 transition-colors duration-(--motion-fast) ease-out-quart"
      >
        <PanelLeftIcon className="size-4" />
      </button>
      <button
        type="button"
        aria-label="New chat"
        {...newChatHint}
        onClick={async () => {
          await aui.threads.switchToNewThread();
          useChatPrivacyStore.getState().set(aui.threadListItem.getState().id, { temporary: false, personalized: true });
          showChat(navigate);
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

/**
 * Keeps the address bar on the open chat (`/c/<id>`, "/" for a new or temporary chat) and the tab named after it.
 * The open chat drives the URL; a URL this component did not write (back/forward, a link, a reload) drives the chat.
 * Switching between chats pushes a history entry, so Back returns to the previous chat.
 */
function ChatUrlSync() {
  const aui = useAui();
  const [location, navigate] = useLocation();
  const remoteId = useAuiState((s) => s.threadListItem.remoteId);
  const title = useAuiState((s) => s.threadListItem.title);
  const stored = remoteId && !isTemporaryChat(remoteId) ? remoteId : undefined;
  // The chat a URL asked for, while the runtime switches to it from `from`. Until it arrives, or the user opens a
  // third chat, the open chat must not rewrite the URL. A ref, so a repeated effect run sees it at once.
  const pending = useRef<{ id: string; from: string | undefined } | undefined>(undefined);
  const written = useRef<string | undefined>(undefined);
  const last = useRef<{ location?: string; stored?: string }>({});

  // Runs after every render: each step compares against the previous run, so repeated runs are no-ops.
  useEffect(() => {
    const prev = last.current;
    last.current = { location, stored };
    const request = pending.current;
    if (request) {
      if (stored === request.from && location === prev.location) return;
      pending.current = undefined;
      if (stored === request.id) {
        written.current = location;
        return;
      }
    }

    const linked = chatIdFromPath(location);
    if (linked && linked !== stored && location !== prev.location && location !== written.current) {
      // The runtime's initial thread does not report a chat it cannot open, so the first render switches too.
      const next = { id: linked, from: stored };
      pending.current = next;
      void Promise.resolve(aui.threads.switchToThread(linked)).catch(() => {
        if (pending.current !== next) return;
        pending.current = undefined;
        navigate("/", { replace: true });
      });
      return;
    }

    const target = stored ? chatPath(stored) : "/";
    written.current = target;
    if (location === target) return;
    // Entering the route, a reload, or a new chat receiving its id replaces the entry; a real switch adds one.
    const push = stored !== prev.stored && prev.stored !== undefined && prev.location === location && location !== "/";
    navigate(target, { replace: !push });
  });

  useEffect(() => {
    document.title = title ? `${title} · okaychat` : "okaychat";
  }, [title]);
  useEffect(() => () => void (document.title = "okaychat"), []);
  return null;
}

export function Shell({ userId }: { userId: string }) {
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const load = useData((s) => s.load);
  const connected = useData((s) => s.providers.some((p) => p.connected));
  const onboardingSkipped = useData((s) => s.settings?.onboardingSkipped === true);
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth >= 768);
  const [location] = useLocation();
  const inSettings = location.startsWith("/settings");
  const inNavigation = ["/scheduled", "/library", "/plugins", "/projects"].includes(location);
  const route = inSettings ? "settings" : inNavigation ? location : "chat";
  // The settings layer stays mounted in the sidebar, so it keeps its last section while the chat is shown.
  const lastSection = useRef<string | undefined>(undefined);
  if (inSettings) lastSection.current = location.split("/")[2] || undefined;
  // Direction of the last move into or out of settings, so the page slides with the sidebar layers.
  const lastRoute = useRef(route);
  const direction = useRef<"forward" | "back" | undefined>(undefined);
  if (lastRoute.current !== route) {
    direction.current = route === "settings" ? "forward" : lastRoute.current === "settings" ? "back" : undefined;
    lastRoute.current = route;
  }

  // Mobile drawer is an overlay: close it after navigation so the page underneath is visible.
  const closeOnMobile = useCallback(() => {
    if (window.matchMedia("(max-width: 767px)").matches) setSidebarOpen(false);
  }, []);
  useEffect(() => {
    closeOnMobile();
  }, [location, closeOnMobile]);
  useDrawerSwipe(sidebarOpen, setSidebarOpen, loaded && !inSettings);
  useCommand("app.toggleSidebar", () => setSidebarOpen((open) => !open), !inSettings);
  useCommand("nav.chatList", () => {
    setSidebarOpen(true);
    // The rail is mounted while closed, so its rows exist; focus waits for the opening frame.
    requestAnimationFrame(() => {
      const rows = document.querySelectorAll<HTMLElement>("[data-slot=aui_thread-list-item-trigger], [data-slot=aui_thread-list-item-select]");
      const active = document.querySelector<HTMLElement>("[data-slot=aui_thread-list-item][data-active] [data-slot=aui_thread-list-item-trigger]");
      (active ?? rows[0])?.focus();
    });
  }, !inSettings);
  useBackClose(sidebarOpen && !inSettings, () => setSidebarOpen(false), "(max-width: 767px)");

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
  if (!connected && !onboardingSkipped && !inSettings) return <Onboarding />;

  return (
    <RuntimeProvider>
      <KeyboardShortcuts />
      {/* No fill mode: a held opacity animation makes this a backdrop root, which leaves the sticky
          composer's blur misplaced while the thread scrolls on mobile Chrome. */}
      <div className="animate-[fade-in_var(--motion-base)_var(--ease-out-quart)] bg-background safe-top safe-x flex h-full">
        <ThreadSwitchWatcher onSwitch={closeOnMobile} />
        {/* Settings swaps the sidebar's contents for its rail. sidebarOpen is kept here, so the chat sidebar returns in the same state. */}
        <Sidebar open={sidebarOpen} onToggle={() => setSidebarOpen(!sidebarOpen)} settings={inSettings} section={lastSection.current} />
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
          <div key={route} data-direction={direction.current} className="shell-route-in relative flex min-w-0 flex-1 flex-col">
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
                {/* Phones have no header bar, so messages fade out under the floating buttons. A gradient, not a
                    mask on the viewport: a mask makes the scroller a backdrop root and mobile Chrome drops the composer's blur. */}
                <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 z-10 h-24 bg-linear-to-b from-background from-15% to-transparent md:hidden" />
                <ChatUrlSync />
                <ChatHeader sidebarOpen={sidebarOpen} onToggle={() => setSidebarOpen(true)} />
                <ChatPrivacyMenu />
                <StorageNotice />
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
