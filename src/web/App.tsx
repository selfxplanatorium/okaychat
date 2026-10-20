import { Suspense, useCallback, useEffect, useState } from "react";
import { useLocation } from "wouter";
import { AppLoading } from "@/components/AppLoading";
import { AuthScreen } from "@/components/AuthScreen";
import { TooltipProvider } from "@/components/ui/tooltip";
import { api, prefetch } from "@/lib/api";
import { preloadable } from "@/lib/preloadable";
import { useApplyAppearance } from "@/state/appearance";
import { useSyncAppearance } from "@/state/appearance-sync";
import { preloadData } from "@/state/data";
import type { Me } from "@shared/types";

const Shell = preloadable(() => import("./ChatShell").then((m) => m.Shell));
const SharePage = preloadable(() => import("@/components/share/SharePage").then((m) => m.SharePage));

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
  const check = useCallback(
    () =>
      void api<AuthStatus>("/auth/status").then((next) => {
        // Fetch the shell chunk and its data while the appearance request is in flight, not after it.
        if (next.user) {
          prefetch("/appearance");
          void Shell.preload().catch(() => {});
          preloadData(next.user.id);
        }
        setStatus(next);
      }),
    [],
  );

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
        appearanceReady ? <Suspense fallback={<AppLoading />}><Shell key={status.user.id} userId={status.user.id} /></Suspense> : <AppLoading />
      ) : (
        <AuthScreen needsSetup={status.needsSetup} signupOpen={status.signupOpen} onDone={check} />
      )}
    </TooltipProvider>
  );
}
