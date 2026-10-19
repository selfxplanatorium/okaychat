import { useState, type FormEvent } from "react";
import { Brand } from "@/components/layout/Sidebar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";

export function AuthScreen({ needsSetup, signupOpen, onDone }: { needsSetup: boolean; signupOpen: boolean; onDone: () => void }) {
  const [mode, setMode] = useState<"login" | "signup">(needsSetup ? "signup" : "login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/auth/${mode}`, { method: "POST", json: { email, password, name: name || undefined } });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-full place-items-center p-6">
      <form onSubmit={submit} className="surface-glass flex w-full max-w-sm flex-col gap-4 rounded-2xl border p-6 shadow-sm">
        <Brand />
        <div>
          <h1 className="text-lg font-semibold">{needsSetup ? "Create the admin account" : mode === "login" ? "Sign in" : "Create an account"}</h1>
          {needsSetup && <p className="text-muted-foreground text-sm">The first account manages this server.</p>}
        </div>
        {mode === "signup" && <Input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />}
        <Input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required autoFocus />
        <Input
          type="password"
          placeholder="Password (8+ characters)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete={mode === "login" ? "current-password" : "new-password"}
          minLength={8}
          required
        />
        {error && <p className="text-error text-sm">{error}</p>}
        <Button type="submit" disabled={busy}>
          {mode === "login" ? "Sign in" : "Create account"}
        </Button>
        {!needsSetup && signupOpen && (
          <button type="button" className="text-muted-foreground hover:text-foreground text-sm" onClick={() => setMode(mode === "login" ? "signup" : "login")}>
            {mode === "login" ? "No account? Create one" : "Have an account? Sign in"}
          </button>
        )}
      </form>
    </div>
  );
}
