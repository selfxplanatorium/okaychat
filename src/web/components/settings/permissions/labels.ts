import type { FeatureKey, LimitKey } from "@shared/permissions";
import type { PlainMessageKey } from "@/i18n";
import type { PermissionsView, PolicyFilter, PolicyTab } from "@/state/permissions-query";

// Literal key tables. Keeping every key here (rather than composing `permissions.feature.${key}`) lets the
// i18n test find unused entries and lets typecheck prove every registry entry has text.

export const VIEW_LABELS: Record<PermissionsView, PlainMessageKey> = {
  people: "permissions.navPeople",
  groups: "permissions.navGroups",
  models: "permissions.navModels",
  features: "permissions.navFeatures",
  prompts: "permissions.navPrompts",
  inspect: "permissions.navInspect",
  audit: "permissions.navAudit",
};

export const TAB_LABELS: Record<PolicyTab, PlainMessageKey> = {
  access: "permissions.tabsAccess",
  features: "permissions.tabsFeatures",
  limits: "permissions.tabsLimits",
  prompts: "permissions.tabsPrompts",
};

export const FILTER_LABELS: Record<PolicyFilter, PlainMessageKey> = {
  all: "permissions.filterAll",
  overridden: "permissions.filterOverridden",
  inherited: "permissions.filterInherited",
  denied: "permissions.filterDenied",
  missing: "permissions.filterMissing",
};

export const FEATURE_LABEL: Record<FeatureKey, PlainMessageKey> = {
  webSearch: "permissions.featureWebSearchLabel",
  webFetch: "permissions.featureWebFetchLabel",
  research: "permissions.featureResearchLabel",
  code: "permissions.featureCodeLabel",
  images: "permissions.featureImagesLabel",
  mcp: "permissions.featureMcpLabel",
  knowledge: "permissions.featureKnowledgeLabel",
  memory: "permissions.featureMemoryLabel",
  schedules: "permissions.featureSchedulesLabel",
  sharing: "permissions.featureSharingLabel",
  temporaryChats: "permissions.featureTemporaryChatsLabel",
  voice: "permissions.featureVoiceLabel",
  email: "permissions.featureEmailLabel",
  artifacts: "permissions.featureArtifactsLabel",
  generativeUI: "permissions.featureGenerativeUILabel",
  delegation: "permissions.featureDelegationLabel",
  skills: "permissions.featureSkillsLabel",
  evaluations: "permissions.featureEvaluationsLabel",
  channels: "permissions.featureChannels",
  customTools: "permissions.featureCustomTools",
  notes: "permissions.featureNotesLabel",
  calendar: "permissions.featureCalendarLabel",
  apiAccess: "permissions.featureApiAccess",
  translation: "permissions.featureTranslation",
};

export const FEATURE_HELP: Record<FeatureKey, PlainMessageKey> = {
  webSearch: "permissions.featureWebSearchHelp",
  webFetch: "permissions.featureWebFetchHelp",
  research: "permissions.featureResearchHelp",
  code: "permissions.featureCodeHelp",
  images: "permissions.featureImagesHelp",
  mcp: "permissions.featureMcpHelp",
  knowledge: "permissions.featureKnowledgeHelp",
  memory: "permissions.featureMemoryHelp",
  schedules: "permissions.featureSchedulesHelp",
  sharing: "permissions.featureSharingHelp",
  temporaryChats: "permissions.featureTemporaryChatsHelp",
  voice: "permissions.featureVoiceHelp",
  email: "permissions.featureEmailHelp",
  artifacts: "permissions.featureArtifactsHelp",
  generativeUI: "permissions.featureGenerativeUIHelp",
  delegation: "permissions.featureDelegationHelp",
  skills: "permissions.featureSkillsHelp",
  evaluations: "permissions.featureEvaluationsHelp",
  channels: "permissions.featureChannelsHelp",
  customTools: "permissions.featureCustomToolsHelp",
  notes: "permissions.featureNotesHelp",
  calendar: "permissions.featureCalendarHelp",
  apiAccess: "permissions.featureApiAccessHelp",
  translation: "permissions.featureTranslationHelp",
};

export const LIMIT_LABEL: Record<LimitKey, PlainMessageKey> = {
  maxSteps: "permissions.limitMaxStepsLabel",
  maxSearches: "permissions.limitMaxSearchesLabel",
  contextTokens: "permissions.limitContextTokensLabel",
  outputTokens: "permissions.limitOutputTokensLabel",
  operationsPerMinute: "permissions.limitOperationsPerMinuteLabel",
  concurrentOperations: "permissions.limitConcurrentOperationsLabel",
  concurrentTurns: "permissions.limitConcurrentTurnsLabel",
};

export const LIMIT_HELP: Record<LimitKey, PlainMessageKey> = {
  maxSteps: "permissions.limitMaxStepsHelp",
  maxSearches: "permissions.limitMaxSearchesHelp",
  contextTokens: "permissions.limitContextTokensHelp",
  outputTokens: "permissions.limitOutputTokensHelp",
  operationsPerMinute: "permissions.limitOperationsPerMinuteHelp",
  concurrentOperations: "permissions.limitConcurrentOperationsHelp",
  concurrentTurns: "permissions.limitConcurrentTurnsHelp",
};

export const LIMIT_UNIT: Record<LimitKey, PlainMessageKey> = {
  maxSteps: "permissions.unitSteps",
  maxSearches: "permissions.unitSearches",
  contextTokens: "permissions.unitTokens",
  outputTokens: "permissions.unitTokens",
  operationsPerMinute: "permissions.unitOperationsPerMinute",
  concurrentOperations: "permissions.unitOperations",
  concurrentTurns: "permissions.unitTurns",
};

export const REASON_LABEL: Record<string, PlainMessageKey> = {
  default: "permissions.sourceDefault",
  everyone: "permissions.sourceEveryone",
  groupAllow: "permissions.reasonGroupAllow",
  groupDeny: "permissions.reasonGroupDeny",
  groupMinimum: "permissions.reasonGroupMinimum",
  userOverride: "permissions.reasonUserOverride",
  modelOverride: "permissions.reasonModelOverride",
  resourceDenied: "permissions.reasonResourceDenied",
  preferenceOff: "permissions.reasonPreferenceOff",
  modelUnsupported: "permissions.reasonModelUnsupported",
  unconfigured: "permissions.reasonUnconfigured",
  missingModel: "permissions.reasonMissingModel",
  policyInvalid: "permissions.reasonPolicyInvalid",
};
