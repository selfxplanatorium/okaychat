import { CUSTOM_TOOL_ICONS, type CleanupItem, type CustomToolKind } from "@shared/custom-tools";

// Typed workspace links. Values are encoded, and `new` never coexists with a tool id.
export interface CustomToolsLink {
  toolId?: string;
  newKind?: CustomToolKind;
  panel?: "test";
}

export function customToolsHref(input: CustomToolsLink = {}): string {
  if (input.toolId && input.newKind) throw new Error("A custom tool link cannot open a new draft and a stored tool together.");
  const params = new URLSearchParams({ tab: "tools" });
  if (input.toolId) params.set("tool", input.toolId);
  else if (input.newKind) params.set("new", input.newKind);
  if (input.panel) params.set("panel", input.panel);
  return `/plugins?${params.toString()}`;
}

export function parseCustomToolsLink(search: string): { toolId: string | null; newKind: CustomToolKind | null; panel: "test" | null; invalid: boolean } {
  const params = new URLSearchParams(search);
  const toolId = params.get("tool");
  const rawNew = params.get("new");
  const panel = params.get("panel") === "test" ? "test" as const : null;
  if (toolId && rawNew) return { toolId: null, newKind: null, panel, invalid: true };
  return {
    toolId,
    newKind: rawNew === "python" || rawNew === "http" ? rawNew : null,
    panel,
    invalid: rawNew !== null && rawNew !== "python" && rawNew !== "http",
  };
}

export const ICONS = CUSTOM_TOOL_ICONS;

export type CleanupRow = CleanupItem;
