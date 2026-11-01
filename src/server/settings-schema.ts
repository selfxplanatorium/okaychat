import { z } from "zod";
import { speechSettingsSchema } from "./speech/config.js";

const modelRef = z.string().min(1).max(300);

/**
 * The accepted shape of `PATCH /settings`. Unknown keys are dropped, so a field that is not listed here
 * never reaches `updateSettings`; keep this beside its test when adding a persisted preference.
 */
export const settingsPatch = z.object({
  // Checked against the known values in updateSettings.
  sidebarItems: z.array(z.string()).max(50).optional(),
  keyboard: z.object({
    bindings: z.record(z.string().regex(/^[a-z][a-zA-Z0-9.]{0,63}$/), z.array(z.string().min(1).max(48).regex(/^[\x21-\x7e]+$/)).max(4))
      .refine((value) => Object.keys(value).length <= 200, "too many commands").optional(),
    sendWith: z.enum(["enter", "modEnter"]).optional(),
    singleKeys: z.boolean().optional(),
  }).strict().optional(),
  maxSteps: z.number().optional(),
  maxSearches: z.number().optional(),
  imageServices: z.record(z.string(), z.unknown()).optional(),
  speech: speechSettingsSchema.optional(),
  defaultModel: modelRef.nullable().optional(),
  utilityModel: modelRef.nullable().optional(),
  subagentModel: modelRef.nullable().optional(),
  favoriteModels: z.array(modelRef).max(500).optional(),
  defaultReasoningEffort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
  reasoningEffort: z.record(modelRef, z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]))
    .refine((value) => Object.keys(value).length <= 500, "too many models").optional(),
  systemPrompt: z.string().max(50_000).optional(),
  autoCompactAt: z.number().min(0).max(1).optional(),
  trimBeforeCompact: z.boolean().optional(),
  onboardingSkipped: z.boolean().optional(),
  webTools: z.boolean().optional(),
  artifacts: z.boolean().optional(),
  generativeUI: z.boolean().optional(),
  subagents: z.boolean().optional(),
  codeExecution: z.boolean().optional(),
  editAssistantMessages: z.boolean().optional(),
});
