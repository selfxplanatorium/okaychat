import type { KeyboardSettings } from "@shared/types";
import { t, type PlainMessageKey } from "@/i18n";
import { normalizeCombo } from "./keys";

/**
 * Every keyboard command. Defaults use Alt+Shift+letter for actions that must work while typing, because
 * Ctrl/⌘+Shift+letter is almost entirely taken by browsers (see `browserConflict`), plus single keys
 * for message navigation, which only fire outside text fields. Ctrl+Alt is avoided: it is AltGr on Windows.
 */
export type CommandGroup = "General" | "Navigation" | "Chat" | "Composer" | "Messages" | "Settings";

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

const SETTINGS_SECTIONS = ["general", "account", "memory", "providers", "mcp", "projects", "schedules", "usage", "appearance", "keyboard", "admin"] as const;

const SETTINGS_LABELS = {
  general: "keyboard.settingsGeneral", account: "keyboard.settingsAccount", memory: "keyboard.settingsMemory", providers: "keyboard.settingsProviders",
  mcp: "keyboard.settingsMcp", projects: "keyboard.settingsProjects", schedules: "keyboard.settingsSchedules", usage: "keyboard.settingsUsage",
  appearance: "keyboard.settingsAppearance", keyboard: "keyboard.settingsKeyboard", admin: "keyboard.settingsAdmin",
} as const satisfies Record<(typeof SETTINGS_SECTIONS)[number], PlainMessageKey>;

export const COMMANDS: readonly CommandDef[] = [
  { id: "app.commands", labelKey: "keyboard.cmdAppCommands", group: "General", keys: ["Mod+/", "?"], scope: "global" },
  { id: "app.search", labelKey: "keyboard.cmdAppSearch", group: "General", keys: ["Mod+K"], scope: "global" },
  { id: "app.toggleSidebar", labelKey: "keyboard.cmdAppToggleSidebar", group: "General", keys: ["Alt+Shift+S"] },
  { id: "app.colorScheme", labelKey: "keyboard.cmdAppColorScheme", group: "General", keys: [] },
  { id: "app.logout", labelKey: "keyboard.cmdAppLogout", group: "General", keys: [] },

  { id: "nav.newChat", labelKey: "keyboard.cmdNavNewChat", group: "Navigation", keys: ["Alt+Shift+N"] },
  { id: "nav.temporaryChat", labelKey: "keyboard.cmdNavTemporaryChat", group: "Navigation", keys: ["Alt+Shift+G"] },
  { id: "nav.previousChat", labelKey: "keyboard.cmdNavPreviousChat", group: "Navigation", keys: ["Alt+Shift+ArrowUp"] },
  { id: "nav.nextChat", labelKey: "keyboard.cmdNavNextChat", group: "Navigation", keys: ["Alt+Shift+ArrowDown"] },
  { id: "nav.chatList", labelKey: "keyboard.cmdNavChatList", group: "Navigation", keys: ["Alt+Shift+H"] },
  { id: "nav.library", labelKey: "keyboard.cmdNavLibrary", group: "Navigation", keys: ["Alt+Shift+L"] },
  { id: "nav.projects", labelKey: "keyboard.cmdNavProjects", group: "Navigation", keys: ["Alt+Shift+P"] },
  { id: "nav.scheduled", labelKey: "keyboard.cmdNavScheduled", group: "Navigation", keys: [] },
  { id: "nav.plugins", labelKey: "keyboard.cmdNavPlugins", group: "Navigation", keys: [] },
  { id: "nav.settings", labelKey: "keyboard.cmdNavSettings", group: "Navigation", keys: ["Alt+Shift+O"] },
  { id: "nav.projectFilter", labelKey: "keyboard.cmdNavProjectFilter", group: "Navigation", keys: [] },
  { id: "nav.createProject", labelKey: "keyboard.cmdNavCreateProject", group: "Navigation", keys: [] },
  { id: "nav.createSchedule", labelKey: "keyboard.cmdNavCreateSchedule", group: "Navigation", keys: [] },

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
  { id: "chat.share", labelKey: "keyboard.cmdChatShare", group: "Chat", keys: [] },
  { id: "chat.menu", labelKey: "keyboard.cmdChatMenu", group: "Chat", keys: [] },
  { id: "chat.rename", labelKey: "keyboard.cmdChatRename", group: "Chat", keys: ["F2"] },
  { id: "chat.pin", labelKey: "keyboard.cmdChatPin", group: "Chat", keys: [] },
  { id: "chat.archive", labelKey: "keyboard.cmdChatArchive", group: "Chat", keys: [] },
  { id: "chat.delete", labelKey: "keyboard.cmdChatDelete", group: "Chat", keys: ["Alt+Shift+Backspace"] },
  { id: "chat.scrollBottom", labelKey: "keyboard.cmdChatScrollBottom", group: "Chat", keys: [] },
  { id: "chat.openContext", labelKey: "keyboard.cmdChatOpenContext", group: "Chat", keys: [] },
  { id: "chat.compactNow", labelKey: "keyboard.cmdChatCompactNow", group: "Chat", keys: [] },
  { id: "chat.trimContext", labelKey: "keyboard.cmdChatTrimContext", group: "Chat", keys: [] },

  { id: "composer.model", labelKey: "keyboard.cmdComposerModel", group: "Composer", keys: ["Alt+Shift+M"] },
  { id: "composer.effort", labelKey: "keyboard.cmdComposerEffort", group: "Composer", keys: ["Alt+Shift+T"] },
  { id: "composer.search", labelKey: "keyboard.cmdComposerSearch", group: "Composer", keys: ["Alt+Shift+W"] },
  { id: "composer.research", labelKey: "keyboard.cmdComposerResearch", group: "Composer", keys: ["Alt+Shift+D"] },
  { id: "composer.attach", labelKey: "keyboard.cmdComposerAttach", group: "Composer", keys: ["Alt+Shift+U"] },
  { id: "composer.prompts", labelKey: "keyboard.cmdComposerPrompts", group: "Composer", keys: [] },
  { id: "composer.dictate", labelKey: "keyboard.cmdComposerDictate", group: "Composer", keys: [] },

  { id: "message.next", labelKey: "keyboard.cmdMessageNext", group: "Messages", keys: ["J", "ArrowDown"], scope: "message", palette: false },
  { id: "message.previous", labelKey: "keyboard.cmdMessagePrevious", group: "Messages", keys: ["K", "ArrowUp"], scope: "message", palette: false },
  { id: "message.first", labelKey: "keyboard.cmdMessageFirst", group: "Messages", keys: ["Home"], scope: "message", palette: false },
  { id: "message.last", labelKey: "keyboard.cmdMessageLast", group: "Messages", keys: ["End"], scope: "message", palette: false },
  { id: "message.copy", labelKey: "keyboard.cmdMessageCopy", group: "Messages", keys: ["C"], scope: "message", palette: false },
  { id: "message.readAloud", labelKey: "keyboard.cmdMessageReadAloud", group: "Messages", keys: ["S"], scope: "message", palette: false },
  { id: "message.edit", labelKey: "keyboard.cmdMessageEdit", group: "Messages", keys: ["E"], scope: "message", palette: false },
  { id: "message.retry", labelKey: "keyboard.cmdMessageRetry", group: "Messages", keys: ["R"], scope: "message", palette: false },
  { id: "message.retryWithModel", labelKey: "keyboard.cmdMessageRetryWithModel", group: "Messages", keys: ["W"], scope: "message", palette: false },
  { id: "message.branch", labelKey: "keyboard.cmdMessageBranch", group: "Messages", keys: ["B"], scope: "message", palette: false },
  { id: "message.more", labelKey: "keyboard.cmdMessageMore", group: "Messages", keys: ["M"], scope: "message", palette: false },
  { id: "message.exit", labelKey: "keyboard.cmdMessageExit", group: "Messages", keys: ["Escape"], scope: "message", palette: false },

  { id: "settings.compaction", labelKey: "ux.compactionSettings", group: "Settings", keys: [] },
  { id: "settings.webTools", labelKey: "ux.openWebToolSettings", group: "Settings", keys: [] },
  { id: "settings.webSearchLimit", labelKey: "ux.openSearchLimitSettings", group: "Settings", keys: [] },
  ...SETTINGS_SECTIONS.map((id): CommandDef => ({ id: `settings.${id}`, labelKey: SETTINGS_LABELS[id], group: "Settings", keys: [] })),

  { id: "ux.dismissHints", labelKey: "keyboard.cmdUxDismissHints", group: "General", keys: [], palette: false },
  { id: "settings.ollamaTest", labelKey: "keyboard.cmdSettingsOllamaTest", group: "Settings", keys: [] },
  { id: "settings.ollamaSave", labelKey: "keyboard.cmdSettingsOllamaSave", group: "Settings", keys: [] },
  { id: "settings.ollamaRefresh", labelKey: "keyboard.cmdSettingsOllamaRefresh", group: "Settings", keys: [] },
  { id: "settings.ollamaPull", labelKey: "keyboard.cmdSettingsOllamaPull", group: "Settings", keys: [] },
  { id: "settings.ollamaCancelPull", labelKey: "keyboard.cmdSettingsOllamaCancelPull", group: "Settings", keys: [] },
  { id: "settings.ollamaDelete", labelKey: "keyboard.cmdSettingsOllamaDelete", group: "Settings", keys: [] },
];

export const COMMAND_GROUPS: readonly CommandGroup[] = ["General", "Navigation", "Chat", "Composer", "Messages", "Settings"];

const GROUP_LABELS = {
  General: "keyboard.groupGeneral", Navigation: "keyboard.groupNavigation", Chat: "keyboard.groupChat",
  Composer: "keyboard.groupComposer", Messages: "keyboard.groupMessages", Settings: "keyboard.groupSettings",
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
