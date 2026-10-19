import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { useLocation } from "wouter";
import { AuthScreen } from "@/components/AuthScreen";
import { TooltipProvider } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { useApplyAppearance } from "@/state/appearance";
import { useSyncAppearance } from "@/state/appearance-sync";
import type { Me } from "@shared/types";

const Shell = lazy(() => import("./ChatShell").then((m) => ({ default: m.Shell })));
const SharePage = lazy(() => import("@/components/share/SharePage").then((m) => ({ default: m.SharePage })));

export function AppLoading() {
  return <div role="status" className="text-muted-foreground grid h-full place-items-center text-sm">Loading okaychat…</div>;
}

type AuthStatus = { user: Me | null; needsSetup: boolean; signupOpen: boolean };

export function App() {
  useApplyAppearance();
  const [location] = useLocation();
  // Shared chats are public: no auth check, no app shell.
  const share = location.match(/^\/share\/([\w-]+)$/);
  if (share) return <Suspense fallback={<AppLoading />}><SharePage token={share[1]!} /></Suspense>;
  return <AuthedApp />;
}

function AuthedApp() {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const appearanceReady = useSyncAppearance(status?.user?.id);
  const check = useCallback(() => void api<AuthStatus>("/auth/status").then(setStatus), []);

  useEffect(() => {
    check();
    const onUnauthorized = () => check();
    window.addEventListener("okaychat:unauthorized", onUnauthorized);
    return () => window.removeEventListener("okaychat:unauthorized", onUnauthorized);
  }, [check]);

  if (!status) return <AppLoading />;
  return (
    <TooltipProvider>
      {status.user ? (
        appearanceReady ? <Suspense fallback={<AppLoading />}><Shell key={status.user.id} /></Suspense> : <AppLoading />
      ) : (
        <AuthScreen needsSetup={status.needsSetup} signupOpen={status.signupOpen} onDone={check} />
      )}
    </TooltipProvider>
  );
}
