export function Brand() {
  return (
    <div className="flex items-center gap-2">
      <span
        aria-hidden="true"
        className="size-6 shrink-0 bg-contain bg-center bg-no-repeat drop-shadow-[0_2px_3px_color-mix(in_oklab,var(--primary)_40%,transparent)]"
        style={{ backgroundImage: 'var(--brand-icon, url("/icon.webp"))' }}
      />
      <span
        aria-hidden="true"
        className="block aspect-[964/234] h-5 shrink-0"
        style={{
          backgroundColor: "var(--app-theme-accent, var(--primary))",
          mask: 'url("/wordmark.svg") center / contain no-repeat',
          WebkitMask: 'url("/wordmark.svg") center / contain no-repeat',
        }}
      />
      <span className="sr-only">okaychat</span>
    </div>
  );
}

