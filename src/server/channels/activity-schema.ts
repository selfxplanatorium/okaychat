import { z } from "zod";
import { AppError } from "../errors.js";
import { CHANNEL_ACTIVITY_ID, CHANNEL_ACTIVITY_LIMITS, CHANNEL_CONNECTION_ID } from "../../shared/channel-activity.js";

/**
 * Ephemeral request bodies are tiny and strict. Unknown fields are rejected instead of ignored, so a
 * future client field can never be mistaken for a scope by an older server.
 */

const identifier = z.string().regex(CHANNEL_ACTIVITY_ID);
const rootId = identifier.nullable();

export const activityRequestSchema = z
  .object({
    connectionId: z.string().regex(CHANNEL_CONNECTION_ID),
    seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    state: z.enum(["active", "idle"]),
    watch: z
      .object({
        channelId: identifier,
        rootId,
      })
      .strict()
      .nullable(),
  })
  .strict();

export const typingRequestSchema = z
  .object({
    connectionId: z.string().regex(CHANNEL_CONNECTION_ID),
    seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    channelId: identifier,
    rootId,
    typing: z.boolean(),
  })
  .strict();

/** A bounded JSON read; a declared body larger than this is refused before parsing. */
export async function readActivityBody(c: { req: { header: (name: string) => string | undefined; text: () => Promise<string> } }): Promise<unknown> {
  const declared = Number(c.req.header("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > CHANNEL_ACTIVITY_LIMITS.maxRequestBytes) throw tooLarge();
  const text = await c.req.text();
  if (Buffer.byteLength(text, "utf8") > CHANNEL_ACTIVITY_LIMITS.maxRequestBytes) throw tooLarge();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AppError({ code: "validation", status: 400, message: "That request is not valid JSON." });
  }
}

export function parseActivity<T extends z.ZodTypeAny>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const path = result.error.issues[0]?.path.join(".") ?? "body";
    throw new AppError({ code: "validation", status: 400, message: `Invalid ${path}.` });
  }
  return result.data;
}

function tooLarge(): AppError {
  return new AppError({ code: "validation", status: 413, message: "That request is too large." });
}
