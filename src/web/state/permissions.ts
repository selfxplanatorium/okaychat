import { create } from "zustand";
import {
  resolvePolicy,
  type Change,
  type FeatureKey,
  type LimitKey,
  type PolicyDocument,
  type PolicyLayer,
  type PolicyRow,
  type PromptRule,
  type PromptRuleValue,
  type ResolvedPolicy,
  type SelfPermissions,
  type Subject,
} from "@shared/permissions";
import type { AdminPrompt, PromptKey } from "@shared/types";
import { ApiError, api } from "@/lib/api";
import { settingsHref } from "@/lib/settings-link";
import {
  baselinePolicy,
  baselinePrompt,
  collectChanges,
  emptyPolicy,
  inheritedPromptText,
  normalizePromptText,
  policyKey,
  promptKeyOf,
  type PolicyDraft,
  type PromptDraft,
  type PromptLayerRow,
} from "./permissions-draft";
import { subjectKey } from "./permissions-query";

// Admin permissions workspace state (docs/implementation/granular-permissions.md §9). One store per signed-in
// account: switching accounts resets it, reads are abortable, and policy/prompt text lives in memory only.
// Drafts are keyed by destination; only destinations that differ from their baseline become changes.

export interface PermissionUser {
  id: string;
  name: string;
  email: string;
  role: "admin" | "user";
}

export interface PermissionGroup {
  id: string;
  name: string;
  userIds: string[];
  promptOrder: number | null;
}

export interface CatalogProvider {
  id: string;
  name: string;
  connected: boolean;
  enabled: boolean;
  shared: boolean;
  modelCount: number;
}

export interface CatalogModel {
  ref: string;
  providerId: string;
  id: string;
  name: string;
  context?: number;
  maxOutput?: number;
  stored: boolean;
  present: boolean;
}

export interface CatalogStatus {
  providerId: string;
  state: "ready" | "stale" | "unavailable";
  checkedAt: number;
}

export interface PermissionsBootstrap {
  revision: number;
  registry: {
    features: Array<{ key: FeatureKey; dependencies: FeatureKey[] }>;
    limits: Array<{ key: LimitKey; min: number; max: number; bucket: boolean }>;
    defaults: Record<LimitKey, number | null>;
    hardCaps: Partial<Record<LimitKey, number>>;
  };
  subjects: { users: PermissionUser[]; groups: PermissionGroup[] };
  providers: CatalogProvider[];
  modelCatalog: CatalogModel[];
  catalogStatus: CatalogStatus[];
}

export interface PoliciesResponse {
  revision: number;
  policies: PolicyRow[];
  promptRules: PromptRule[];
  serverPrompts?: AdminPrompt[];
}

export interface ImpactCounts {
  usersAffected: number;
  modelsAffected: number;
  grantsAdded: number;
  grantsRemoved: number;
  featuresChanged: number;
  limitsTightened: number;
  limitsRelaxed: number;
  promptsChanged: number;
}

export interface PreviewResponse {
  baseRevision: number;
  draftHash: string;
  catalogFingerprint: string;
  counts: ImpactCounts;
  rows: Array<{
    userId: string;
    modelRef: string | null;
    path: string;
    before: boolean | number | string | null;
    after: boolean | number | string | null;
    beforeSources: string[];
    afterSources: string[];
  }>;
  nextCursor: string | null;
}

export interface InspectionField {
  effective: boolean | number | null;
  candidates: Array<{
    id: string;
    kind: "default" | "everyone" | "group" | "user" | "resource" | "preference" | "hardCap" | "dependency";
    subjectId?: string;
    modelRef: string | null;
    value: boolean | number | null;
    applied: boolean;
    reasonKey: string;
  }>;
  winnerSourceIds: string[];
  constrainedBy: string[];
}

export interface Inspection {
  revision: number;
  actor: { id: string; name: string; groupIds: string[] };
  model: { ref: string; catalogPresent: boolean; connection: "own" | "shared" | "none" } | null;
  access: { credentialAllowed: boolean; accountAllowed: boolean; allowed: boolean; reasons: string[] };
  permissions: Record<string, InspectionField>;
  prompts: Array<{ key: PromptKey; effectiveTemplate: string; filledText: string }>;
  assembly: {
    system1: string;
    system2: string;
    turnContextPreview: string;
    system1Hash: string;
    system2Hash: string;
    estimatedTokens: number;
    estimateMethod: "characters/4";
    dynamicSections: string[];
    warnings: string[];
  };
}

export type AuditKind = "policy" | "prompt" | "audience" | "entitlement" | "membership" | "group_order" | "subject_delete" | "migration";

export interface AuditRow {
  revision: number;
  actorId: string | null;
  occurredAt: number;
  kind: AuditKind;
  summary: Record<string, unknown>;
  reason: string | null;
}

export interface AuditDetail extends AuditRow {
  changes: Array<{ destination: string; before: unknown; after: unknown }>;
}

export interface ModelInstruction {
  modelRef: string;
  revision: number;
  mode: "inherit" | "replace" | "append";
  text: string;
  accountText: string;
  effectivePersonalText: string;
}

export type LoadStatus = "idle" | "loading" | "ready" | "error";

interface PolicyEntry {
  subject: Subject;
  modelRef: string | null;
  baseline: PolicyDocument | null;
  draft: PolicyDocument;
}

interface PromptEntry {
  subject: Subject;
  modelRef: string | null;
  key: PromptKey;
  baseline: PromptRuleValue | null;
  draft: PromptRuleValue | null;
}

interface ServerPromptEntry {
  key: PromptKey;
  baseline: string | null;
  draft: string | null;
}

interface MembershipEntry {
  baseline: string[];
  draft: string[];
}

export interface PermissionsState {
  accountId: string | null;
  generation: number;
  bootstrap: PermissionsBootstrap | null;
  bootstrapStatus: LoadStatus;
  bootstrapError: string | null;
  revision: number;
  subjects: Record<string, PoliciesResponse>;
  subjectStatus: Record<string, LoadStatus>;
  subjectError: string | null;
  activeSubject: Subject;
  policyDrafts: Record<string, PolicyEntry>;
  promptDrafts: Record<string, PromptEntry>;
  serverPromptDrafts: Record<string, ServerPromptEntry>;
  membershipDrafts: Record<string, MembershipEntry>;
  groupOrderDraft: { baseline: string[]; draft: string[] } | null;
  preview: PreviewResponse | null;
  previewStatus: LoadStatus;
  previewError: string | null;
  commitStatus: LoadStatus;
  commitError: string | null;
  conflict: string | null;
  lastSavedRevision: number | null;
  inspection: Inspection | null;
  inspectionStatus: LoadStatus;
  inspectionError: string | null;
  auditRows: AuditRow[];
  auditStatus: LoadStatus;
  auditError: string | null;
  auditNextCursor: string | null;
  auditRetentionDays: number;
  auditDetail: AuditDetail | null;
  auditDetailStatus: LoadStatus;
  self: SelfPermissions | null;
  selfStatus: LoadStatus;
  selfError: string | null;
  instruction: ModelInstruction | null;
  instructionStatus: LoadStatus | "saving";
  instructionError: string | null;

  begin: (accountId: string | null) => void;
  loadBootstrap: (force?: boolean) => Promise<void>;
  selectSubject: (subject: Subject) => Promise<void>;
  loadSubject: (subject: Subject, force?: boolean) => Promise<void>;
  editPolicy: (subject: Subject, modelRef: string | null, update: (document: PolicyDocument) => PolicyDocument) => void;
  resetPolicy: (subject: Subject, modelRef: string | null) => void;
  editPrompt: (subject: Subject, modelRef: string | null, key: PromptKey, rule: PromptRuleValue | null) => void;
  resetPrompt: (subject: Subject, modelRef: string | null, key: PromptKey) => void;
  editServerPrompt: (key: PromptKey, text: string | null) => void;
  resetServerPrompt: (key: PromptKey) => void;
  editMembership: (groupId: string, userIds: string[]) => void;
  resetMembership: (groupId: string) => void;
  moveGroup: (groupId: string, delta: number) => void;
  resetGroupOrder: () => void;
  changes: () => Change[];
  review: () => Promise<void>;
  commit: (reason: string) => Promise<boolean>;
  discardDrafts: () => void;
  reloadAfterConflict: () => Promise<void>;
  rebaseDrafts: () => Promise<void>;
  loadInspection: (input: { userId: string; modelRef?: string }) => Promise<void>;
  loadAudit: (options?: { reset?: boolean }) => Promise<void>;
  loadAuditDetail: (revision: number) => Promise<void>;
  loadSelf: (modelRef?: string | null) => Promise<void>;
  loadInstruction: (modelRef: string) => Promise<void>;
  saveInstruction: (modelRef: string, rule: PromptRuleValue | null) => Promise<boolean>;
}

const aborted = (error: unknown) => error instanceof ApiError && error.code === "aborted";
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

let bootstrapAbort: AbortController | null = null;
let subjectAbort: AbortController | null = null;

/** Subjects whose policy rows participate in a resolution for `subject` (mirrors §2.2). */
function participatingSubjects(state: Pick<PermissionsState, "bootstrap">, subject: Subject): Subject[] {
  const everyone: Subject = { kind: "everyone", id: "" };
  if (subject.kind === "everyone") return [everyone];
  if (subject.kind === "group") return [everyone, subject];
  const groups = state.bootstrap?.subjects.groups.filter((group) => group.userIds.includes(subject.id)) ?? [];
  return [everyone, ...groups.map((group): Subject => ({ kind: "group", id: group.id })), subject];
}

function layersFor(state: Pick<PermissionsState, "bootstrap" | "subjects">, subject: Subject): PolicyLayer[] {
  const layers: PolicyLayer[] = [];
  for (const participant of participatingSubjects(state, subject)) {
    for (const row of state.subjects[subjectKey(participant)]?.policies ?? []) {
      if (row.subject.kind === participant.kind && row.subject.id === participant.id) layers.push(row);
    }
  }
  return layers;
}

/** Client-side resolver used only to show effective values and sources in the editor. */
export function effectivePolicy(state: Pick<PermissionsState, "bootstrap" | "subjects">, subject: Subject, modelRef: string | null): ResolvedPolicy {
  return resolvePolicy(layersFor(state, subject), modelRef);
}

export function policyDraftFor(state: Pick<PermissionsState, "subjects" | "policyDrafts">, subject: Subject, modelRef: string | null): PolicyDraft {
  const existing = state.policyDrafts[policyKey(subject, modelRef)];
  if (existing) return { baseline: existing.baseline, draft: existing.draft };
  const baseline = baselinePolicy(state.subjects[subjectKey(subject)]?.policies ?? [], subject, modelRef);
  return { baseline, draft: baseline ?? emptyPolicy() };
}

export function promptDraftFor(
  state: Pick<PermissionsState, "subjects" | "promptDrafts">,
  subject: Subject,
  modelRef: string | null,
  key: PromptKey,
): PromptDraft {
  const existing = state.promptDrafts[promptKeyOf(subject, modelRef, key)];
  if (existing) return { baseline: existing.baseline, draft: existing.draft };
  const baseline = baselinePrompt(state.subjects[subjectKey(subject)]?.promptRules ?? [], subject, modelRef, key);
  return { baseline, draft: baseline };
}

export function serverPromptFor(
  state: Pick<PermissionsState, "subjects" | "serverPromptDrafts">,
  key: PromptKey,
): { baseline: string | null; draft: string | null; defaultText: string; label: string; description: string; placeholders: string[] } {
  const prompt = state.subjects["everyone:"]?.serverPrompts?.find((item) => item.key === key);
  const entry = state.serverPromptDrafts[key];
  const baseline = entry ? entry.baseline : (prompt?.value ?? null);
  return {
    baseline,
    draft: entry ? entry.draft : baseline,
    defaultText: prompt?.defaultValue ?? "",
    label: prompt?.label ?? key,
    description: prompt?.description ?? "",
    placeholders: prompt?.placeholders ?? [],
  };
}

export function membershipDraftFor(state: Pick<PermissionsState, "bootstrap" | "membershipDrafts">, groupId: string): string[] {
  return state.membershipDrafts[groupId]?.draft ?? state.bootstrap?.subjects.groups.find((group) => group.id === groupId)?.userIds ?? [];
}

export function groupOrderFor(state: Pick<PermissionsState, "bootstrap" | "groupOrderDraft">): string[] {
  if (state.groupOrderDraft) return state.groupOrderDraft.draft;
  return [...(state.bootstrap?.subjects.groups ?? [])]
    .sort((a, b) => (a.promptOrder ?? Number.MAX_SAFE_INTEGER) - (b.promptOrder ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id))
    .map((group) => group.id);
}

/** Prompt layers rendered by the editor's effective preview. */
export function promptLayers(state: Pick<PermissionsState, "bootstrap" | "subjects">, modelRef: string | null, key: PromptKey): PromptLayerRow[] {
  const layers: PromptLayerRow[] = [];
  const order = new Map((state.bootstrap?.subjects.groups ?? []).map((group) => [group.id, group.promptOrder ?? 0]));
  for (const response of Object.values(state.subjects)) {
    for (const row of response.promptRules) {
      if (row.key !== key) continue;
      layers.push({ subject: row.subject, modelRef: row.modelRef, rule: row.rule, order: row.subject.kind === "group" ? (order.get(row.subject.id) ?? 0) : 0 });
    }
  }
  return layers;
}

export function effectivePromptText(state: Pick<PermissionsState, "bootstrap" | "subjects">, subject: Subject, modelRef: string | null, key: PromptKey): string {
  const prompt = state.subjects["everyone:"]?.serverPrompts?.find((item) => item.key === key);
  const groupIds = subject.kind === "user" ? (state.bootstrap?.subjects.groups.filter((group) => group.userIds.includes(subject.id)).map((group) => group.id) ?? []) : subject.kind === "group" ? [subject.id] : [];
  const order = new Map((state.bootstrap?.subjects.groups ?? []).map((group) => [group.id, group.promptOrder ?? 0]));
  return inheritedPromptText(prompt?.defaultValue ?? "", prompt?.value ?? null, promptLayers(state, modelRef, key), subject, modelRef, order, groupIds);
}

export const usePermissions = create<PermissionsState>((set, get) => ({
  accountId: null,
  generation: 0,
  bootstrap: null,
  bootstrapStatus: "idle",
  bootstrapError: null,
  revision: 0,
  subjects: {},
  subjectStatus: {},
  subjectError: null,
  activeSubject: { kind: "everyone", id: "" },
  policyDrafts: {},
  promptDrafts: {},
  serverPromptDrafts: {},
  membershipDrafts: {},
  groupOrderDraft: null,
  preview: null,
  previewStatus: "idle",
  previewError: null,
  commitStatus: "idle",
  commitError: null,
  conflict: null,
  lastSavedRevision: null,
  inspection: null,
  inspectionStatus: "idle",
  inspectionError: null,
  auditRows: [],
  auditStatus: "idle",
  auditError: null,
  auditNextCursor: null,
  auditRetentionDays: 365,
  auditDetail: null,
  auditDetailStatus: "idle",
  self: null,
  selfStatus: "idle",
  selfError: null,
  instruction: null,
  instructionStatus: "idle",
  instructionError: null,

  begin: (accountId) => {
    if (get().accountId === accountId) return;
    bootstrapAbort?.abort();
    subjectAbort?.abort();
    set({
      accountId,
      generation: get().generation + 1,
      bootstrap: null,
      bootstrapStatus: "idle",
      bootstrapError: null,
      revision: 0,
      subjects: {},
      subjectStatus: {},
      subjectError: null,
      policyDrafts: {},
      promptDrafts: {},
      serverPromptDrafts: {},
      membershipDrafts: {},
      groupOrderDraft: null,
      preview: null,
      previewStatus: "idle",
      previewError: null,
      commitStatus: "idle",
      commitError: null,
      conflict: null,
      lastSavedRevision: null,
      inspection: null,
      inspectionStatus: "idle",
      inspectionError: null,
      auditRows: [],
      auditStatus: "idle",
      auditError: null,
      auditNextCursor: null,
      auditDetail: null,
      auditDetailStatus: "idle",
      self: null,
      selfStatus: "idle",
      selfError: null,
      instruction: null,
      instructionStatus: "idle",
      instructionError: null,
    });
  },

  loadBootstrap: async (force = false) => {
    const state = get();
    if (!state.accountId) return;
    if (!force && state.bootstrap && state.bootstrapStatus === "ready") return;
    const generation = state.generation;
    bootstrapAbort?.abort();
    const controller = new AbortController();
    bootstrapAbort = controller;
    set({ bootstrapStatus: "loading", bootstrapError: null });
    try {
      const next = await api<PermissionsBootstrap>("/admin/permissions/bootstrap", { signal: controller.signal });
      if (get().generation !== generation) return;
      set((current) => ({
        bootstrap: next,
        bootstrapStatus: "ready",
        revision: Math.max(current.revision, next.revision),
      }));
    } catch (error) {
      if (get().generation !== generation || aborted(error)) return;
      set({ bootstrapStatus: "error", bootstrapError: errorText(error) });
    }
  },

  selectSubject: async (subject) => {
    const state = get();
    const changed = subjectKey(state.activeSubject) !== subjectKey(subject);
    if (changed) {
      set({ policyDrafts: {}, promptDrafts: {}, preview: null, previewError: null, conflict: null, commitStatus: "idle", commitError: null });
    }
    set({ activeSubject: subject });
    await get().loadSubject(subject);
  },

  loadSubject: async (subject, force = false) => {
    const state = get();
    if (!state.accountId) return;
    const key = subjectKey(subject);
    if (!force && state.subjects[key] && state.subjectStatus[key] === "ready") return;
    const generation = state.generation;
    const needed = participatingSubjects(state, subject);
    const missing = force ? needed : needed.filter((item) => !state.subjects[subjectKey(item)]);
    if (!missing.length) return;
    subjectAbort?.abort();
    const controller = new AbortController();
    subjectAbort = controller;
    set((current) => ({
      subjectStatus: { ...current.subjectStatus, ...Object.fromEntries(missing.map((item) => [subjectKey(item), "loading" as LoadStatus])) },
      subjectError: null,
    }));
    try {
      const results = await Promise.all(
        missing.map(async (item) => {
          const query = new URLSearchParams({ subjectKind: item.kind, subjectId: item.id });
          return [subjectKey(item), await api<PoliciesResponse>(`/admin/permissions/policies?${query}`, { signal: controller.signal })] as const;
        }),
      );
      if (get().generation !== generation) return;
      set((current) => {
        const subjects = { ...current.subjects };
        const status = { ...current.subjectStatus };
        let revision = current.revision;
        for (const [itemKey, response] of results) {
          subjects[itemKey] = response;
          status[itemKey] = "ready";
          revision = Math.max(revision, response.revision);
        }
        return { subjects, subjectStatus: status, revision };
      });
    } catch (error) {
      if (get().generation !== generation || aborted(error)) return;
      set((current) => ({
        subjectStatus: { ...current.subjectStatus, ...Object.fromEntries(missing.map((item) => [subjectKey(item), "error" as LoadStatus])) },
        subjectError: errorText(error),
      }));
    }
  },

  editPolicy: (subject, modelRef, update) => {
    const state = get();
    const key = policyKey(subject, modelRef);
    const current = policyDraftFor(state, subject, modelRef);
    const entry: PolicyEntry = { subject, modelRef, baseline: current.baseline, draft: update(current.draft) };
    set({ policyDrafts: { ...state.policyDrafts, [key]: entry }, preview: null, previewError: null, commitStatus: "idle", commitError: null });
  },

  resetPolicy: (subject, modelRef) => {
    const state = get();
    const key = policyKey(subject, modelRef);
    const drafts = { ...state.policyDrafts };
    delete drafts[key];
    set({ policyDrafts: drafts, preview: null, previewError: null });
  },

  editPrompt: (subject, modelRef, key, rule) => {
    const state = get();
    const entryKey = promptKeyOf(subject, modelRef, key);
    const current = promptDraftFor(state, subject, modelRef, key);
    const entry: PromptEntry = { subject, modelRef, key, baseline: current.baseline, draft: rule ? { mode: rule.mode, text: normalizePromptText(rule.text) } : null };
    set({ promptDrafts: { ...state.promptDrafts, [entryKey]: entry }, preview: null, previewError: null, commitStatus: "idle", commitError: null });
  },

  resetPrompt: (subject, modelRef, key) => {
    const state = get();
    const drafts = { ...state.promptDrafts };
    delete drafts[promptKeyOf(subject, modelRef, key)];
    set({ promptDrafts: drafts, preview: null, previewError: null });
  },

  editServerPrompt: (key, text) => {
    const state = get();
    const prompt = serverPromptFor(state, key);
    const entry: ServerPromptEntry = { key, baseline: prompt.baseline, draft: text };
    set({ serverPromptDrafts: { ...state.serverPromptDrafts, [key]: entry }, preview: null, previewError: null, commitStatus: "idle", commitError: null });
  },

  resetServerPrompt: (key) => {
    const state = get();
    const drafts = { ...state.serverPromptDrafts };
    delete drafts[key];
    set({ serverPromptDrafts: drafts, preview: null, previewError: null });
  },

  editMembership: (groupId, userIds) => {
    const state = get();
    const baseline = state.bootstrap?.subjects.groups.find((group) => group.id === groupId)?.userIds ?? [];
    set({ membershipDrafts: { ...state.membershipDrafts, [groupId]: { baseline: [...baseline], draft: [...new Set(userIds)].sort() } }, preview: null, previewError: null });
  },

  resetMembership: (groupId) => {
    const drafts = { ...get().membershipDrafts };
    delete drafts[groupId];
    set({ membershipDrafts: drafts, preview: null, previewError: null });
  },

  moveGroup: (groupId, delta) => {
    const state = get();
    const order = [...groupOrderFor(state)];
    const index = order.indexOf(groupId);
    if (index < 0) return;
    const next = index + delta;
    if (next < 0 || next >= order.length) return;
    [order[index], order[next]] = [order[next]!, order[index]!];
    const baseline = state.groupOrderDraft?.baseline ?? [...order];
    set({ groupOrderDraft: { baseline, draft: order }, preview: null, previewError: null });
  },

  resetGroupOrder: () => set({ groupOrderDraft: null, preview: null, previewError: null }),

  changes: () => {
    const state = get();
    const changes = collectChanges(
    Object.values(state.policyDrafts).map((entry) => ({ subject: entry.subject, modelRef: entry.modelRef, draft: { baseline: entry.baseline, draft: entry.draft } })),
    Object.values(state.promptDrafts).map((entry) => ({ subject: entry.subject, modelRef: entry.modelRef, key: entry.key, draft: { baseline: entry.baseline, draft: entry.draft } })),
  );
    for (const entry of Object.values(state.serverPromptDrafts)) {
      if (normalizePromptText(entry.draft ?? "") === normalizePromptText(entry.baseline ?? "") && (entry.draft === null) === (entry.baseline === null)) continue;
      changes.push({ kind: "serverPrompt", key: entry.key, value: entry.draft });
    }
    for (const [groupId, entry] of Object.entries(state.membershipDrafts)) {
      if (entry.baseline.join("\u0000") === entry.draft.join("\u0000")) continue;
      changes.push({ kind: "membership", groupId, userIds: entry.draft });
    }
    if (state.groupOrderDraft && state.groupOrderDraft.baseline.join("\u0000") !== state.groupOrderDraft.draft.join("\u0000")) {
      changes.push({ kind: "groupOrder", groupIds: state.groupOrderDraft.draft });
    }
    return changes;
  },

  review: async () => {
    const state = get();
    const changes = state.changes();
    if (!changes.length) {
      set({ preview: null, previewError: null, previewStatus: "idle" });
      return;
    }
    set({ previewStatus: "loading", previewError: null, commitError: null });
    try {
      const preview = await api<PreviewResponse>("/admin/permissions/preview", {
        method: "POST",
        json: { baseRevision: state.revision, changes },
      });
      set({ preview, previewStatus: "ready", previewError: null });
    } catch (error) {
      set({ previewStatus: "error", previewError: errorText(error) });
    }
  },

  commit: async (reason) => {
    const state = get();
    const preview = state.preview;
    if (!preview) return false;
    set({ commitStatus: "loading", commitError: null });
    try {
      await api<{ revision: number }>("/admin/permissions/commit", {
        method: "POST",
        json: {
          baseRevision: preview.baseRevision,
          draftHash: preview.draftHash,
          catalogFingerprint: preview.catalogFingerprint,
          changes: state.changes(),
          reason,
        },
      });
      set({
        policyDrafts: {},
        promptDrafts: {},
        serverPromptDrafts: {},
        membershipDrafts: {},
        groupOrderDraft: null,
        preview: null,
        previewStatus: "idle",
        commitStatus: "ready",
        commitError: null,
        conflict: null,
      });
      await get().loadBootstrap(true);
      await get().loadSubject(get().activeSubject, true);
      set((current) => ({ lastSavedRevision: current.revision }));
      if (get().auditRows.length) await get().loadAudit({ reset: true });
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        set({ commitStatus: "error", commitError: errorText(error), conflict: errorText(error) });
      } else {
        set({ commitStatus: "error", commitError: errorText(error) });
      }
      return false;
    }
  },

  discardDrafts: () =>
    set({
      policyDrafts: {},
      promptDrafts: {},
      serverPromptDrafts: {},
      membershipDrafts: {},
      groupOrderDraft: null,
      preview: null,
      previewStatus: "idle",
      previewError: null,
      commitStatus: "idle",
      commitError: null,
      conflict: null,
    }),

  reloadAfterConflict: async () => {
    get().discardDrafts();
    await get().loadBootstrap(true);
    await get().loadSubject(get().activeSubject, true);
  },

  rebaseDrafts: async () => {
    await get().loadBootstrap(true);
    await get().loadSubject(get().activeSubject, true);
    const state = get();
    const policyDrafts = Object.fromEntries(
      Object.entries(state.policyDrafts).map(([key, entry]) => [
        key,
        { ...entry, baseline: baselinePolicy(state.subjects[subjectKey(entry.subject)]?.policies ?? [], entry.subject, entry.modelRef) },
      ]),
    );
    const promptDrafts = Object.fromEntries(
      Object.entries(state.promptDrafts).map(([key, entry]) => [
        key,
        { ...entry, baseline: baselinePrompt(state.subjects[subjectKey(entry.subject)]?.promptRules ?? [], entry.subject, entry.modelRef, entry.key) },
      ]),
    );
    const serverPrompts = state.subjects["everyone:"]?.serverPrompts ?? [];
    const serverPromptDrafts = Object.fromEntries(
      Object.entries(state.serverPromptDrafts).map(([key, entry]) => [
        key,
        { ...entry, baseline: serverPrompts.find((prompt) => prompt.key === entry.key)?.value ?? null },
      ]),
    );
    const membershipDrafts = Object.fromEntries(
      Object.entries(state.membershipDrafts).map(([key, entry]) => [
        key,
        { ...entry, baseline: [...(state.bootstrap?.subjects.groups.find((group) => group.id === key)?.userIds ?? [])] },
      ]),
    );
    const groupOrderDraft = state.groupOrderDraft
      ? {
          baseline: [...(state.bootstrap?.subjects.groups ?? [])]
            .sort((a, b) => (a.promptOrder ?? Number.MAX_SAFE_INTEGER) - (b.promptOrder ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id))
            .map((group) => group.id),
          draft: state.groupOrderDraft.draft,
        }
      : null;
    set({ policyDrafts, promptDrafts, serverPromptDrafts, membershipDrafts, groupOrderDraft, conflict: null, preview: null, previewError: null, commitStatus: "idle", commitError: null });
  },

  loadInspection: async (input) => {
    const generation = get().generation;
    set({ inspectionStatus: "loading", inspectionError: null });
    try {
      const query = new URLSearchParams({ userId: input.userId });
      if (input.modelRef) query.set("modelRef", input.modelRef);
      const inspection = await api<Inspection>(`/admin/permissions/effective?${query}`);
      if (get().generation !== generation) return;
      set({ inspection, inspectionStatus: "ready" });
    } catch (error) {
      if (get().generation !== generation || aborted(error)) return;
      set({ inspectionStatus: "error", inspectionError: errorText(error) });
    }
  },

  loadAudit: async (options = {}) => {
    const state = get();
    const reset = options.reset === true;
    const cursor = reset ? null : state.auditNextCursor;
    if (!reset && !cursor && state.auditStatus === "ready") return;
    const generation = state.generation;
    set({ auditStatus: "loading", auditError: null });
    try {
      const query = new URLSearchParams();
      if (cursor) query.set("cursor", cursor);
      const response = await api<{ rows: AuditRow[]; nextCursor: string | null; retentionDays: number }>(`/admin/permissions/audit?${query}`);
      if (get().generation !== generation) return;
      set((current) => ({
        auditRows: reset ? response.rows : [...current.auditRows, ...response.rows],
        auditNextCursor: response.nextCursor,
        auditRetentionDays: response.retentionDays,
        auditStatus: "ready",
      }));
    } catch (error) {
      if (get().generation !== generation || aborted(error)) return;
      set({ auditStatus: "error", auditError: errorText(error) });
    }
  },

  loadAuditDetail: async (revision) => {
    const generation = get().generation;
    set({ auditDetailStatus: "loading", auditDetail: null });
    try {
      const detail = await api<AuditDetail>(`/admin/permissions/audit/${revision}`);
      if (get().generation !== generation) return;
      set({ auditDetail: detail, auditDetailStatus: "ready" });
    } catch (error) {
      if (get().generation !== generation) return;
      set({ auditDetailStatus: "error", auditError: errorText(error) });
    }
  },

  loadSelf: async (modelRef) => {
    const generation = get().generation;
    set({ selfStatus: "loading", selfError: null });
    try {
      const query = modelRef ? `?${new URLSearchParams({ modelRef })}` : "";
      const self = await api<SelfPermissions>(`/permissions${query}`);
      if (get().generation !== generation) return;
      set({ self, selfStatus: "ready" });
    } catch (error) {
      if (get().generation !== generation) return;
      set({ selfStatus: "error", selfError: errorText(error) });
    }
  },

  loadInstruction: async (modelRef) => {
    const generation = get().generation;
    set({ instructionStatus: "loading", instructionError: null });
    try {
      const response = await api<ModelInstruction>(`/instructions/models?${new URLSearchParams({ modelRef })}`);
      if (get().generation !== generation) return;
      set({ instruction: response, instructionStatus: "ready" });
    } catch (error) {
      if (get().generation !== generation) return;
      set({ instructionStatus: "error", instructionError: errorText(error) });
    }
  },

  saveInstruction: async (modelRef, rule) => {
    const instruction = get().instruction;
    if (!instruction || instruction.modelRef !== modelRef) return false;
    set({ instructionStatus: "saving", instructionError: null });
    try {
      const response = await api<ModelInstruction>("/instructions/models", {
        method: "PUT",
        json: { modelRef, baseRevision: instruction.revision, rule },
      });
      set({ instruction: response, instructionStatus: "ready" });
      return true;
    } catch (error) {
      set({ instructionStatus: "error", instructionError: errorText(error) });
      return false;
    }
  },
}));

/** Deep link to a workspace section; components never hand-write settings URLs. */
export const permissionsLink = (query: Parameters<typeof settingsHref>[1]): string => settingsHref("permissions", query);
