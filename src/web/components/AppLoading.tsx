/** The one startup state. It stays invisible for fast loads and fades in only when loading takes a while. */
export function AppLoading() {
  return <div role="status" className="app-loading text-muted-foreground grid h-full place-items-center text-sm">Loading okaychat…</div>;
}
