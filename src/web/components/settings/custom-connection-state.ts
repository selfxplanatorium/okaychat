import type { CustomAuth, CustomModelSource, ProviderConnectionInput, SecretRowInput } from "@shared/types";
import {
  apiKeyReason,
  authHeaderNameReason,
  deploymentIdOf,
  headerNameReason,
  headerValueReason,
  modelIdReason,
  normalizeCustomBaseURL,
  queryNameReason,
  queryValueReason,
  TRANSPORT_LIMITS,
  type ConnectionFieldReason,
  type CustomAuthMode,
} from "@shared/provider-transport";

// Pure state for the custom connection form: client-side checks (feedback only; the server decides),
// the PUT payload with retain/replace/remove semantics, and server field mapping. No secret ever leaves
// this state except inside the payload of an explicit save.

export interface Row {
  key: string;
  name: string;
  /** New text typed in this form only. */
  value: string;
  /** The saved name whose value an empty field keeps, or null for a new row. */
  savedName: string | null;
  removed: boolean;
  revealed: boolean;
}

export type Kind = "headers" | "query";

let rowCounter = 0;
export const newRow = (savedName: string | null = null): Row => ({ key: `r${++rowCounter}`, name: savedName ?? "", value: "", savedName, removed: false, revealed: false });

export const originOf = (url: string | undefined) => {
  try {
    return url ? new URL(url).origin : "";
  } catch {
    return url ?? "";
  }
};

export interface FormState {
  /** Editing the user's own row (or the admin's shared row); false for a new row or an own override of a shared one. */
  own: boolean;
  creating: boolean;
  name: string;
  baseURL: string;
  savedBaseURL?: string;
  apiKey: string;
  removeKey: boolean;
  hasSavedKey: boolean;
  savedAuth: CustomAuth;
  authMode: CustomAuthMode;
  headerName: string;
  headers: Row[];
  query: Row[];
  savedHeaderCount: number;
  savedQueryCount: number;
  sourceMode: CustomModelSource["mode"];
  ids: string;
  savedSource: CustomModelSource;
}

export const idListOf = (ids: string) => ids.split(/[\s,]+/).filter(Boolean);

export function authOf(state: Pick<FormState, "authMode" | "headerName">): CustomAuth {
  return state.authMode === "api-key" ? { mode: "api-key", headerName: state.headerName.toLowerCase() } : { mode: state.authMode };
}

const sameAuth = (a: CustomAuth, b: CustomAuth) => a.mode === b.mode && (a.mode !== "api-key" || a.headerName === (b as { headerName: string }).headerName);

export const authChanged = (state: FormState) => !sameAuth(state.savedAuth, authOf(state));
export const originChanged = (state: FormState) => state.own && originOf(state.baseURL.trim()) !== originOf(state.savedBaseURL);

/** True when a row's empty value keeps the saved value: same normalized name as the saved row. */
export function rowKeeps(kind: Kind, row: Row): boolean {
  if (row.savedName === null) return false;
  return kind === "headers" ? row.name.toLowerCase() === row.savedName.toLowerCase() : row.name === row.savedName;
}

export function advancedDirty(state: FormState): boolean {
  const idList = idListOf(state.ids);
  const savedIds = state.savedSource.mode === "manual" ? state.savedSource.ids.join("\n") : "";
  return (
    authChanged(state) ||
    state.sourceMode !== state.savedSource.mode ||
    (state.sourceMode === "manual" && idList.join("\n") !== savedIds) ||
    [...state.headers, ...state.query].some((row) => row.removed || row.value !== "" || row.savedName === null || row.name !== row.savedName) ||
    state.headers.length !== state.savedHeaderCount ||
    state.query.length !== state.savedQueryCount
  );
}

/** Every problem in display order, keyed by form row index; the first one receives focus on submit. */
export function formProblems(state: FormState): Array<[string, ConnectionFieldReason]> {
  const out: Array<[string, ConnectionFieldReason]> = [];
  const moved = originChanged(state);
  const changedAuth = authChanged(state);
  if (state.creating && !state.name.trim()) out.push(["name", "required"]);
  const url = normalizeCustomBaseURL(state.baseURL.trim());
  if ((!state.own || state.baseURL.trim() !== (state.savedBaseURL ?? "")) && "reason" in url) out.push(["baseURL", url.reason]);
  const keyKept = state.hasSavedKey && !state.removeKey && state.authMode !== "headers";
  if (state.authMode === "headers" && state.apiKey) out.push(["apiKey", "key_not_allowed"]);
  else if (state.apiKey && apiKeyReason(state.apiKey)) out.push(["apiKey", apiKeyReason(state.apiKey)!]);
  else if (!state.apiKey && keyKept && (changedAuth || moved)) out.push(["apiKey", "secret_reentry_required"]);
  else if (state.authMode === "api-key" && !state.apiKey && !keyKept) out.push(["apiKey", "required"]);
  if (state.authMode === "api-key") {
    const reason = authHeaderNameReason(state.headerName);
    if (reason) out.push(["transport.auth.headerName", reason]);
  }
  const authName = state.authMode === "bearer" ? "authorization" : state.authMode === "api-key" ? state.headerName.toLowerCase() : null;
  const check = (kind: Kind, rows: Row[], nameReason: (n: string) => ConnectionFieldReason | null, valueReason: (v: string) => ConnectionFieldReason | null, max: number) => {
    const live = rows.filter((row) => !row.removed);
    if (live.length > max) out.push([`transport.${kind}`, "too_many"]);
    const seen = new Set<string>();
    for (const row of live) {
      const index = rows.indexOf(row);
      const normalized = kind === "headers" ? row.name.toLowerCase() : row.name;
      const reason = nameReason(row.name);
      if (reason) out.push([`transport.${kind}.${index}.name`, reason]);
      else if (seen.has(normalized)) out.push([`transport.${kind}.${index}.name`, "duplicate"]);
      else if (kind === "headers" && normalized === authName) out.push([`transport.${kind}.${index}.name`, "auth_header_collision"]);
      seen.add(normalized);
      if (row.value) {
        const valueError = valueReason(row.value);
        if (valueError) out.push([`transport.${kind}.${index}.value`, valueError]);
      } else if (!rowKeeps(kind, row)) out.push([`transport.${kind}.${index}.value`, "required"]);
      else if (moved) out.push([`transport.${kind}.${index}.value`, "secret_reentry_required"]);
    }
  };
  check("headers", state.headers, headerNameReason, headerValueReason, TRANSPORT_LIMITS.headerRows);
  check("query", state.query, queryNameReason, queryValueReason, TRANSPORT_LIMITS.queryRows);
  const idList = idListOf(state.ids);
  if (state.sourceMode === "manual") {
    const bad = idList.find((id) => modelIdReason(id));
    if (!idList.length) out.push(["modelSource.ids", "required"]);
    else if (idList.length > TRANSPORT_LIMITS.manualIds) out.push(["modelSource.ids", "too_many"]);
    else if (bad !== undefined) out.push(["modelSource.ids", modelIdReason(bad)!]);
    else if (new Set(idList).size !== idList.length) out.push(["modelSource.ids", "duplicate"]);
  }
  const deployment = deploymentIdOf(state.baseURL.trim());
  if (deployment !== null && (state.sourceMode !== "manual" || idList.length !== 1 || idList[0] !== deployment)) out.push(["modelSource", "deployment_mismatch"]);
  return out;
}

const rowsPayload = (rows: Row[]): SecretRowInput[] =>
  rows.filter((row) => !row.removed).map((row) => (row.value ? { name: row.name, value: row.value } : { name: row.name }));

/**
 * The PUT body. A new row (or an own override of a shared one) sends everything; an edit sends only what
 * changed, so an unchanged configuration, and a legacy row, is kept as it is. An empty value means
 * "keep the saved value of this same name"; a mask is never sent.
 */
export function formPayload(state: FormState): ProviderConnectionInput {
  const sendAdvanced = !state.own || advancedDirty(state) || originChanged(state);
  const idList = idListOf(state.ids);
  return {
    ...(state.creating ? { name: state.name } : {}),
    ...(!state.own || state.baseURL.trim() !== (state.savedBaseURL ?? "") ? { baseURL: state.baseURL.trim() } : {}),
    ...(state.apiKey ? { apiKey: state.apiKey } : state.removeKey && state.hasSavedKey && state.authMode !== "headers" ? { apiKey: "" } : {}),
    ...(sendAdvanced
      ? {
          transport: { auth: authOf(state), headers: rowsPayload(state.headers), query: rowsPayload(state.query) },
          modelSource: state.sourceMode === "manual" ? { mode: "manual", ids: idList } : { mode: "discover" },
        }
      : {}),
    enabled: true,
  };
}

/** Maps a server field path (indexes over the sent rows) to the form's row indexes, which include removed rows. */
export function formFieldOf(field: string, state: Pick<FormState, "headers" | "query">): string {
  const match = field.match(/^transport\.(headers|query)\.(\d+)(\..*)?$/);
  if (!match) return field;
  const kind = match[1] as Kind;
  const rows = state[kind];
  const live = rows.filter((row) => !row.removed);
  const row = live[Number(match[2])];
  return row ? `transport.${kind}.${rows.indexOf(row)}${match[3] ?? ""}` : `transport.${kind}`;
}

/** After a successful save, typed values are dropped and the surviving rows become saved rows. */
export const settledRows = (rows: Row[]): Row[] =>
  rows.filter((row) => !row.removed).map((row) => ({ ...row, value: "", savedName: row.name, revealed: false }));
