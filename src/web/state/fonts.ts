import { create } from "zustand";
import type { InstalledFont } from "@shared/types";
import { api } from "@/lib/api";

interface InstalledFontsState {
  fonts: InstalledFont[];
}

export const useInstalledFonts = create<InstalledFontsState>(() => ({ fonts: [] }));

// Faces we registered with the document, by font id. Kept so a removed font can be unregistered.
const faces = new Map<string, FontFace>();

/** Fetches the account's uploaded fonts and registers them so every family name resolves in CSS. */
export async function loadInstalledFonts(): Promise<void> {
  const fonts = await api<InstalledFont[]>("/fonts");
  for (const [id, face] of faces) {
    if (fonts.some((font) => font.id === id)) continue;
    document.fonts.delete(face);
    faces.delete(id);
  }
  for (const font of fonts) {
    if (faces.has(font.id)) continue;
    const face = new FontFace(font.family, `url(/api/fonts/${font.id}/file)`);
    document.fonts.add(face);
    faces.set(font.id, face);
  }
  useInstalledFonts.setState({ fonts });
}

/** Uploads a font file. Throws with the server's message when the file is rejected. */
export async function installFont(file: File): Promise<InstalledFont> {
  const body = new FormData();
  body.set("file", file);
  const font = await api<InstalledFont>("/fonts", { method: "POST", body });
  await loadInstalledFonts();
  return font;
}

export async function removeFont(id: string): Promise<void> {
  await api(`/fonts/${id}`, { method: "DELETE" });
  await loadInstalledFonts();
}
