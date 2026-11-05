import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import type { InspectionInput, Subject } from "../../shared/permissions.js";
import { validModelRef } from "../../shared/permissions.js";
import type { AppEnv } from "../auth.js";
import { requireAdmin } from "../auth.js";
import { AppError, handleAppError, toWireError } from "../errors.js";
import { promptRuleSchema, changesSchema, PolicyInputError, readStrictBody } from "./schema.js";
import { PermissionWorkspace, type CatalogSource, type WhoCanUseInput } from "./workspace.js";

// API contracts for the permissions workspace (§7) plus the ordinary-user self endpoints. The router is
// exported but not mounted here: the application decides when every feature guard is in place. Admin reads
// are no-store; bodies are strict JSON with duplicate-key rejection and bounded sizes.

const MB = 1024 * 1024;
const MAX_BODY = MB;
const MAX_BULK_BODY = 4 * MB;

const subjectSchema = z
  .strictObject({ kind: z.enum(["everyone", "group", "user"]), id: z.string().max(200) })
  .refine((subject) => (subject.kind === "everyone" ? subject.id === "" : subject.id.length > 0), "Choose a subject.");

const inspectionSchema = z
  .strictObject({
    userId: z.string().min(1).max(200),
    modelRef: z.string().max(300).optional(),
    threadId: z.string().min(1).max(200).optional(),
    temporary: z.boolean().optional(),
  })
  .refine((input) => !(input.threadId && input.temporary), "Choose a chat or a temporary chat, not both.");

const filterSchema = z.strictObject({
  userIds: z.array(z.string().min(1).max(200)).max(10_000).optional(),
  groupIds: z.array(z.string().min(1).max(200)).max(10_000).optional(),
  modelRefs: z.array(z.string().max(300)).max(1000).optional(),
});

const previewSchema = z.strictObject({
  baseRevision: z.number().int().min(0).refine(Number.isSafeInteger, "Invalid revision"),
  changes: changesSchema,
  inspect: inspectionSchema.optional(),
  filter: filterSchema.optional(),
  cursor: z.string().max(500).optional(),
  limit: z.number().int().min(1).max(200).optional(),
});

const commitSchema = z.strictObject({
  baseRevision: z.number().int().min(0).refine(Number.isSafeInteger, "Invalid revision"),
  draftHash: z.string().min(1).max(200),
  catalogFingerprint: z.string().min(1).max(200),
  changes: changesSchema,
  reason: z.string().max(1000),
});

const instructionSchema = z.strictObject({
  modelRef: z.string().min(1).max(300),
  baseRevision: z.number().int().min(0).refine(Number.isSafeInteger, "Invalid revision"),
  rule: promptRuleSchema.nullable(),
});

const resourceKindSchema = z.enum(["provider", "mcp", "model", "feature"]);
const subjectKindSchema = z.enum(["everyone", "group", "user"]);

function inputError(message: string, field?: string): never {
  throw new PolicyInputError(message, field);
}

function queryInt(value: string | undefined, field: string, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) inputError(`Invalid ${field}`, field);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) inputError(`Invalid ${field}`, field);
  return parsed;
}

function queryBoolean(value: string | undefined, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  inputError(`Invalid ${field}`, field);
}

function subjectFromQuery(kind: string | undefined, id: string | undefined): Subject {
  if (kind === undefined) inputError("Choose a subject kind.", "subjectKind");
  const parsed = subjectKindSchema.safeParse(kind);
  if (!parsed.success) inputError("Choose a subject kind.", "subjectKind");
  if (id === undefined) inputError("Choose a subject id.", "subjectId");
  const subject = subjectSchema.safeParse({ kind: parsed.data, id });
  if (!subject.success) inputError(subject.error.issues[0]?.message ?? "Choose a subject.", "subjectId");
  return subject.data;
}

async function readBody(c: Context<AppEnv>, max: number): Promise<unknown> {
  const declared = c.req.header("content-length");
  if (declared && Number(declared) > max) throw new PolicyInputError("Request body is too large", "body");
  return readStrictBody(c.req.raw, max);
}

const DETAIL_KEYS = ["field", "feature", "modelRef", "revision", "retryAfterSeconds"] as const;

/** The wire details allowlist: never a subject list, provenance, prompt text, or provider payload. */
function safeDetails(details: unknown): Record<string, unknown> | undefined {
  if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
  const out: Record<string, unknown> = {};
  for (const key of DETAIL_KEYS) {
    if (Object.hasOwn(details, key)) out[key] = (details as Record<string, unknown>)[key];
  }
  return Object.keys(out).length ? out : undefined;
}

function withErrors(handler: (c: Context<AppEnv>) => Promise<Response> | Response) {
  return async (c: Context<AppEnv>) => {
    try {
      return await handler(c);
    } catch (error) {
      if (error instanceof PolicyInputError) {
        return c.json(
          { error: error.message, code: "validation", details: { ...(error.field ? { field: error.field } : {}) } },
          400,
        );
      }
      if (error instanceof AppError) {
        const wire = toWireError(error);
        const details = safeDetails(error.details);
        return c.json({ error: wire.message, ...wire, ...(details ? { details } : {}) }, error.status as ContentfulStatusCode);
      }
      return handleAppError(error, c);
    }
  };
}

export function createPermissionRouters(options: { catalog?: CatalogSource } = {}): {
  admin: Hono<AppEnv>;
  self: Hono<AppEnv>;
} {
  const workspace = new PermissionWorkspace(options);
  const admin = new Hono<AppEnv>()
    .use("/admin/permissions/*", requireAdmin)
    .use("/admin/permissions/*", async (c, next) => {
      c.header("Cache-Control", "no-store");
      await next();
    })
    .get(
      "/admin/permissions/bootstrap",
      withErrors(async (c) => c.json(await workspace.bootstrap())),
    )
    .get(
      "/admin/permissions/policies",
      withErrors((c) => {
        const subject = subjectFromQuery(c.req.query("subjectKind"), c.req.query("subjectId"));
        return c.json(workspace.policies(subject));
      }),
    )
    .post(
      "/admin/permissions/preview",
      withErrors(async (c) => {
        const body = previewSchema.safeParse(await readBody(c, MAX_BULK_BODY));
        if (!body.success) inputError(body.error.issues[0]?.message ?? "Invalid preview request", body.error.issues[0]?.path.join("."));
        return c.json(await workspace.preview(body.data));
      }),
    )
    .post(
      "/admin/permissions/commit",
      withErrors(async (c) => {
        const body = commitSchema.safeParse(await readBody(c, MAX_BULK_BODY));
        if (!body.success) inputError(body.error.issues[0]?.message ?? "Invalid commit request", body.error.issues[0]?.path.join("."));
        return c.json(await workspace.commit(body.data, c.get("user").id));
      }),
    )
    .get(
      "/admin/permissions/effective",
      withErrors(async (c) => {
        const userId = c.req.query("userId");
        if (!userId) inputError("Choose a user.", "userId");
        if (userId.length > 200) inputError("Invalid user.", "userId");
        const modelRef = c.req.query("modelRef");
        if (modelRef !== undefined && !validModelRef(modelRef)) inputError("Use a provider-qualified model id.", "modelRef");
        const temporary = queryBoolean(c.req.query("temporary"), "temporary");
        const threadId = c.req.query("threadId");
        if (threadId !== undefined && (!threadId || threadId.length > 200)) inputError("Invalid chat.", "threadId");
        const input: InspectionInput = {
          userId: userId!,
          ...(modelRef !== undefined ? { modelRef } : {}),
          ...(threadId !== undefined ? { threadId } : {}),
          ...(temporary !== undefined ? { temporary } : {}),
        };
        return c.json(await workspace.effective(input));
      }),
    )
    .get(
      "/admin/permissions/who-can-use",
      withErrors(async (c) => {
        const kind = resourceKindSchema.safeParse(c.req.query("resourceKind"));
        if (!kind.success) inputError("Choose a resource kind.", "resourceKind");
        const resourceId = c.req.query("resourceId");
        if (resourceId === undefined) inputError("Choose a resource.", "resourceId");
        if (resourceId.length > 300) inputError("Invalid resource.", "resourceId");
        let modelRef = c.req.query("modelRef");
        if (kind.data === "model") {
          const fallback = modelRef ?? resourceId;
          if (!fallback || !validModelRef(fallback)) inputError("Choose a model.", "modelRef");
          if (modelRef !== undefined && resourceId && modelRef !== resourceId) inputError("The model id does not match.", "modelRef");
          modelRef = fallback;
        } else if (modelRef !== undefined && !validModelRef(modelRef)) {
          inputError("Use a provider-qualified model id.", "modelRef");
        }
        const q = c.req.query("q");
        if (q !== undefined && q.length > 200) inputError("Invalid search.", "q");
        const cursor = c.req.query("cursor");
        if (cursor !== undefined && cursor.length > 500) inputError("Invalid page cursor.", "cursor");
        const input: WhoCanUseInput = {
          resourceKind: kind.data,
          resourceId: kind.data === "model" ? modelRef! : resourceId!,
          ...(modelRef !== undefined ? { modelRef } : {}),
          ...(q !== undefined ? { q } : {}),
          ...(cursor !== undefined ? { cursor } : {}),
          limit: queryInt(c.req.query("limit"), "limit", 50, 1, 200),
        };
        return c.json(await workspace.whoCanUse(input));
      }),
    )
    .get(
      "/admin/permissions/audit",
      withErrors((c) => {
        const kind = c.req.query("subjectKind");
        const id = c.req.query("subjectId");
        if ((kind === undefined) !== (id === undefined)) inputError("Choose both a subject kind and id.", "subjectKind");
        if (kind !== undefined && !subjectKindSchema.safeParse(kind).success) inputError("Choose a subject kind.", "subjectKind");
        if (id !== undefined && id.length > 200) inputError("Invalid subject id.", "subjectId");
        if (kind === "everyone" && id !== "") inputError("The everyone subject has no id.", "subjectId");
        if (kind !== undefined && kind !== "everyone" && !id) inputError("Choose a subject id.", "subjectId");
        return c.json(
          workspace.auditList({
            ...(c.req.query("cursor") !== undefined ? { cursor: c.req.query("cursor") } : {}),
            limit: queryInt(c.req.query("limit"), "limit", 50, 1, 100),
            ...(kind !== undefined ? { subjectKind: kind as Subject["kind"] } : {}),
            ...(id !== undefined ? { subjectId: id } : {}),
          }),
        );
      }),
    )
    .get(
      "/admin/permissions/audit/:revision",
      withErrors((c) => c.json(workspace.auditDetail(queryInt(c.req.param("revision"), "revision", 1, 1, Number.MAX_SAFE_INTEGER)))),
    );

  const self = new Hono<AppEnv>()
    .use("/permissions", async (c, next) => {
      c.header("Cache-Control", "no-store");
      await next();
    })
    .use("/instructions/models", async (c, next) => {
      c.header("Cache-Control", "no-store");
      await next();
    })
    .get(
      "/permissions",
      withErrors((c) => {
        const modelRef = c.req.query("modelRef");
        if (modelRef !== undefined && !validModelRef(modelRef)) inputError("Use a provider-qualified model id.", "modelRef");
        return c.json(workspace.self(c.get("user").id, modelRef ?? null));
      }),
    )
    .get(
      "/instructions/models",
      withErrors(async (c) => {
        const modelRef = c.req.query("modelRef");
        if (!modelRef) inputError("Choose a model.", "modelRef");
        return c.json(await workspace.getInstruction(c.get("user").id, modelRef!));
      }),
    )
    .put(
      "/instructions/models",
      withErrors(async (c) => {
        const body = instructionSchema.safeParse(await readBody(c, MAX_BODY));
        if (!body.success) inputError(body.error.issues[0]?.message ?? "Invalid instructions", body.error.issues[0]?.path.join("."));
        return c.json(await workspace.putInstruction(c.get("user").id, body.data));
      }),
    );

  return { admin, self };
}

const routers = createPermissionRouters();

/** Mounted at `/api` by the application, which also owns the feature guards. */
export const permissionAdminRoutes = routers.admin;
export const permissionSelfRoutes = routers.self;
export const permissionRoutes = new Hono<AppEnv>().route("/", routers.admin).route("/", routers.self);
