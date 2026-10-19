import { ExternalLinkIcon } from "lucide-react";
import { Link } from "wouter";
import { Brand } from "@/components/layout/Sidebar";
import { OPENCODE_GO_CONSOLE, ProviderForm } from "@/components/settings/ProvidersSettings";
import { useData } from "@/state/data";

/** First run: OpenCode Go is the recommended connection, everything else is one click away. */
export function Onboarding() {
  const go = useData((s) => s.providers.find((p) => p.id === "opencode-go"));
  return (
    <div className="grid min-h-full place-items-center p-6">
      <div className="surface-glass flex w-full max-w-md flex-col gap-5 rounded-2xl border p-6 shadow-sm">
        <Brand />
        <div>
          <h1 className="text-lg font-semibold">Connect OpenCode Go</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            One subscription, many frontier and open models (GLM, Kimi, DeepSeek, Qwen, MiniMax, GPT, Claude Haiku, Gemini) with generous limits and free models. Paste your key to start.
          </p>
        </div>
        {go ? <ProviderForm provider={go} autoFocus /> : <p className="text-muted-foreground text-sm">Loading providers…</p>}
        <a href={OPENCODE_GO_CONSOLE} target="_blank" rel="noreferrer" className="text-primary inline-flex items-center gap-1 text-sm hover:underline">
          Get an OpenCode Go key <ExternalLinkIcon className="size-3.5" />
        </a>
        <div className="text-muted-foreground border-t pt-4 text-sm">
          Using another provider?{" "}
          <Link href="/settings/providers" className="text-foreground hover:underline">
            Connect OpenAI, Anthropic, Google, OpenRouter, Ollama, or any of 200+ others
          </Link>
          .
        </div>
      </div>
    </div>
  );
}
