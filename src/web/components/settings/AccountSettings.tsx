import { CameraIcon, LoaderCircleIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Me } from "@shared/types";
import { AccountAvatar } from "@/components/ui/account-avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StorageMeter } from "@/components/StorageMeter";
import { t } from "@/i18n";
import { api } from "@/lib/api";
import { useData } from "@/state/data";
import { SettingsPage, SettingsRow, SettingsSection } from "./SettingsUI";

const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

/** Account storage usage against the limit, as a section under the profile details. */
function StorageSection() {
  const storage = useData((s) => s.storage);
  if (!storage) return null;
  return (
    <SettingsSection
      title={t("account.storage")}
      description={t("account.storageDescription")}
    >
      <StorageMeter storage={storage} className="px-4 py-3" />
    </SettingsSection>
  );
}

/** Password change and signing out other devices. Both keep this device signed in. */
function SecuritySection() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState<"password" | "sessions" | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");

  const run = async (action: "password" | "sessions", fn: () => Promise<string>) => {
    setBusy(action);
    setError("");
    setStatus("");
    try {
      setStatus(await fn());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("account.somethingWrong"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <SettingsSection title={t("account.security")} description={t("account.securityDescription")}>
      <form
        className="flex flex-col gap-3 px-4 py-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (busy) return;
          if (next !== confirm) return setError(t("account.passwordMismatch"));
          void run("password", async () => {
            await api("/account/password", { method: "POST", json: { current, next } });
            setCurrent("");
            setNext("");
            setConfirm("");
            return t("account.passwordChanged");
          });
        }}
      >
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          {t("account.currentPassword")}
          <Input type="password" autoComplete="current-password" value={current} required maxLength={200} disabled={busy !== null} onChange={(e) => setCurrent(e.currentTarget.value)} />
        </label>
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          {t("account.newPassword")}
          <Input type="password" autoComplete="new-password" value={next} required minLength={8} maxLength={200} disabled={busy !== null} onChange={(e) => setNext(e.currentTarget.value)} />
        </label>
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          {t("account.confirmPassword")}
          <Input type="password" autoComplete="new-password" value={confirm} required minLength={8} maxLength={200} disabled={busy !== null} onChange={(e) => setConfirm(e.currentTarget.value)} />
        </label>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={busy !== null || !current || next.length < 8 || !confirm}>
            {busy === "password" ? t("account.changing") : t("account.changePassword")}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy !== null}
            onClick={() => void run("sessions", async () => {
              const { revoked } = await api<{ revoked: number }>("/account/sessions/revoke-others", { method: "POST" });
              return revoked ? t("account.signedOutOthers", { count: revoked }) : t("account.noOtherDevices");
            })}
          >
            {busy === "sessions" ? t("account.signingOut") : t("account.signOutOthers")}
          </Button>
        </div>
        <div aria-live="polite" aria-atomic="true" className="min-h-5 text-sm">
          {error ? <p role="alert" className="text-destructive">{error}</p> : <p className="text-muted-foreground">{status}</p>}
        </div>
      </form>
    </SettingsSection>
  );
}

/** Decode before upload, reduce oversized photos, and discard embedded photo metadata. */
async function profilePhoto(file: File): Promise<Blob> {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) throw new Error(t("account.photoType"));
  if (file.size > MAX_PHOTO_BYTES) throw new Error(t("account.photoTooBig"));
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 16_777_216) throw new Error(t("account.photoMegapixels"));
    const ratio = Math.min(1, 1024 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio));
    const context = canvas.getContext("2d");
    if (!context) throw new Error(t("account.photoBrowser"));
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error(t("account.photoPrepare"))), "image/png"));
  } catch (error) {
    if (error instanceof DOMException) throw new Error(t("account.photoOpen"));
    throw error;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function AccountSettings() {
  const me = useData((s) => s.me);
  const [name, setName] = useState(me?.name ?? "");
  const [busy, setBusy] = useState<"photo" | "remove" | "name" | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const refreshStorage = useData((s) => s.refreshStorage);
  useEffect(() => {
    // Quota numbers go stale after uploads in other tabs; the account page always shows fresh ones.
    void refreshStorage();
  }, [refreshStorage]);
  if (!me) return null;

  const saveProfile = async (action: "photo" | "remove" | "name", run: () => Promise<Me>, message: string) => {
    setBusy(action);
    setError("");
    setStatus("");
    try {
      const updated = await run();
      // A pending upload must not repopulate a different account after logout.
      if (useData.getState().me?.id === updated.id) useData.setState({ me: updated });
      setStatus(message);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("account.profileFailed"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <SettingsPage title={t("settings.sectionAccount")} description={t("account.description")}>
      <SettingsSection title={t("account.profilePicture")}>
        <div className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:gap-5">
          <AccountAvatar user={me} className="size-20 [&_[data-slot=avatar-fallback]]:text-2xl" />
          <div className="flex min-w-0 flex-col items-start gap-2">
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" disabled={busy !== null} onClick={() => fileInput.current?.click()}>
                {busy === "photo" ? <LoaderCircleIcon className="animate-spin" aria-hidden /> : <CameraIcon aria-hidden />}
                {busy === "photo" ? t("account.uploading") : me.avatarUrl ? t("account.changePicture") : t("account.uploadPicture")}
              </Button>
              {me.avatarUrl && (
                <Button type="button" variant="ghost" disabled={busy !== null} onClick={() => void saveProfile("remove", () => api<Me>("/account/avatar", { method: "DELETE" }), t("account.pictureRemoved"))}>
                  {busy === "remove" ? t("account.removing") : t("account.removePicture")}
                </Button>
              )}
            </div>
            <p id="profile-picture-help" className="text-muted-foreground text-xs">{t("account.photoHelp")}</p>
            <input
              ref={fileInput}
              className="hidden"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              aria-label={t("account.uploadProfilePicture")}
              aria-describedby="profile-picture-help"
              disabled={busy !== null}
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                if (!file) return;
                void saveProfile("photo", async () => {
                  const body = new FormData();
                  body.set("file", await profilePhoto(file), "profile.png");
                  return api<Me>("/account/avatar", { method: "PUT", body });
                }, t("account.pictureUpdated"));
              }}
            />
          </div>
        </div>
      </SettingsSection>
      <SettingsSection title={t("account.personalDetails")}>
        <form onSubmit={(event) => {
          event.preventDefault();
          if (!name.trim() || busy !== null || name.trim() === me.name) return;
          void saveProfile("name", () => api<Me>("/account", { method: "PATCH", json: { name: name.trim() } }), t("account.nameSaved"));
        }}>
          <div className="flex flex-col gap-2 px-4 py-3">
            <label htmlFor="account-display-name" className="text-sm font-medium">{t("account.displayName")}</label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input id="account-display-name" autoComplete="name" value={name} maxLength={80} required disabled={busy !== null} onChange={(event) => { setName(event.currentTarget.value); setStatus(""); }} />
              <Button type="submit" className="self-start sm:self-auto" disabled={busy !== null || !name.trim() || name.trim() === me.name}>
                {busy === "name" ? t("common.saving") : t("account.saveName")}
              </Button>
            </div>
          </div>
        </form>
        <SettingsRow label={t("account.emailAddress")} control={<span className="text-muted-foreground max-w-full break-all text-sm">{me.email}</span>} />
      </SettingsSection>
      <SecuritySection />
      <StorageSection />
      <div aria-live="polite" aria-atomic="true" className="min-h-5 text-sm">
        {error ? <p role="alert" className="text-destructive">{error}</p> : <p className="text-muted-foreground">{status}</p>}
      </div>
    </SettingsPage>
  );
}
