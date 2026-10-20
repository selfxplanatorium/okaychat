// Types shared by server and web. Keep free of runtime imports.

/**
 * A skill follows the Anthropic Agent Skills format: a `SKILL.md` with a kebab-case `name`,
 * a `description` shown to the model, and Markdown instructions, plus optional reference files.
 */
export interface SkillFile {
  /** Relative path inside the skill folder, e.g. `references/api.md`. */
  name: string;
  chars: number;
}

export type SkillOrigin = "manual" | "conversation" | "source";

export interface Skill {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  origin: SkillOrigin;
  /** The skill source it was installed from, when it has one. */
  sourceId: string | null;
  files: SkillFile[];
  chars: number;
  createdAt: number;
  updatedAt: number;
}

/** A full skill including body and file contents. */
export interface SkillDetail extends Skill {
  body: string;
  fileContents: Array<{ name: string; content: string }>;
}

export type SkillSourceKind = "github" | "raw";

export interface SkillSource {
  id: string;
  name: string;
  kind: SkillSourceKind;
  url: string;
  branch: string | null;
  subpath: string | null;
  /** True when a personal access token is stored; the token itself never leaves the server. */
  hasToken: boolean;
  createdAt: number;
}

export interface SkillSourceInput {
  name?: string;
  url: string;
  branch?: string | null;
  subpath?: string | null;
  token?: string;
}

/** A skill discovered in a linked source, ready to install. */
export interface SkillSourceEntry {
  name: string;
  description: string;
  /** Path of the SKILL.md inside the source. */
  path: string;
}

export interface SkillSourceListing {
  source: SkillSource;
  entries: SkillSourceEntry[];
  errors: string[];
}

export interface SkillPreferences {
  enabled: boolean;
  revision: number;
}
