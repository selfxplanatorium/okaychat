import { api } from "@/lib/api";
import { clearThreadCache } from "@/runtime/threadCache";

/** Every logout goes through here, so the message cache never outlives the session it belongs to. */
export async function signOut() {
  await api("/auth/logout", { method: "POST" });
  await clearThreadCache();
  window.location.href = "/";
}
