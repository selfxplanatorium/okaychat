import { api } from "@/lib/api";
import type { UserSettings } from "@shared/types";
import { LOCALE_STORAGE_KEY, setLocale } from "./index";

/**
 * The account's language wins on every device, but the page is already rendering by the time settings
 * arrive, so a mismatch mirrors the account value into this device and reloads exactly once. This is the
 * only i18n module that talks to the API: `i18n/index.ts` must not import `@/lib/api`, because
 * `lib/api.ts` imports `t` from it.
 */

/** Stores the account's language, mirrors it to this device, then reloads. Throws on a failed save. */
export async function saveLocalePreference(tag: string | null): Promise<void> {
  // The PATCH comes first: writing local storage before the server accepted it would silently change this
  // device's language while the account still says something else.
  await api<UserSettings>("/settings", { method: "PATCH", json: { locale: tag } });
  setLocale(tag);
}

/** True when this device's stored choice differs from the account's saved language. */
export function localeDiffers(account: string | null, stored: string | null): boolean {
  // Both sides are canonical tags or null, so a plain compare is exact.
  return account !== stored;
}

const readStored = (): string | null => {
  try {
    return localStorage.getItem(LOCALE_STORAGE_KEY);
  } catch {
    return null;
  }
};

const SYNC_KEY = "okaychat:locale-sync";

/**
 * Mirrors the account language into local storage and reloads once. Returns whether it reloaded.
 * Guarded per session so an unavailable or blocked storage cannot cause a reload loop: the marker is
 * written before reloading, and the next load sees it and stops.
 */
export function applyAccountLocale(userId: string, account: string | null): boolean {
  if (!localeDiffers(account, readStored())) {
    // This device already matches the account again; drop the reload guard so a later account change can
    // mirror here instead of being mistaken for the reload we already did.
    try {
      sessionStorage.removeItem(SYNC_KEY);
    } catch {
      // Without session storage there is no guard to clear.
    }
    return false;
  }
  const marker = `${userId}:${account ?? "browser"}`;
  try {
    if (sessionStorage.getItem(SYNC_KEY) === marker) return false;
    sessionStorage.setItem(SYNC_KEY, marker);
  } catch {
    // Without session storage the marker cannot survive the reload, so reloading would loop. Stay put.
    return false;
  }
  setLocale(account);
  return true;
}
