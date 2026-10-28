import { ExternalLinkIcon } from "lucide-react";
import type { CSSProperties } from "react";
import { Link } from "wouter";
import { Brand } from "@/components/layout/Brand";
import { OPENCODE_GO_CONSOLE, ProviderForm } from "@/components/settings/ProvidersSettings";
import { useData } from "@/state/data";

/** First run: OpenCode Go is the recommended connection, everything else is one click away. */
export function Onboarding() {
  const go = useData((s) => s.providers.find((p) => p.id === "opencode-go"));
  const updateSettings = useData((s) => s.updateSettings);
  return (
    <div className="grid min-h-full place-items-center p-6">
      <div className="animate-rise-in-lg w-full max-w-md">
        <div className="surface-glass flex w-full flex-col gap-5 rounded-2xl border p-6 shadow-sm">
          <div className="stagger animate-rise-in" style={{ "--i": 0 } as CSSProperties}>
            <Brand />
          </div>
          <div className="stagger animate-rise-in" style={{ "--i": 1 } as CSSProperties}>
            <h1 className="text-lg font-semibold">Connect OpenCode Go</h1>
            <p className="text-muted-foreground mt-1 text-sm">
              One subscription, many frontier and open models (GLM, Kimi, DeepSeek, Qwen, MiniMax, GPT, Claude Haiku, Gemini) with generous limits and free models. Paste your key to start.
            </p>
          </div>
          <div className="stagger animate-rise-in" style={{ "--i": 2 } as CSSProperties}>
            {go ? <ProviderForm provider={go} autoFocus /> : <p className="text-muted-foreground text-sm">Loading providers…</p>}
          </div>
          <a
            href={OPENCODE_GO_CONSOLE}
            target="_blank"
            rel="noreferrer"
            className="text-primary stagger animate-rise-in inline-flex items-center gap-1 text-sm transition-colors duration-(--motion-fast) ease-out-quart hover:underline"
            style={{ "--i": 3 } as CSSProperties}
          >
            Get an OpenCode Go key <ExternalLinkIcon className="size-3.5" />
          </a>
          <div className="text-muted-foreground border-t pt-4 text-sm stagger animate-rise-in" style={{ "--i": 4 } as CSSProperties}>
            Using another provider?{" "}
            <Link href="/settings/providers" className="text-foreground transition-colors duration-(--motion-fast) ease-out-quart hover:underline">
              Connect OpenAI, Anthropic, Google, OpenRouter, Ollama, or any of 200+ others
            </Link>
            .
          </div>
          <button
            type="button"
            onClick={() => void updateSettings({ onboardingSkipped: true }).catch(() => {})}
            className="text-muted-foreground hover:text-foreground stagger animate-rise-in self-start text-sm transition-colors duration-(--motion-fast) ease-out-quart hover:underline"
            style={{ "--i": 5 } as CSSProperties}
          >
            Skip for now and look around
          </button>
        </div>
      </div>
    </div>
  );
}
