export function Brand() {
  return (
    <div className="flex items-center gap-2 font-semibold tracking-tight">
      <span
        aria-hidden="true"
        className="size-6 shrink-0 bg-contain bg-center bg-no-repeat"
        style={{ backgroundImage: 'var(--brand-icon, url("/icon.webp"))' }}
      />
      okaychat
    </div>
  );
}

