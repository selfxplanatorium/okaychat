import type { KeyboardSettings } from "@shared/types";
import { t, type PlainMessageKey } from "@/i18n";
import { normalizeCombo } from "./keys";

/**
 * Every keyboard command. Defaults use Alt+Shift+letter for actions that must work while typing, because
 * Ctrl/⌘+Shift+letter is almost entirely taken by browsers (see `browserConflict`), plus single keys
 * for message navigation, which only fire outside text fields. Ctrl+Alt is avoided: it is AltGr on Windows.
 */
export type CommandGroup = "General" | "Navigation" | "Chat" | "Composer" | "Messages" | "Notes" | "Calendar" | "Settings";

export interface CommandDef {
  id: string;
  /** Shown through `t()` at render time; this module evaluates before the locale loads. */
  labelKey: PlainMessageKey;
  group: CommandGroup;
  keys: string[];
  /**
   * `global`: fires anywhere, also while a dialog is open (only for commands that open or close one).
   * `message`: fires only while a message has focus. Everything else fires outside dialogs.
   */
  scope?: "global" | "message";
  /** Shown in the command list. Hidden commands still have shortcuts (message navigation repeats itself). */
  palette?: boolean;
}

const SETTINGS_SECTIONS = ["general", "account", "memory", "email", "providers", "apiAccess", "mcp", "agents", "projects", "schedules", "usage", "appearance", "keyboard", "admin"] as const;

const SETTINGS_LABELS = {
  general: "keyboard.settingsGeneral", account: "keyboard.settingsAccount", memory: "keyboard.settingsMemory", email: "keyboard.settingsEmail", providers: "keyboard.settingsProviders",
  apiAccess: "keyboard.settingsApiAccess",
  mcp: "keyboard.settingsMcp", agents: "settings.sectionAgents", projects: "keyboard.settingsProjects", schedules: "keyboard.settingsSchedules", usage: "keyboard.settingsUsage",
  appearance: "keyboard.settingsAppearance", keyboard: "keyboard.settingsKeyboard", admin: "keyboard.settingsAdmin",
} as const satisfies Record<(typeof SETTINGS_SECTIONS)[number], PlainMessageKey>;

export const COMMANDS: readonly CommandDef[] = [
  { id: "app.commands", labelKey: "keyboard.cmdAppCommands", group: "General", keys: ["Mod+/", "?"], scope: "global" },
  { id: "app.search", labelKey: "keyboard.cmdAppSearch", group: "General", keys: ["Mod+K"], scope: "global" },
  { id: "app.toggleSidebar", labelKey: "keyboard.cmdAppToggleSidebar", group: "General", keys: ["Alt+Shift+S"] },
  { id: "app.colorScheme", labelKey: "keyboard.cmdAppColorScheme", group: "General", keys: [] },
  { id: "app.logout", labelKey: "keyboard.cmdAppLogout", group: "General", keys: [] },
  { id: "app.reload", labelKey: "keyboard.cmdAppReload", group: "General", keys: [] },
  { id: "error.copyDetails", labelKey: "keyboard.cmdErrorCopyDetails", group: "General", keys: [] },
  { id: "services.checkAgain", labelKey: "keyboard.cmdServicesCheck", group: "General", keys: [] },
  { id: "services.dismissNotice", labelKey: "keyboard.cmdServicesDismiss", group: "General", keys: [] },
  { id: "notifications.open", labelKey: "keyboard.cmdNotificationsOpen", group: "General", keys: [] },
  { id: "notifications.markAllRead", labelKey: "keyboard.cmdNotificationsMarkAll", group: "General", keys: [] },

  { id: "nav.newChat", labelKey: "keyboard.cmdNavNewChat", group: "Navigation", keys: ["Alt+Shift+N"] },
  { id: "nav.temporaryChat", labelKey: "keyboard.cmdNavTemporaryChat", group: "Navigation", keys: ["Alt+Shift+G"] },
  { id: "nav.previousChat", labelKey: "keyboard.cmdNavPreviousChat", group: "Navigation", keys: ["Alt+Shift+ArrowUp"] },
  { id: "nav.nextChat", labelKey: "keyboard.cmdNavNextChat", group: "Navigation", keys: ["Alt+Shift+ArrowDown"] },
  { id: "nav.chatList", labelKey: "keyboard.cmdNavChatList", group: "Navigation", keys: ["Alt+Shift+H"] },
  { id: "nav.library", labelKey: "keyboard.cmdNavLibrary", group: "Navigation", keys: ["Alt+Shift+L"] },
  { id: "nav.knowledge", labelKey: "keyboard.cmdNavKnowledge", group: "Navigation", keys: ["Alt+Shift+K"] },
  { id: "nav.projects", labelKey: "keyboard.cmdNavProjects", group: "Navigation", keys: ["Alt+Shift+P"] },
  { id: "nav.scheduled", labelKey: "keyboard.cmdNavScheduled", group: "Navigation", keys: [] },
  { id: "nav.plugins", labelKey: "keyboard.cmdNavPlugins", group: "Navigation", keys: [] },
  { id: "nav.customTools", labelKey: "keyboard.cmdNavCustomTools", group: "Navigation", keys: [] },
  { id: "customTools.createPython", labelKey: "keyboard.cmdCustomToolsCreatePython", group: "Navigation", keys: [] },
  { id: "customTools.createHttp", labelKey: "keyboard.cmdCustomToolsCreateHttp", group: "Navigation", keys: [] },
  { id: "customTools.save", labelKey: "keyboard.cmdCustomToolsSave", group: "Chat", keys: [] },
  { id: "customTools.test", labelKey: "keyboard.cmdCustomToolsTest", group: "Chat", keys: [] },
  { id: "customTools.cancelTest", labelKey: "keyboard.cmdCustomToolsCancelTest", group: "Chat", keys: [] },
  { id: "customTools.delete", labelKey: "keyboard.cmdCustomToolsDelete", group: "Chat", keys: [] },
  { id: "nav.settings", labelKey: "keyboard.cmdNavSettings", group: "Navigation", keys: ["Alt+Shift+O"] },
  { id: "app.openAgents", labelKey: "keyboard.cmdAppOpenAgents", group: "Navigation", keys: [] },
  { id: "nav.projectFilter", labelKey: "keyboard.cmdNavProjectFilter", group: "Navigation", keys: [] },
  { id: "nav.createProject", labelKey: "keyboard.cmdNavCreateProject", group: "Navigation", keys: [] },
  { id: "nav.createSchedule", labelKey: "keyboard.cmdNavCreateSchedule", group: "Navigation", keys: [] },
  { id: "nav.channels", labelKey: "keyboard.cmdNavChannels", group: "Navigation", keys: [] },
  { id: "channels.create", labelKey: "keyboard.cmdChannelsCreate", group: "Navigation", keys: [] },
  { id: "channels.search", labelKey: "keyboard.cmdChannelsSearch", group: "Navigation", keys: [] },
  { id: "channels.members", labelKey: "keyboard.cmdChannelsMembers", group: "Navigation", keys: [] },
  { id: "channels.settings", labelKey: "keyboard.cmdChannelsSettings", group: "Navigation", keys: [] },
  { id: "channels.markRead", labelKey: "keyboard.cmdChannelsMarkRead", group: "Navigation", keys: [] },
  { id: "channels.nextUnread", labelKey: "keyboard.cmdChannelsNextUnread", group: "Navigation", keys: [] },
  { id: "channels.focusComposer", labelKey: "keyboard.cmdChannelsFocusComposer", group: "Navigation", keys: [] },
  { id: "channels.reply", labelKey: "keyboard.cmdChannelsReply", group: "Messages", keys: [] },
  { id: "channels.react", labelKey: "keyboard.cmdChannelsReact", group: "Messages", keys: [] },
  { id: "channels.askAi", labelKey: "keyboard.cmdChannelsAskAi", group: "Messages", keys: [] },
  { id: "channels.stopAi", labelKey: "keyboard.cmdChannelsStopAi", group: "Messages", keys: [] },
  { id: "nav.compare", labelKey: "keyboard.cmdNavCompare", group: "Navigation", keys: [] },
  { id: "nav.evaluations", labelKey: "keyboard.cmdNavEvaluations", group: "Navigation", keys: [] },
  { id: "nav.notes", labelKey: "keyboard.cmdNavNotes", group: "Navigation", keys: [] },
  { id: "nav.calendar", labelKey: "keyboard.cmdNavCalendar", group: "Navigation", keys: [] },
  { id: "evaluations.stopRun", labelKey: "keyboard.cmdEvaluationsStop", group: "Chat", keys: [] },
  { id: "evaluations.refreshRun", labelKey: "keyboard.cmdEvaluationsRefresh", group: "Chat", keys: [] },
  { id: "tags.filter", labelKey: "keyboard.cmdTagsFilter", group: "Navigation", keys: [] },

  { id: "chat.focusComposer", labelKey: "keyboard.cmdChatFocusComposer", group: "Chat", keys: ["Alt+Shift+I"] },
  { id: "chat.focusMessages", labelKey: "keyboard.cmdChatFocusMessages", group: "Chat", keys: ["Alt+Shift+J"] },
  { id: "chat.stop", labelKey: "keyboard.cmdChatStop", group: "Chat", keys: ["Alt+Shift+X"] },
  { id: "chat.retryLast", labelKey: "keyboard.cmdChatRetryLast", group: "Chat", keys: ["Alt+Shift+R"] },
  { id: "chat.editLast", labelKey: "keyboard.cmdChatEditLast", group: "Chat", keys: ["Alt+Shift+E"] },
  { id: "chat.copyLast", labelKey: "keyboard.cmdChatCopyLast", group: "Chat", keys: ["Alt+Shift+C"] },
  { id: "chat.readLast", labelKey: "keyboard.cmdChatReadLast", group: "Chat", keys: ["Alt+Shift+V"] },
  { id: "chat.copyLastCode", labelKey: "keyboard.cmdChatCopyLastCode", group: "Chat", keys: ["Alt+Shift+B"] },
  { id: "chat.artifact", labelKey: "keyboard.cmdChatArtifact", group: "Chat", keys: ["Alt+Shift+A"] },
  { id: "chat.options", labelKey: "keyboard.cmdChatOptions", group: "Chat", keys: [] },
  { id: "chat.bookmarks", labelKey: "keyboard.cmdChatBookmarks", group: "Chat", keys: [] },
  { id: "chat.share", labelKey: "keyboard.cmdChatShare", group: "Chat", keys: [] },
  { id: "share.manage", labelKey: "keyboard.cmdShareManage", group: "Chat", keys: [] },
  { id: "chat.tags", labelKey: "keyboard.cmdChatTags", group: "Chat", keys: [] },
  { id: "chat.menu", labelKey: "keyboard.cmdChatMenu", group: "Chat", keys: [] },
  { id: "chat.rename", labelKey: "keyboard.cmdChatRename", group: "Chat", keys: ["F2"] },
  { id: "chat.pin", labelKey: "keyboard.cmdChatPin", group: "Chat", keys: [] },
  { id: "chat.archive", labelKey: "keyboard.cmdChatArchive", group: "Chat", keys: [] },
  { id: "chat.delete", labelKey: "keyboard.cmdChatDelete", group: "Chat", keys: ["Alt+Shift+Backspace"] },
  { id: "chat.scrollBottom", labelKey: "keyboard.cmdChatScrollBottom", group: "Chat", keys: [] },
  { id: "chat.openContext", labelKey: "keyboard.cmdChatOpenContext", group: "Chat", keys: [] },
  { id: "chat.compactNow", labelKey: "keyboard.cmdChatCompactNow", group: "Chat", keys: [] },
  { id: "chat.trimContext", labelKey: "keyboard.cmdChatTrimContext", group: "Chat", keys: [] },
  { id: "chat.loadImage", labelKey: "keyboard.cmdChatLoadImage", group: "Chat", keys: [] },
  { id: "chat.retryImage", labelKey: "keyboard.cmdChatRetryImage", group: "Chat", keys: [] },
  { id: "chat.continue", labelKey: "keyboard.cmdChatContinue", group: "Chat", keys: [] },
  { id: "chat.exportArchive", labelKey: "keyboard.cmdChatExportArchive", group: "Chat", keys: [] },
  { id: "chat.voiceCall", labelKey: "keyboard.cmdChatVoiceCall", group: "Chat", keys: [] },
  { id: "chat.resetAgentSession", labelKey: "keyboard.cmdChatResetAgentSession", group: "Chat", keys: [] },
  { id: "message.saveNote", labelKey: "keyboard.cmdMessageSaveNote", group: "Messages", keys: [] },
  { id: "artifact.saveNote", labelKey: "keyboard.cmdArtifactSaveNote", group: "Messages", keys: [] },

  { id: "notes.create", labelKey: "keyboard.cmdNotesCreate", group: "Notes", keys: [] },
  { id: "notes.search", labelKey: "keyboard.cmdNotesSearch", group: "Notes", keys: [] },
  { id: "notes.preview", labelKey: "keyboard.cmdNotesPreview", group: "Notes", keys: [] },
  { id: "notes.favorite", labelKey: "keyboard.cmdNotesFavorite", group: "Notes", keys: [] },
  { id: "notes.pin", labelKey: "keyboard.cmdNotesPin", group: "Notes", keys: [] },
  { id: "notes.tags", labelKey: "keyboard.cmdNotesTags", group: "Notes", keys: [] },
  { id: "notes.project", labelKey: "keyboard.cmdNotesProject", group: "Notes", keys: [] },
  { id: "notes.toChat", labelKey: "keyboard.cmdNotesToChat", group: "Notes", keys: [] },
  { id: "notes.delete", labelKey: "keyboard.cmdNotesDelete", group: "Notes", keys: [] },
  { id: "notes.retrySave", labelKey: "keyboard.cmdNotesRetrySave", group: "Notes", keys: [] },
  { id: "notes.copyLocal", labelKey: "keyboard.cmdNotesCopyLocal", group: "Notes", keys: [] },

  { id: "calendar.create", labelKey: "keyboard.cmdCalendarCreate", group: "Calendar", keys: [] },
  { id: "calendar.search", labelKey: "keyboard.cmdCalendarSearch", group: "Calendar", keys: [] },
  { id: "calendar.today", labelKey: "keyboard.cmdCalendarToday", group: "Calendar", keys: [] },
  { id: "calendar.previous", labelKey: "keyboard.cmdCalendarPrevious", group: "Calendar", keys: [] },
  { id: "calendar.next", labelKey: "keyboard.cmdCalendarNext", group: "Calendar", keys: [] },
  { id: "calendar.agenda", labelKey: "keyboard.cmdCalendarAgenda", group: "Calendar", keys: [] },
  { id: "calendar.month", labelKey: "keyboard.cmdCalendarMonth", group: "Calendar", keys: [] },
  { id: "calendar.week", labelKey: "keyboard.cmdCalendarWeek", group: "Calendar", keys: [] },
  { id: "calendar.zone", labelKey: "keyboard.cmdCalendarZone", group: "Calendar", keys: [] },
  { id: "calendar.save", labelKey: "keyboard.cmdCalendarSave", group: "Calendar", keys: [] },
  { id: "calendar.delete", labelKey: "keyboard.cmdCalendarDelete", group: "Calendar", keys: [] },
  { id: "calendar.copyLocal", labelKey: "keyboard.cmdCalendarCopyLocal", group: "Calendar", keys: [] },

  { id: "composer.model", labelKey: "keyboard.cmdComposerModel", group: "Composer", keys: ["Alt+Shift+M"] },
  { id: "composer.assistant", labelKey: "keyboard.cmdComposerAssistant", group: "Composer", keys: [] },
  { id: "composer.manageAssistants", labelKey: "keyboard.cmdComposerManageAssistants", group: "Composer", keys: [] },
  { id: "composer.effort", labelKey: "keyboard.cmdComposerEffort", group: "Composer", keys: ["Alt+Shift+T"] },
  { id: "composer.search", labelKey: "keyboard.cmdComposerSearch", group: "Composer", keys: ["Alt+Shift+W"] },
  { id: "composer.research", labelKey: "keyboard.cmdComposerResearch", group: "Composer", keys: ["Alt+Shift+D"] },
  { id: "composer.searchLimit", labelKey: "composer.searchSteps", group: "Composer", keys: [] },
  { id: "composer.knowledge", labelKey: "keyboard.cmdComposerKnowledge", group: "Composer", keys: ["Alt+Shift+Y"] },
  { id: "composer.attach", labelKey: "keyboard.cmdComposerAttach", group: "Composer", keys: ["Alt+Shift+U"] },
  { id: "composer.prompts", labelKey: "keyboard.cmdComposerPrompts", group: "Composer", keys: [] },
  { id: "composer.managePrompts", labelKey: "keyboard.cmdComposerManagePrompts", group: "Composer", keys: [] },
  { id: "composer.dictate", labelKey: "keyboard.cmdComposerDictate", group: "Composer", keys: [] },

  { id: "message.next", labelKey: "keyboard.cmdMessageNext", group: "Messages", keys: ["J", "ArrowDown"], scope: "message", palette: false },
  { id: "message.previous", labelKey: "keyboard.cmdMessagePrevious", group: "Messages", keys: ["K", "ArrowUp"], scope: "message", palette: false },
  { id: "message.first", labelKey: "keyboard.cmdMessageFirst", group: "Messages", keys: ["Home"], scope: "message", palette: false },
  { id: "message.last", labelKey: "keyboard.cmdMessageLast", group: "Messages", keys: ["End"], scope: "message", palette: false },
  { id: "message.copy", labelKey: "keyboard.cmdMessageCopy", group: "Messages", keys: ["C"], scope: "message", palette: false },
  { id: "message.readAloud", labelKey: "keyboard.cmdMessageReadAloud", group: "Messages", keys: ["S"], scope: "message", palette: false },
  { id: "message.edit", labelKey: "keyboard.cmdMessageEdit", group: "Messages", keys: ["E"], scope: "message", palette: false },
  { id: "message.editReply", labelKey: "keyboard.cmdMessageEditReply", group: "Messages", keys: ["Y"], scope: "message", palette: false },
  { id: "message.undoEdit", labelKey: "keyboard.cmdMessageUndoEdit", group: "Messages", keys: ["Alt+Shift+Z"], scope: "message" },
  { id: "message.retry", labelKey: "keyboard.cmdMessageRetry", group: "Messages", keys: ["R"], scope: "message", palette: false },
  { id: "message.retryWithModel", labelKey: "keyboard.cmdMessageRetryWithModel", group: "Messages", keys: ["W"], scope: "message", palette: false },
  { id: "message.branch", labelKey: "keyboard.cmdMessageBranch", group: "Messages", keys: ["B"], scope: "message", palette: false },
  { id: "message.more", labelKey: "keyboard.cmdMessageMore", group: "Messages", keys: ["M"], scope: "message", palette: false },
  { id: "message.bookmark", labelKey: "keyboard.cmdMessageBookmark", group: "Messages", keys: [], scope: "message", palette: false },
  { id: "message.translate", labelKey: "keyboard.cmdMessageTranslate", group: "Messages", keys: ["Alt+Shift+F"], scope: "message", palette: false },
  { id: "message.translateChoose", labelKey: "keyboard.cmdMessageTranslateChoose", group: "Messages", keys: [], scope: "message", palette: false },
  { id: "message.feedback", labelKey: "keyboard.cmdMessageFeedback", group: "Messages", keys: [], scope: "message", palette: false },
  { id: "message.details", labelKey: "keyboard.cmdMessageDetails", group: "Messages", keys: [], scope: "message", palette: false },
  { id: "message.continue", labelKey: "keyboard.cmdMessageContinue", group: "Messages", keys: [], scope: "message", palette: false },
  { id: "message.exit", labelKey: "keyboard.cmdMessageExit", group: "Messages", keys: ["Escape"], scope: "message", palette: false },

  { id: "settings.compaction", labelKey: "ux.compactionSettings", group: "Settings", keys: [] },
  { id: "appearance.resetGlass", labelKey: "keyboard.cmdAppearanceResetGlass", group: "Settings", keys: [] },
  { id: "settings.webTools", labelKey: "ux.openWebToolSettings", group: "Settings", keys: [] },
  { id: "settings.webSearchLimit", labelKey: "ux.openSearchLimitSettings", group: "Settings", keys: [] },
  ...SETTINGS_SECTIONS.map((id): CommandDef => ({ id: `settings.${id}`, labelKey: SETTINGS_LABELS[id], group: "Settings", keys: [] })),

  { id: "knowledge.newCollection", labelKey: "keyboard.cmdKnowledgeNewCollection", group: "General", keys: [] },
  { id: "knowledge.retryLoad", labelKey: "keyboard.cmdKnowledgeRetryLoad", group: "General", keys: [] },
  { id: "knowledge.editCollection", labelKey: "keyboard.cmdKnowledgeEditCollection", group: "General", keys: [] },
  { id: "knowledge.addSource", labelKey: "keyboard.cmdKnowledgeAddSource", group: "General", keys: [] },
  { id: "knowledge.pasteSource", labelKey: "keyboard.cmdKnowledgePasteSource", group: "General", keys: [] },
  { id: "knowledge.addUrl", labelKey: "keyboard.cmdKnowledgeAddUrl", group: "General", keys: [] },
  { id: "knowledge.previewChunks", labelKey: "keyboard.cmdKnowledgePreviewChunks", group: "General", keys: [] },
  { id: "knowledge.search", labelKey: "keyboard.cmdKnowledgeSearch", group: "General", keys: [] },
  { id: "knowledge.reindex", labelKey: "keyboard.cmdKnowledgeReindex", group: "General", keys: [] },
  { id: "settings.ollamaTest", labelKey: "keyboard.cmdSettingsOllamaTest", group: "Settings", keys: [] },
  { id: "apiAccess.create", labelKey: "keyboard.cmdApiAccessCreate", group: "Settings", keys: [] },
  { id: "apiAccess.copy", labelKey: "keyboard.cmdApiAccessCopy", group: "Settings", keys: [] },
  { id: "apiAccess.copyExample", labelKey: "keyboard.cmdApiAccessCopyExample", group: "Settings", keys: [] },
  { id: "apiAccess.revoke", labelKey: "keyboard.cmdApiAccessRevoke", group: "Settings", keys: [] },  { id: "settings.ollamaSave", labelKey: "keyboard.cmdSettingsOllamaSave", group: "Settings", keys: [] },
  { id: "settings.ollamaRefresh", labelKey: "keyboard.cmdSettingsOllamaRefresh", group: "Settings", keys: [] },
  { id: "settings.ollamaPull", labelKey: "keyboard.cmdSettingsOllamaPull", group: "Settings", keys: [] },
  { id: "settings.ollamaCancelPull", labelKey: "keyboard.cmdSettingsOllamaCancelPull", group: "Settings", keys: [] },
  { id: "settings.ollamaDelete", labelKey: "keyboard.cmdSettingsOllamaDelete", group: "Settings", keys: [] },
  { id: "settings.providerModels", labelKey: "keyboard.cmdSettingsProviderModels", group: "Settings", keys: [] },
  { id: "settings.chatgptConnect", labelKey: "keyboard.cmdSettingsChatgptConnect", group: "Settings", keys: [] },
  { id: "settings.chatgptDownloadHelper", labelKey: "keyboard.cmdSettingsChatgptDownloadHelper", group: "Settings", keys: [] },
  { id: "settings.chatgptDownloadLaunch", labelKey: "keyboard.cmdSettingsChatgptDownloadLaunch", group: "Settings", keys: [] },
  { id: "settings.chatgptCopyChecksum", labelKey: "keyboard.cmdSettingsChatgptCopyChecksum", group: "Settings", keys: [] },
  { id: "settings.chatgptCancel", labelKey: "keyboard.cmdSettingsChatgptCancel", group: "Settings", keys: [] },
  { id: "settings.chatgptStartAgain", labelKey: "keyboard.cmdSettingsChatgptStartAgain", group: "Settings", keys: [] },
  { id: "settings.chatgptRetry", labelKey: "keyboard.cmdSettingsChatgptRetry", group: "Settings", keys: [] },
  { id: "settings.chatgptReconnect", labelKey: "keyboard.cmdSettingsChatgptReconnect", group: "Settings", keys: [] },
  { id: "settings.chatgptDisconnectChat", labelKey: "keyboard.cmdSettingsChatgptDisconnectChat", group: "Settings", keys: [] },
  { id: "settings.chatgptEnablePlan", labelKey: "keyboard.cmdSettingsChatgptEnablePlan", group: "Settings", keys: [] },
  { id: "settings.chatgptForget", labelKey: "keyboard.cmdSettingsChatgptForget", group: "Settings", keys: [] },
  { id: "agents.create", labelKey: "keyboard.cmdAgentsCreate", group: "Settings", keys: [] },
  { id: "agents.save", labelKey: "keyboard.cmdAgentsSave", group: "Settings", keys: [] },
  { id: "agents.test", labelKey: "keyboard.cmdAgentsTest", group: "Settings", keys: [] },
  { id: "agents.stopTest", labelKey: "keyboard.cmdAgentsStopTest", group: "Settings", keys: [] },
  { id: "settings.permissions", labelKey: "keyboard.cmdSettingsPermissions", group: "Settings", keys: [] },
  { id: "email.addAccount", labelKey: "keyboard.cmdEmailAdd", group: "Settings", keys: [] },
  { id: "email.discover", labelKey: "keyboard.cmdEmailDiscover", group: "Settings", keys: [] },
  { id: "email.test", labelKey: "keyboard.cmdEmailTest", group: "Settings", keys: [] },
  { id: "email.save", labelKey: "keyboard.cmdEmailSave", group: "Settings", keys: [] },
  { id: "email.editAccount", labelKey: "keyboard.cmdEmailEditAccount", group: "Settings", keys: [] },
  { id: "email.removeAccount", labelKey: "keyboard.cmdEmailRemoveAccount", group: "Settings", keys: [] },
  { id: "email.setDefault", labelKey: "keyboard.cmdEmailSetDefault", group: "Settings", keys: [] },
  { id: "email.confirmRemove", labelKey: "keyboard.cmdEmailConfirmRemove", group: "Settings", keys: [] },
  { id: "textDraft.copy", labelKey: "keyboard.cmdTextDraftCopy", group: "Messages", keys: [] },
  { id: "textDraft.discard", labelKey: "keyboard.cmdTextDraftDiscard", group: "Messages", keys: [] },
  { id: "email.draftSend", labelKey: "keyboard.cmdEmailDraftSend", group: "Messages", keys: [] },
  { id: "email.draftCopy", labelKey: "keyboard.cmdEmailDraftCopy", group: "Messages", keys: [] },
  { id: "email.draftDownload", labelKey: "keyboard.cmdEmailDraftDownload", group: "Messages", keys: [] },
  { id: "email.draftMailto", labelKey: "keyboard.cmdEmailDraftMailto", group: "Messages", keys: [] },
  { id: "email.draftSignature", labelKey: "keyboard.cmdEmailDraftSignature", group: "Messages", keys: [] },
  { id: "email.draftDiscard", labelKey: "keyboard.cmdEmailDraftDiscard", group: "Messages", keys: [] },
  // Voice calls: reachable by name; Space/Escape act inside the call view. They are global so they also run
  // from the command list while the call's modal is open.
  { id: "call.start", labelKey: "keyboard.cmdCallStart", group: "Chat", keys: [], scope: "global" },
  { id: "call.mute", labelKey: "keyboard.cmdCallMute", group: "Chat", keys: [], scope: "global" },
  { id: "call.end", labelKey: "keyboard.cmdCallEnd", group: "Chat", keys: [], scope: "global" },
  { id: "call.retry", labelKey: "keyboard.cmdCallRetry", group: "Chat", keys: [], scope: "global" },
  { id: "call.refresh", labelKey: "keyboard.cmdCallRefresh", group: "Chat", keys: [], scope: "global" },
];

export const COMMAND_GROUPS: readonly CommandGroup[] = ["General", "Navigation", "Chat", "Composer", "Messages", "Notes", "Calendar", "Settings"];

const GROUP_LABELS = {
  General: "keyboard.groupGeneral", Navigation: "keyboard.groupNavigation", Chat: "keyboard.groupChat",
  Composer: "keyboard.groupComposer", Messages: "keyboard.groupMessages", Notes: "keyboard.groupNotes",
  Calendar: "keyboard.groupCalendar", Settings: "keyboard.groupSettings",
} as const satisfies Record<CommandGroup, PlainMessageKey>;

export const commandLabel = (c: CommandDef) => t(c.labelKey);
export const groupLabel = (group: CommandGroup) => t(GROUP_LABELS[group]);

export const commandById = new Map(COMMANDS.map((c) => [c.id, c]));

/** The combos in effect for each command: the account's overrides where present, else the defaults. */
export function resolveBindings(settings: KeyboardSettings | undefined): Map<string, string[]> {
  const overrides = settings?.bindings ?? {};
  return new Map(
    COMMANDS.map((c) => [
      c.id,
      (Object.hasOwn(overrides, c.id) ? overrides[c.id]! : c.keys).map((k) => normalizeCombo(k)).filter((k): k is string => !!k),
    ]),
  );
}
