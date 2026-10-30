import type { JSONSchema7, JSONSchema7Definition } from "@ai-sdk/provider";
import type { LanguageModelMiddleware } from "ai";

/**
 * OpenAI cannot enforce property-name constraints. Its SDK strips explicit string schemas, but throws
 * on equally valid implicit string schemas (enum, anyOf, $ref). Strip them before provider conversion;
 * original tool schemas and validators stay unchanged (Zod validation, MCP server, or browser tool).
 * Walk schema positions only: a user property named `propertyNames`, or literal defaults, must survive.
 */
export function openaiToolSchema(schema: JSONSchema7): JSONSchema7 {
  const { propertyNames: _, ...out } = schema;
  const definition = (value: JSONSchema7Definition): JSONSchema7Definition => typeof value === "boolean" ? value : openaiToolSchema(value);
  for (const key of ["properties", "patternProperties", "definitions", "$defs"] as const) {
    const values = out[key];
    if (values && typeof values === "object") {
      out[key] = Object.fromEntries(Object.entries(values).map(([name, value]) => [name, definition(value)]));
    }
  }
  for (const key of ["additionalProperties", "additionalItems", "contains", "not", "if", "then", "else"] as const) {
    const value = out[key];
    if (value !== undefined) out[key] = definition(value);
  }
  for (const key of ["allOf", "anyOf", "oneOf"] as const) {
    const value = out[key];
    if (value !== undefined) out[key] = value.map(definition);
  }
  if (out.items !== undefined) out.items = Array.isArray(out.items) ? out.items.map(definition) : definition(out.items);
  if (out.dependencies) {
    out.dependencies = Object.fromEntries(Object.entries(out.dependencies).map(([key, value]) => [key, Array.isArray(value) ? value : definition(value)]));
  }
  return out;
}

export const openaiToolSchemas: LanguageModelMiddleware = {
  transformParams: async ({ params }) => ({
    ...params,
    tools: params.tools?.map((tool) => tool.type === "function" ? { ...tool, inputSchema: openaiToolSchema(tool.inputSchema) } : tool),
  }),
};
