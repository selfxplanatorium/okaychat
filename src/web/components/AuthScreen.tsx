import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { Brand } from "@/components/layout/Brand";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";

export function AuthScreen({ needsSetup, signupOpen, onDone }: { needsSetup: boolean; signupOpen: boolean; onDone: () => void }) {
  const [mode, setMode] = useState<"login" | "signup">(needsSetup ? "signup" : "login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [errorSeq, setErrorSeq] = useState(0);
  const [busy, setBusy] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  // Restart the shake for every failed attempt, including a repeated error.
  useEffect(() => {
    const form = formRef.current;
    if (!errorSeq || !form) return;
    form.classList.remove("animate-shake");
    void form.offsetWidth;
    form.classList.add("animate-shake");
  }, [errorSeq]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/auth/${mode}`, { method: "POST", json: { email, password, name: name || undefined } });
      onDone();
    } catch (err) {
      setError((err as Error).message);
      setErrorSeq((n) => n + 1);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-full place-items-center p-6">
      <div className="animate-rise-in-lg w-full max-w-sm">
        <form ref={formRef} onSubmit={submit} className="surface-glass depth-float flex w-full flex-col gap-4 rounded-2xl border p-6">
          <div className="stagger animate-rise-in" style={{ "--i": 0 } as CSSProperties}>
            <Brand />
          </div>
          <div className="stagger animate-rise-in" style={{ "--i": 1 } as CSSProperties}>
            <h1 className="text-lg font-semibold">{needsSetup ? "Create the admin account" : mode === "login" ? "Sign in" : "Create an account"}</h1>
            {needsSetup && <p className="text-muted-foreground text-sm">The first account manages this server.</p>}
          </div>
          {mode === "signup" && (
            <Input
              className="stagger animate-rise-in"
              style={{ "--i": 2 } as CSSProperties}
              placeholder="Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="name"
            />
          )}
          <Input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            required
            autoFocus
            className="stagger animate-rise-in"
            style={{ "--i": 3 } as CSSProperties}
          />
          <Input
            type="password"
            placeholder="Password (8+ characters)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            minLength={8}
            required
            className="stagger animate-rise-in"
            style={{ "--i": 4 } as CSSProperties}
          />
          {error && (
            <p key={errorSeq} className="text-error animate-fade-in text-sm">
              {error}
            </p>
          )}
          <Button type="submit" disabled={busy} className="stagger animate-rise-in" style={{ "--i": 5 } as CSSProperties}>
            {mode === "login" ? "Sign in" : "Create account"}
          </Button>
          {!needsSetup && signupOpen && (
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground stagger animate-rise-in text-sm transition-colors duration-(--motion-fast) ease-out-quart"
              style={{ "--i": 6 } as CSSProperties}
              onClick={() => setMode(mode === "login" ? "signup" : "login")}
            >
              {mode === "login" ? "No account? Create one" : "Have an account? Sign in"}
            </button>
          )}
        </form>
      </div>
    </div>
  );
}
