import type { KeyboardSettings } from "@shared/types";
import { normalizeCombo } from "./keys";

/**
 * Every keyboard command. Defaults use Alt+Shift+letter for actions that must work while typing, because
 * Ctrl/⌘+Shift+letter is almost entirely taken by browsers (see `browserConflict`), plus single keys
 * for message navigation, which only fire outside text fields. Ctrl+Alt is avoided: it is AltGr on Windows.
 */
export type CommandGroup = "General" | "Navigation" | "Chat" | "Composer" | "Messages" | "Settings";

export interface CommandDef {
  id: string;
  label: string;
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

const SETTINGS_SECTIONS = [
  ["general", "General"], ["account", "Account"], ["memory", "Memory"], ["providers", "Providers"], ["mcp", "MCP servers"],
  ["projects", "Projects"], ["schedules", "Scheduled"], ["usage", "Usage"], ["appearance", "Appearance"],
  ["keyboard", "Keyboard"], ["admin", "Admin"],
] as const;

export const COMMANDS: readonly CommandDef[] = [
  { id: "app.commands", label: "Show commands and shortcuts", group: "General", keys: ["Mod+/", "?"], scope: "global" },
  { id: "app.search", label: "Search chats", group: "General", keys: ["Mod+K"], scope: "global" },
  { id: "app.toggleSidebar", label: "Show or hide the sidebar", group: "General", keys: ["Alt+Shift+S"] },
  { id: "app.colorScheme", label: "Switch color scheme (light, system, dark)", group: "General", keys: [] },
  { id: "app.logout", label: "Log out", group: "General", keys: [] },

  { id: "nav.newChat", label: "New chat", group: "Navigation", keys: ["Alt+Shift+N"] },
  { id: "nav.temporaryChat", label: "Start or end a temporary chat", group: "Navigation", keys: ["Alt+Shift+G"] },
  { id: "nav.previousChat", label: "Previous chat in the sidebar", group: "Navigation", keys: ["Alt+Shift+ArrowUp"] },
  { id: "nav.nextChat", label: "Next chat in the sidebar", group: "Navigation", keys: ["Alt+Shift+ArrowDown"] },
  { id: "nav.chatList", label: "Focus the chat list", group: "Navigation", keys: ["Alt+Shift+H"] },
  { id: "nav.library", label: "Open Library", group: "Navigation", keys: ["Alt+Shift+L"] },
  { id: "nav.projects", label: "Open Projects", group: "Navigation", keys: ["Alt+Shift+P"] },
  { id: "nav.scheduled", label: "Open Scheduled", group: "Navigation", keys: [] },
  { id: "nav.plugins", label: "Open Plugins", group: "Navigation", keys: [] },
  { id: "nav.settings", label: "Open settings", group: "Navigation", keys: ["Alt+Shift+O"] },
  { id: "nav.projectFilter", label: "Filter chats by project", group: "Navigation", keys: [] },

  { id: "chat.focusComposer", label: "Focus the message box", group: "Chat", keys: ["Alt+Shift+I"] },
  { id: "chat.focusMessages", label: "Jump to the last message", group: "Chat", keys: ["Alt+Shift+J"] },
  { id: "chat.stop", label: "Stop generating", group: "Chat", keys: ["Alt+Shift+X"] },
  { id: "chat.retryLast", label: "Retry the last answer", group: "Chat", keys: ["Alt+Shift+R"] },
  { id: "chat.editLast", label: "Edit your last message", group: "Chat", keys: ["Alt+Shift+E"] },
  { id: "chat.copyLast", label: "Copy the last answer", group: "Chat", keys: ["Alt+Shift+C"] },
  { id: "chat.copyLastCode", label: "Copy the last code block", group: "Chat", keys: ["Alt+Shift+B"] },
  { id: "chat.artifact", label: "Open or close the artifact panel", group: "Chat", keys: ["Alt+Shift+A"] },
  { id: "chat.options", label: "Chat options", group: "Chat", keys: [] },
  { id: "chat.share", label: "Share chat", group: "Chat", keys: [] },
  { id: "chat.menu", label: "Chat menu (pin, move, export, …)", group: "Chat", keys: [] },
  { id: "chat.rename", label: "Rename chat", group: "Chat", keys: ["F2"] },
  { id: "chat.pin", label: "Pin or unpin chat", group: "Chat", keys: [] },
  { id: "chat.archive", label: "Archive chat", group: "Chat", keys: [] },
  { id: "chat.delete", label: "Delete chat", group: "Chat", keys: ["Alt+Shift+Backspace"] },
  { id: "chat.scrollBottom", label: "Scroll to the bottom", group: "Chat", keys: [] },

  { id: "composer.model", label: "Choose model", group: "Composer", keys: ["Alt+Shift+M"] },
  { id: "composer.effort", label: "Reasoning effort", group: "Composer", keys: ["Alt+Shift+T"] },
  { id: "composer.search", label: "Turn web search on or off", group: "Composer", keys: ["Alt+Shift+W"] },
  { id: "composer.attach", label: "Attach files", group: "Composer", keys: ["Alt+Shift+U"] },
  { id: "composer.prompts", label: "Insert an MCP prompt", group: "Composer", keys: [] },
  { id: "composer.dictate", label: "Start or stop voice input", group: "Composer", keys: [] },

  { id: "message.next", label: "Next message", group: "Messages", keys: ["J", "ArrowDown"], scope: "message", palette: false },
  { id: "message.previous", label: "Previous message", group: "Messages", keys: ["K", "ArrowUp"], scope: "message", palette: false },
  { id: "message.first", label: "First loaded message", group: "Messages", keys: ["Home"], scope: "message", palette: false },
  { id: "message.last", label: "Last message", group: "Messages", keys: ["End"], scope: "message", palette: false },
  { id: "message.copy", label: "Copy message", group: "Messages", keys: ["C"], scope: "message", palette: false },
  { id: "message.edit", label: "Edit message", group: "Messages", keys: ["E"], scope: "message", palette: false },
  { id: "message.retry", label: "Retry message", group: "Messages", keys: ["R"], scope: "message", palette: false },
  { id: "message.branch", label: "Branch from message", group: "Messages", keys: ["B"], scope: "message", palette: false },
  { id: "message.more", label: "More message actions", group: "Messages", keys: ["M"], scope: "message", palette: false },
  { id: "message.exit", label: "Back to the message box", group: "Messages", keys: ["Escape"], scope: "message", palette: false },

  ...SETTINGS_SECTIONS.map(([id, label]): CommandDef => ({ id: `settings.${id}`, label: `Settings: ${label}`, group: "Settings", keys: [] })),
];

export const COMMAND_GROUPS: readonly CommandGroup[] = ["General", "Navigation", "Chat", "Composer", "Messages", "Settings"];

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
