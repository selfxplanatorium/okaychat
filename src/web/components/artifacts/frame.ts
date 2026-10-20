import type { ArtifactKind } from "@shared/types";

export { FRAME_NETWORK_HOSTS, FRAME_SANDBOX, frameDocument } from "@shared/artifact-frame";

const CODE_EXT: Record<string, string> = {
  python: "py", javascript: "js", typescript: "ts", tsx: "tsx", jsx: "jsx", rust: "rs", go: "go", java: "java", kotlin: "kt",
  ruby: "rb", php: "php", csharp: "cs", "c#": "cs", cpp: "cpp", "c++": "cpp", c: "c", swift: "swift", bash: "sh", shell: "sh",
  sh: "sh", sql: "sql", json: "json", yaml: "yaml", toml: "toml", css: "css", html: "html", lua: "lua", r: "r", dart: "dart",
};

const KIND_EXT: Record<ArtifactKind, string> = { html: "html", react: "tsx", svg: "svg", markdown: "md", code: "txt", pdf: "pdf", docx: "docx", xlsx: "xlsx" };

export function artifactFilename(title: string, kind: ArtifactKind, language: string | null): string {
  const base = title.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").toLowerCase() || "artifact";
  const ext = kind === "code" ? (CODE_EXT[language?.toLowerCase() ?? ""] ?? "txt") : KIND_EXT[kind];
  return `${base}.${ext}`;
}
