import type { Subject } from "@shared/permissions";
import { Select } from "@/components/ui/select";
import { t } from "@/i18n";
import { usePermissions } from "@/state/permissions";
import { subjectKey } from "@/state/permissions-query";

// Shared subject selector: everyone, a group, or a user. The value is the stable `kind:id` key, so duplicate
// display names (two people called Sam) never collide.

export function SubjectPicker({ subject, onChange, className }: { subject: Subject; onChange: (subject: Subject) => void; className?: string }) {
  const users = usePermissions((state) => state.bootstrap?.subjects.users ?? []);
  const groups = usePermissions((state) => state.bootstrap?.subjects.groups ?? []);
  const options = [
    { value: "everyone:", label: t("permissions.scopeEveryone") },
    ...groups.map((group) => ({ value: `group:${group.id}`, label: `${t("permissions.scopeGroup")} · ${group.name}` })),
    ...users.map((user) => ({ value: `user:${user.id}`, label: `${t("permissions.scopeUser")} · ${user.name}` })),
  ];
  return (
    <Select
      aria-label={t("permissions.subject")}
      className={className}
      value={subjectKey(subject)}
      onValueChange={(value) => {
        const separator = value.indexOf(":");
        const kind = value.slice(0, separator);
        const id = value.slice(separator + 1);
        onChange(kind === "group" || kind === "user" ? { kind, id } : { kind: "everyone", id: "" });
      }}
      options={options}
    />
  );
}
