export function Brand() {
  return (
    <div className="flex items-center gap-2 font-semibold tracking-tight">
      <span
        aria-hidden="true"
        className="size-6 shrink-0 bg-contain bg-center bg-no-repeat drop-shadow-[0_2px_3px_color-mix(in_oklab,var(--primary)_40%,transparent)]"
        style={{ backgroundImage: 'var(--brand-icon, url("/icon.webp"))' }}
      />
      okaychat
    </div>
  );
}

