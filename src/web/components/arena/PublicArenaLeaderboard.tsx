import { useEffect, useState } from "react";
import { Brand } from "@/components/layout/Brand";
import { t } from "@/i18n";
import { ArenaLeaderboard } from "./ArenaLeaderboard";

/**
 * The anonymous `/arena/leaderboard` page. It never reads the session, models, or settings: the aggregate board
 * is the only request, and the sign-in link is the way into an authenticated battle.
 */
export function PublicArenaLeaderboard() {
  const [window, setWindow] = useState<"all" | "30d">("all");

  useEffect(() => {
    const previous = document.title;
    document.title = t("arena.leaderboardPublicTitle");
    return () => {
      document.title = previous;
    };
  }, []);

  return (
    <div className="h-full overflow-y-auto">
      <header data-glass-surface="toolbar" className="border-border sticky top-0 z-10 border-b">
        <div className="mx-auto flex h-12 w-full max-w-5xl items-center justify-between gap-3 px-4">
          <a href="/" className="transition-opacity duration-(--motion-fast) ease-out-quart hover:opacity-80">
            <Brand />
          </a>
          <a href="/" className="text-primary text-sm underline underline-offset-4">
            {t("arena.leaderboardSignIn")}
          </a>
        </div>
      </header>
      <main>
        <ArenaLeaderboard
          key={window}
          mode="public"
          scope="global"
          window={window}
          onWindowChange={setWindow}
          signInHref="/"
        />
      </main>
    </div>
  );
}
