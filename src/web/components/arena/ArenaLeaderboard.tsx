import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  Loader2Icon,
  RefreshCwIcon,
  SearchIcon,
} from "lucide-react";
import type { LeaderboardPage, LeaderboardRow } from "@shared/arena";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Select } from "@/components/ui/select";
import { t, type PlainMessageKey } from "@/i18n";
import { formatDateTime, formatNumber, formatPercent } from "@/i18n/format";
import {
  arenaErrorKey,
  getArenaLeaderboard,
  type ArenaLeaderboardDirection,
  type ArenaLeaderboardProvisional,
  type ArenaLeaderboardSort,
} from "@/lib/arena-api";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 50;
const MAX_OFFSET = 10_000;

const BOARD_ERROR: Record<"notAvailable", PlainMessageKey> = {
  notAvailable: "arena.leaderboardNotAvailable",
};

const SORT_LABEL: Record<ArenaLeaderboardSort, "arena.leaderboardRank" | "arena.leaderboardRating" | "arena.leaderboardBattles" | "arena.leaderboardWins" | "arena.leaderboardWinRate"> = {
  rank: "arena.leaderboardRank",
  rating: "arena.leaderboardRating",
  battles: "arena.leaderboardBattles",
  wins: "arena.leaderboardWins",
  winRate: "arena.leaderboardWinRate",
};

function defaultDirection(sort: ArenaLeaderboardSort): ArenaLeaderboardDirection {
  return sort === "rank" ? "asc" : "desc";
}

function LeaderboardTable({
  rows,
  sort,
  direction,
  onSort,
}: {
  rows: LeaderboardRow[];
  sort: ArenaLeaderboardSort;
  direction: ArenaLeaderboardDirection;
  onSort: (sort: ArenaLeaderboardSort) => void;
}) {
  return (
    <div className="min-h-0 overflow-x-auto">
      <table className="w-full min-w-[42rem] text-start text-xs">
        <thead className="bg-muted/60">
          <tr>
            <th scope="col" aria-sort={sort === "rank" ? (direction === "asc" ? "ascending" : "descending") : "none"} className="text-muted-foreground px-3 py-2 font-medium whitespace-nowrap">
              <button type="button" className="focus-visible:outline-ring inline-flex items-center gap-1 rounded" onClick={() => onSort("rank")}>
                {t(SORT_LABEL.rank)}
                {sort === "rank" && (direction === "asc" ? <ArrowUpIcon className="size-3" /> : <ArrowDownIcon className="size-3" />)}
              </button>
            </th>
            <th scope="col" className="text-muted-foreground px-3 py-2 font-medium">{t("arena.leaderboardModel")}</th>
            <th scope="col" aria-sort={sort === "rating" ? (direction === "asc" ? "ascending" : "descending") : "none"} className="text-muted-foreground px-3 py-2 font-medium whitespace-nowrap">
              <button type="button" className="focus-visible:outline-ring inline-flex items-center gap-1 rounded" onClick={() => onSort("rating")}>
                {t(SORT_LABEL.rating)}
                {sort === "rating" && (direction === "asc" ? <ArrowUpIcon className="size-3" /> : <ArrowDownIcon className="size-3" />)}
              </button>
            </th>
            <th scope="col" aria-sort={sort === "battles" ? (direction === "asc" ? "ascending" : "descending") : "none"} className="text-muted-foreground px-3 py-2 font-medium whitespace-nowrap">
              <button type="button" className="focus-visible:outline-ring inline-flex items-center gap-1 rounded" onClick={() => onSort("battles")}>
                {t(SORT_LABEL.battles)}
                {sort === "battles" && (direction === "asc" ? <ArrowUpIcon className="size-3" /> : <ArrowDownIcon className="size-3" />)}
              </button>
            </th>
            <th scope="col" aria-sort={sort === "wins" ? (direction === "asc" ? "ascending" : "descending") : "none"} className="text-muted-foreground px-3 py-2 font-medium whitespace-nowrap">
              <button type="button" className="focus-visible:outline-ring inline-flex items-center gap-1 rounded" onClick={() => onSort("wins")}>
                {t(SORT_LABEL.wins)}
                {sort === "wins" && (direction === "asc" ? <ArrowUpIcon className="size-3" /> : <ArrowDownIcon className="size-3" />)}
              </button>
            </th>
            <th scope="col" aria-sort={sort === "winRate" ? (direction === "asc" ? "ascending" : "descending") : "none"} className="text-muted-foreground px-3 py-2 font-medium whitespace-nowrap">
              <button type="button" className="focus-visible:outline-ring inline-flex items-center gap-1 rounded" onClick={() => onSort("winRate")}>
                {t(SORT_LABEL.winRate)}
                {sort === "winRate" && (direction === "asc" ? <ArrowUpIcon className="size-3" /> : <ArrowDownIcon className="size-3" />)}
              </button>
            </th>
          </tr>
        </thead>
        <tbody className="divide-border divide-y">
          {rows.map((row) => (
            <tr key={row.modelKey} className="align-top">
              <td className="text-muted-foreground px-3 py-2 text-end tabular-nums">{row.rank ?? "—"}</td>
              <td className="max-w-80 px-3 py-2">
                <div className="flex min-w-0 flex-wrap items-baseline gap-1.5">
                  <span className="min-w-0 truncate font-medium" title={row.label}>{row.label}</span>
                  {row.provisional && (
                    <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-[10px]">
                      {t("arena.leaderboardProvisionalBadge", { count: formatNumber(row.battles) })}
                    </span>
                  )}
                  {!row.available && <span className="text-muted-foreground text-[10px]">{t("arena.leaderboardUnavailable")}</span>}
                </div>
                <p className="text-muted-foreground mt-0.5 text-[11px] tabular-nums">
                  {t("arena.leaderboardDetail", { ties: formatNumber(row.ties), bothBad: formatNumber(row.bothBad) })}
                </p>
              </td>
              <td className="px-3 py-2 text-end tabular-nums">{formatNumber(row.rating, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}</td>
              <td className="px-3 py-2 text-end tabular-nums">{formatNumber(row.battles)}</td>
              <td className="px-3 py-2 text-end tabular-nums">{formatNumber(row.wins)}</td>
              <td className="px-3 py-2 text-end tabular-nums">{row.winRate === null ? "—" : formatPercent(row.winRate, { maximumFractionDigits: 1 })}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Session or public Arena board. It loads only aggregate rows, keeps a visible stale set when a refresh fails,
 * and never treats a failed load as an empty board. Rank is server-computed before filters and paging.
 */
export function ArenaLeaderboard({
  mode,
  scope,
  window,
  onScopeChange,
  onWindowChange,
  onStartBattle,
  signInHref,
}: {
  mode: "session" | "public";
  scope: "mine" | "global";
  window: "all" | "30d";
  onScopeChange?: (scope: "mine" | "global") => void;
  onWindowChange: (window: "all" | "30d") => void;
  onStartBattle?: () => void;
  signInHref?: string;
}) {
  const [rows, setRows] = useState<LeaderboardRow[]>([]);
  const [page, setPage] = useState<LeaderboardPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<PlainMessageKey | null>(null);
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [provisional, setProvisional] = useState<ArenaLeaderboardProvisional>("include");
  const [sort, setSort] = useState<ArenaLeaderboardSort>("rank");
  const [direction, setDirection] = useState<ArenaLeaderboardDirection>("asc");
  const [offset, setOffset] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const token = useRef(0);

  useEffect(() => {
    const request = ++token.current;
    setLoading(true);
    setError(null);
    void getArenaLeaderboard(
      {
        ...(mode === "session" ? { scope } : {}),
        window,
        sort,
        direction,
        q,
        provisional,
        offset,
        limit: PAGE_SIZE,
      },
      mode === "public",
    )
      .then((next) => {
        if (request !== token.current) return;
        setRows(next.rows);
        setPage(next);
        setStale(false);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (request !== token.current) return;
        setError(mode === "public" && cause instanceof ApiError && cause.status === 404 ? BOARD_ERROR.notAvailable : arenaErrorKey(cause));
        setStale(rows.length > 0);
      })
      .finally(() => {
        if (request === token.current) setLoading(false);
      });
  }, [mode, scope, window, sort, direction, q, provisional, offset, refresh]);

  const pages = page ? Math.max(1, Math.ceil(page.total / Math.max(1, page.limit))) : 1;
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;
  const nothing = !loading && !error && rows.length === 0;

  const changeSort = (next: ArenaLeaderboardSort) => {
    setOffset(0);
    if (next === sort) setDirection((value) => (value === "asc" ? "desc" : "asc"));
    else {
      setSort(next);
      setDirection(defaultDirection(next));
    }
  };

  const title = mode === "public" ? t("arena.leaderboardPublicTitle") : t("arena.leaderboardTitle");
  const intro = mode === "public" ? t("arena.leaderboardPublicIntro") : t("arena.leaderboardIntro");
  const Heading = mode === "public" ? "h1" : "h2";

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-3 px-4 py-5">
      <div>
        <Heading className="text-lg font-semibold tracking-tight">{title}</Heading>
        <p className="text-muted-foreground mt-1 text-sm">{intro}</p>
        {mode === "public" && <p className="text-muted-foreground mt-1 text-xs text-pretty">{t("arena.leaderboardPublicNotice")}</p>}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {mode === "session" && (
          <fieldset className="flex items-center gap-1.5">
            <legend className="sr-only">{t("arena.leaderboardScope")}</legend>
            <span aria-hidden className="text-muted-foreground text-xs">{t("arena.leaderboardScope")}</span>
            <SegmentedControl
              value={scope}
              onValueChange={(value) => {
                if (value === "mine" || value === "global") onScopeChange?.(value);
              }}
              label={t("arena.leaderboardScope")}
              items={[
                { value: "mine", label: t("arena.leaderboardMine") },
                { value: "global", label: t("arena.leaderboardGlobal") },
              ]}
            />
          </fieldset>
        )}
        <fieldset className="flex items-center gap-1.5">
          <legend className="sr-only">{t("arena.leaderboardWindow")}</legend>
          <span aria-hidden className="text-muted-foreground text-xs">{t("arena.leaderboardWindow")}</span>
          <SegmentedControl
            value={window}
            onValueChange={(value) => {
              if (value === "all" || value === "30d") onWindowChange(value);
            }}
            label={t("arena.leaderboardWindow")}
            items={[
              { value: "all", label: t("arena.leaderboardAllTime") },
              { value: "30d", label: t("arena.leaderboard30d") },
            ]}
          />
        </fieldset>
        <form
          className="ms-auto flex min-w-48 flex-1 items-center gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            setOffset(0);
            setQ(search.trim());
          }}
        >
          <div className="relative min-w-40 flex-1">
            <SearchIcon aria-hidden className="text-muted-foreground pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("arena.leaderboardSearchPlaceholder")}
              aria-label={t("arena.leaderboardSearchPlaceholder")}
              maxLength={120}
              className="ps-8"
            />
          </div>
          <Button type="submit" size="sm" variant="outline" className="pointer-coarse:min-h-11">{t("arena.leaderboardSearch")}</Button>
        </form>
        <Select
          aria-label={t("arena.leaderboardProvisional")}
          value={provisional}
          onValueChange={(value) => {
            setOffset(0);
            setProvisional(value);
          }}
          className="w-40"
          options={[
            { value: "include", label: t("arena.leaderboardProvisionalInclude") },
            { value: "exclude", label: t("arena.leaderboardProvisionalExclude") },
          ]}
        />
      </div>

      <p className="text-muted-foreground text-[11px] text-pretty">{t("arena.leaderboardHelp")}</p>

      {page && (
        <p className="text-muted-foreground flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs tabular-nums">
          <span>{t("arena.leaderboardAsOf", { date: formatDateTime(page.asOf) })}</span>
          <span>{t("arena.leaderboardRatingVersion")}</span>
          <span>{t("arena.leaderboardTotal", { count: formatNumber(page.total) })}</span>
        </p>
      )}

      {stale && error && (
        <p role="status" className="border-border bg-muted/40 flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-xs">
          <span className="min-w-0 flex-1">{t("arena.leaderboardStale")}</span>
          <Button type="button" size="sm" variant="outline" className="pointer-coarse:min-h-11" onClick={() => setRefresh((value) => value + 1)}>
            <RefreshCwIcon /> {t("arena.leaderboardRetry")}
          </Button>
        </p>
      )}

      {error && !stale && (
        <div role="alert" className="flex flex-col items-start gap-2 py-8 text-sm">
          <p>{t(error)}</p>
          <Button type="button" size="sm" variant="outline" onClick={() => setRefresh((value) => value + 1)}>
            {t("arena.leaderboardRetry")}
          </Button>
        </div>
      )}

      {loading && rows.length === 0 && !error && (
        <p role="status" className="text-muted-foreground flex items-center gap-2 py-8 text-sm">
          <Loader2Icon className="animate-spin motion-reduce:animate-none" /> {t("arena.loading")}
        </p>
      )}

      {rows.length > 0 && (
        <div className={cn("border-border bg-card min-h-0 overflow-hidden rounded-xl border shadow-[var(--depth-highlight)]", loading && "opacity-70")}>
          <LeaderboardTable rows={rows} sort={sort} direction={direction} onSort={changeSort} />
        </div>
      )}

      {nothing && (
        <div className="flex flex-col items-start gap-2 py-10">
          <p className="text-sm">
            {mode === "public" ? t("arena.leaderboardEmptyPublic") : scope === "mine" ? t("arena.leaderboardEmptyMine") : t("arena.leaderboardEmpty")}
          </p>
          {mode === "session" && onStartBattle && (
            <Button type="button" size="sm" className="pointer-coarse:min-h-11" onClick={onStartBattle}>
              {t("arena.leaderboardStart")}
            </Button>
          )}
          {mode === "public" && signInHref && (
            <Link href={signInHref} className="text-primary text-sm underline underline-offset-4">
              {t("arena.leaderboardSignIn")}
            </Link>
          )}
        </div>
      )}

      {page && page.total > PAGE_SIZE && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button type="button" size="sm" variant="outline" className="pointer-coarse:min-h-11" disabled={offset === 0} onClick={() => setOffset((value) => Math.max(0, value - PAGE_SIZE))}>
            <ChevronLeftIcon /> {t("arena.leaderboardPrev")}
          </Button>
          <span className="text-muted-foreground text-xs tabular-nums">{t("arena.leaderboardPage", { page: formatNumber(currentPage), pages: formatNumber(pages) })}</span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="pointer-coarse:min-h-11"
            disabled={offset + PAGE_SIZE >= page.total || offset + PAGE_SIZE > MAX_OFFSET}
            onClick={() => setOffset((value) => value + PAGE_SIZE)}
          >
            {t("arena.leaderboardNext")} <ChevronRightIcon />
          </Button>
        </div>
      )}
    </div>
  );
}
