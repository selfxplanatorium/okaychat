import { PanelLeftIcon, SquarePenIcon } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { Route, Switch, useLocation } from "wouter";
import { useAui } from "@assistant-ui/react";
import { ArtifactPanel } from "@/components/artifacts/ArtifactPanel";
import { AuthScreen } from "@/components/AuthScreen";
import { ChatView } from "@/components/chat/ChatView";
import { Sidebar } from "@/components/layout/Sidebar";
import { Onboarding } from "@/components/Onboarding";
import { ShareButton } from "@/components/share/ShareButton";
import { SharePage } from "@/components/share/SharePage";
import { TooltipProvider } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { RuntimeProvider } from "@/runtime/RuntimeProvider";
import { useApplyAppearance } from "@/state/appearance";
import { useData } from "@/state/data";
import type { Me } from "@shared/types";

// Settings (theme editor, font discovery, VS Code import) are not needed to chat.
const SettingsLayout = lazy(() => import("@/components/settings/SettingsLayout").then((m) => ({ default: m.SettingsLayout })));

type AuthStatus = { user: Me | null; needsSetup: boolean; signupOpen: boolean };

function ChatHeader({ sidebarOpen, onToggle }: { sidebarOpen: boolean; onToggle: () => void }) {
  const aui = useAui();
  const [, navigate] = useLocation();
  if (sidebarOpen) return null;
  return (
    <div className="absolute top-2 left-2 z-20 flex gap-1">
      <button type="button" onClick={onToggle} aria-label="Open sidebar" className="surface-glass text-muted-foreground hover:text-foreground rounded-lg border p-1.5">
        <PanelLeftIcon className="size-4" />
      </button>
      <button
        type="button"
        aria-label="New chat"
        onClick={() => {
          aui.threads.switchToNewThread();
          navigate("/");
        }}
        className="surface-glass text-muted-foreground hover:text-foreground rounded-lg border p-1.5"
      >
        <SquarePenIcon className="size-4" />
      </button>
    </div>
  );
}

function Shell() {
  const loaded = useData((s) => s.loaded);
  const load = useData((s) => s.load);
  const connected = useData((s) => s.providers.some((p) => p.connected));
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth >= 768);
  const [location] = useLocation();

  useEffect(() => {
    void load();
  }, [load]);

  if (!loaded) return null;
  if (!connected && !location.startsWith("/settings")) return <Onboarding />;

  return (
    <RuntimeProvider>
      <div className="flex h-full">
        <Sidebar open={sidebarOpen} onToggle={() => setSidebarOpen(!sidebarOpen)} />
        {sidebarOpen && <div className="fixed inset-0 z-30 bg-black/30 md:hidden" onClick={() => setSidebarOpen(false)} />}
        <div className="relative flex min-w-0 flex-1">
          <div className="relative flex min-w-0 flex-1 flex-col">
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
                <ShareButton />
                <ChatView />
              </Route>
            </Switch>
          </div>
          {!location.startsWith("/settings") && <ArtifactPanel />}
        </div>
      </div>
    </RuntimeProvider>
  );
}

export function App() {
  useApplyAppearance();
  const [location] = useLocation();
  // Shared chats are public: no auth check, no app shell.
  const share = location.match(/^\/share\/([\w-]+)$/);
  if (share) return <SharePage token={share[1]!} />;
  return <AuthedApp />;
}

function AuthedApp() {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const check = useCallback(() => void api<AuthStatus>("/auth/status").then(setStatus), []);

  useEffect(() => {
    check();
    const onUnauthorized = () => check();
    window.addEventListener("okaychat:unauthorized", onUnauthorized);
    return () => window.removeEventListener("okaychat:unauthorized", onUnauthorized);
  }, [check]);

  if (!status) return null;
  return (
    <TooltipProvider>
      {status.user ? <Shell key={status.user.id} /> : <AuthScreen needsSetup={status.needsSetup} signupOpen={status.signupOpen} onDone={check} />}
    </TooltipProvider>
  );
}
