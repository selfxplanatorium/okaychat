import type { ToolSet } from "ai";
import type { FeatureKey } from "../../shared/permissions.js";
import { AppError } from "../errors.js";
import { assertFeature, featureAllowed, type Actor } from "./guard.js";

const FEATURES: Readonly<Record<string, FeatureKey>> = {
  web_search: "webSearch", web_fetch: "webFetch", deep_research: "research",
  run_code: "code", generate_image: "images", delegate_task: "delegation",
  search_knowledge: "knowledge", read_knowledge_chunk: "knowledge",
  memory_search: "memory", memory_save: "memory", memory_forget: "memory",
  conversation_search: "memory", conversation_read: "memory",
  load_skill: "skills", read_skill_file: "skills", search_skill_sources: "skills", install_skill: "skills", create_skill: "skills",
  create_artifact: "artifacts", update_artifact: "artifacts", read_artifact: "artifacts",
  create_document: "artifacts", edit_document: "artifacts", read_document: "artifacts",
  import_document: "artifacts", view_artifact: "artifacts",
  email_folders: "email", email_list: "email", email_search: "email", email_read: "email", email_send: "email", email_reply: "email", draft_email: "email",
};
const LOCAL_TOOLS = new Set(["read_attachment", "draft_text"]);

/** MCP names are accepted only from the server's freshly built tool set, never client classifications. */
export function guardTools(actor: Actor, tools: ToolSet, mcpNames = new Set<string>()): ToolSet {
  const result: ToolSet = {};
  for (const [name, definition] of Object.entries(tools)) {
    const feature = mcpNames.has(name) ? "mcp" : FEATURES[name];
    if (!feature && !LOCAL_TOOLS.has(name)) throw new AppError({ code: "forbidden", message: "An unregistered tool was withheld." });
    if (feature && !featureAllowed(actor, feature)) continue;
    const execute = definition.execute;
    result[name] = execute ? {
      ...definition,
      execute: (...args: Parameters<typeof execute>) => {
        if (feature) assertFeature(actor, feature);
        return execute(...args);
      },
    } : definition;
  }
  return result;
}
