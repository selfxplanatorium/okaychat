import { startConversationImportAccount } from "@/state/conversation-imports";
import { Suspense, useCallback, useEffect, useState } from "react";
import { useLocation } from "wouter";
import { AppLoading } from "@/components/AppLoading";
import { AuthScreen } from "@/components/AuthScreen";
import { Button } from "@/components/ui/button";
import { SharedTooltipHost, TooltipProvider } from "@/components/ui/tooltip";
import { t } from "@/i18n";
import { api, prefetch } from "@/lib/api";
import { preloadable } from "@/lib/preloadable";
import { useApplyAppearance } from "@/state/appearance";
import { useSyncAppearance } from "@/state/appearance-sync";
import { preloadData } from "@/state/data";
import type { Me } from "@shared/types";

const Shell = preloadable(() => import("./ChatShell").then((m) => m.Shell));
const PublicArenaLeaderboard = preloadable(() => import("@/components/arena/PublicArenaLeaderboard").then(m => m.PublicArenaLeaderboard));
const SharePage = preloadable(() => import("@/components/share/SharePage").then((m) => m.SharePage));

type AuthStatus = { user: Me | null; needsSetup: boolean; signupOpen: boolean };

export function App() {
  useApplyAppearance();
  const [location] = useLocation();
  // Shared chats are public: no auth check, no app shell.
  const share = location.match(/^\/share\/([\w-]+)$/);
  return (
    <>
      {location === "/arena/leaderboard" ? <Suspense fallback={<AppLoading />}><PublicArenaLeaderboard /></Suspense> : share ? <Suspense fallback={<AppLoading />}><SharePage token={share[1]!} /></Suspense> : <AuthedApp />}
      <SharedTooltipHost />
    </>
  );
}

function AuthedApp() {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const appearanceReady = useSyncAppearance(status?.user?.id);
  const check = useCallback(() => {
    setFailed(false);
    void api<AuthStatus>("/auth/status").then(
      (next) => {
        startConversationImportAccount(next.user?.id??"");
        // Fetch the shell chunk and its data while the appearance request is in flight, not after it.
        if (next.user) {
          prefetch("/appearance");
          void Shell.preload().catch(() => {});
          preloadData(next.user.id);
        }
        setStatus(next);
      },
      // Without this an offline start or a 502 would leave the loading screen up for good.
      () => setFailed(true),
    );
  }, []);

  useEffect(() => {
    check();
    const onUnauthorized = () => check();
    window.addEventListener("okaychat:unauthorized", onUnauthorized);
    return () => window.removeEventListener("okaychat:unauthorized", onUnauthorized);
  }, [check]);

  useEffect(() => {
    if (!failed || status) return;
    window.addEventListener("online", check);
    return () => window.removeEventListener("online", check);
  }, [failed, status, check]);

  if (!status) {
    if (!failed) return <AppLoading />;
    return (
      <div role="alert" className="text-muted-foreground grid h-full place-items-center text-sm">
        <div className="flex flex-col items-center gap-3">
          <p>{t("shell.startFailed")}</p>
          <Button size="sm" variant="outline" onClick={check}>
            {t("common.retry")}
          </Button>
        </div>
      </div>
    );
  }
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
