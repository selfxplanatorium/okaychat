import type { Subject } from "@shared/permissions";

// URL state for the admin permissions workspace. Everything here is pure so query handling can be tested
// without React or a router, and so `settingsHref` can build the same links the workspace reads.

export const PERMISSIONS_VIEWS = ["people", "groups", "models", "features", "prompts", "inspect", "audit"] as const;
export type PermissionsView = (typeof PERMISSIONS_VIEWS)[number];

export const POLICY_TABS = ["access", "features", "limits", "prompts"] as const;
export type PolicyTab = (typeof POLICY_TABS)[number];

export const POLICY_FILTERS = ["all", "overridden", "inherited", "denied", "missing"] as const;
export type PolicyFilter = (typeof POLICY_FILTERS)[number];

export interface PermissionsQuery {
  view: PermissionsView;
  subject: Subject;
  modelRef: string | null;
  tab: PolicyTab;
  q: string;
  filter: PolicyFilter;
}

export const DEFAULT_PERMISSIONS_QUERY: PermissionsQuery = {
  view: "people",
  subject: { kind: "everyone", id: "" },
  modelRef: null,
  tab: "access",
  q: "",
  filter: "all",
};

const isView = (value: string | null): value is PermissionsView => !!value && (PERMISSIONS_VIEWS as readonly string[]).includes(value);
const isTab = (value: string | null): value is PolicyTab => !!value && (POLICY_TABS as readonly string[]).includes(value);
const isFilter = (value: string | null): value is PolicyFilter => !!value && (POLICY_FILTERS as readonly string[]).includes(value);

/** Whether `?view=` names the permissions workspace (as opposed to Server settings). */
export function isPermissionsSearch(search: string): boolean {
  return isView(new URLSearchParams(search.startsWith("?") ? search : `?${search}`).get("view"));
}

export const subjectKey = (subject: Subject): string => `${subject.kind}:${subject.id}`;

/** Parses `?view=…&subjectKind=…`; unknown or incomplete values fall back instead of failing. */
export function parsePermissionsQuery(search: string): PermissionsQuery {
  const params = new URLSearchParams(search.startsWith("?") ? search : `?${search}`);
  const view = params.get("view");
  if (!isView(view)) return { ...DEFAULT_PERMISSIONS_QUERY, q: params.get("q") ?? "" };
  const kind = params.get("subjectKind");
  const id = params.get("subjectId") ?? "";
  const subject: Subject =
    kind === "group" || kind === "user" ? { kind, id } : kind === "everyone" ? { kind: "everyone", id: "" } : { kind: "everyone", id: "" };
  const modelRef = params.get("modelRef");
  const tab = params.get("tab");
  const filter = params.get("filter");
  return {
    view,
    subject: subject.id || subject.kind === "everyone" ? subject : { kind: "everyone", id: "" },
    modelRef: modelRef && modelRef.length <= 300 ? modelRef : null,
    tab: isTab(tab) ? tab : "access",
    q: (params.get("q") ?? "").slice(0, 200),
    filter: isFilter(filter) ? filter : "all",
  };
}

/** Only non-default values are written, so a clean workspace has a short URL. */
export function permissionsQueryRecord(query: PermissionsQuery): Record<string, string> {
  const out: Record<string, string> = { view: query.view };
  if (query.subject.kind !== "everyone") {
    out.subjectKind = query.subject.kind;
    out.subjectId = query.subject.id;
  }
  if (query.modelRef) out.modelRef = query.modelRef;
  if (query.tab !== "access") out.tab = query.tab;
  if (query.q.trim()) out.q = query.q.trim();
  if (query.filter !== "all") out.filter = query.filter;
  return out;
}

/** Keeps a selection valid when its subject disappears from a refreshed directory. */
export function reconcileSubject(subject: Subject, users: ReadonlyArray<{ id: string }>, groups: ReadonlyArray<{ id: string }>): Subject {
  if (subject.kind === "everyone") return subject;
  const exists = subject.kind === "user" ? users.some((user) => user.id === subject.id) : groups.some((group) => group.id === subject.id);
  return exists ? subject : { kind: "everyone", id: "" };
}

/** Arrow/Home/End movement for the workspace rail and policy tabs. */
export function stepIndex(length: number, current: number, key: string, orientation: "horizontal" | "vertical" = "vertical"): number {
  if (length <= 0) return 0;
  const back = orientation === "vertical" ? "ArrowUp" : "ArrowLeft";
  const forward = orientation === "vertical" ? "ArrowDown" : "ArrowRight";
  if (key === "Home") return 0;
  if (key === "End") return length - 1;
  if (key === back) return (current - 1 + length) % length;
  if (key === forward) return (current + 1) % length;
  return -1;
}
