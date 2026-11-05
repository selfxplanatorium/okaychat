import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { t } from "@/i18n";
import { SettingsSection } from "../SettingsUI";

const SETUP = `export OKAYCHAT_BASE_URL='https://your-host/v1'
# Set OKAYCHAT_API_KEY securely in your environment.`;
const CURL_MODELS = `curl "$OKAYCHAT_BASE_URL/models" -H "Authorization: Bearer $OKAYCHAT_API_KEY"`;
const CURL_BUFFERED = `curl "$OKAYCHAT_BASE_URL/chat/completions" \\
  -H "Authorization: Bearer $OKAYCHAT_API_KEY" -H 'Content-Type: application/json' \\
  -d '{"model":"provider/model","messages":[{"role":"user","content":"Hello"}],"max_completion_tokens":256}'`;
const CURL_STREAM = `curl -N "$OKAYCHAT_BASE_URL/chat/completions" \\
  -H "Authorization: Bearer $OKAYCHAT_API_KEY" -H 'Content-Type: application/json' \\
  -d '{"model":"provider/model","messages":[{"role":"user","content":"Hello"}],"stream":true,"stream_options":{"include_usage":true}}'`;
const SNIPPET = [SETUP, CURL_MODELS, CURL_BUFFERED, CURL_STREAM].join("\n");

const PARAMS = [
  { name: "model", valueKey: "apiAccess.paramModel", notesKey: "apiAccess.paramModelNotes" },
  { name: "messages", valueKey: "apiAccess.paramMessages", notesKey: "apiAccess.paramMessagesNotes" },
  { name: "stream", valueKey: "apiAccess.paramStream", notesKey: "apiAccess.paramStreamNotes" },
  { name: "temperature", valueKey: "apiAccess.paramTemperature", notesKey: "apiAccess.paramTemperatureNotes" },
  { name: "reasoning_effort", valueKey: "apiAccess.paramReasoning", notesKey: "apiAccess.paramReasoningNotes" },
  { name: "max_tokens / max_completion_tokens", valueKey: "apiAccess.paramTokens", notesKey: "apiAccess.paramTokensNotes" },
] as const;

export function ApiDocsPanel() {
  const { copyToClipboard } = useCopyToClipboard();
  const [copied, setCopied] = useState(false);
  // Snippets use the origin this page was loaded from; no request header can choose it.
  const baseUrl = typeof window === "undefined" ? "/v1" : `${window.location.origin}/v1`;

  const copy = () => {
    copyToClipboard(SNIPPET);
    setCopied(true);
    setTimeout(() => setCopied(false), 3000);
  };

  return (
    <div id="setting-api-docs" tabIndex={-1} className="scroll-mt-24 outline-none">
      <SettingsSection title={t("apiAccess.docs")} description={t("apiAccess.stateless")}>
        <div className="flex flex-col gap-3 px-4 py-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-medium">{t("apiAccess.baseUrl")}</span>
            <code data-no-drawer-swipe className="text-muted-foreground max-w-full overflow-x-auto font-mono text-xs whitespace-nowrap">{baseUrl}</code>
          </div>
          <div data-no-drawer-swipe className="bg-muted/60 depth-field max-w-full overflow-x-auto rounded-lg p-3">
            <pre className="font-mono text-xs leading-relaxed whitespace-pre">{SETUP}</pre>
          </div>
          {[
            { title: t("apiAccess.docsCurl"), code: CURL_MODELS },
            { title: t("apiAccess.docsBuffered"), code: CURL_BUFFERED },
            { title: t("apiAccess.docsStream"), code: CURL_STREAM },
          ].map((example) => (
            <div key={example.title} className="flex flex-col gap-1">
              <h3 className="text-sm font-medium">{example.title}</h3>
              <div data-no-drawer-swipe className="bg-muted/60 depth-field max-w-full overflow-x-auto rounded-lg p-3">
                <pre className="font-mono text-xs leading-relaxed whitespace-pre">{example.code}</pre>
              </div>
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={copy} data-command="apiAccess.copyExample">
              {t("apiAccess.copyExample")}
            </Button>
            <span aria-live="polite" className="text-muted-foreground text-xs">{copied ? t("common.copied") : ""}</span>
          </div>
          <p className="text-muted-foreground text-xs">{t("apiAccess.docsNote")}</p>
          <p className="text-destructive text-xs font-medium">{t("apiAccess.https")}</p>
          <p className="text-muted-foreground text-xs">{t("apiAccess.errorCaveat")}</p>
        </div>
        <div data-no-drawer-swipe className="max-w-full overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="text-foreground px-4 pt-3 pb-1 text-left text-sm font-medium">{t("apiAccess.paramsTitle")}</caption>
            <thead className="text-muted-foreground text-xs">
              <tr className="text-left">
                <th scope="col" className="px-4 py-2 font-medium">{t("apiAccess.paramName")}</th>
                <th scope="col" className="px-2 py-2 font-medium">{t("apiAccess.paramValue")}</th>
                <th scope="col" className="px-4 py-2 font-medium">{t("apiAccess.paramNotes")}</th>
              </tr>
            </thead>
            <tbody className="divide-border divide-y">
              {PARAMS.map((param) => (
                <tr key={param.name}>
                  <td className="px-4 py-2 font-mono text-xs whitespace-nowrap">{param.name}</td>
                  <td className="px-2 py-2 font-mono text-xs whitespace-nowrap">{t(param.valueKey)}</td>
                  <td className="text-muted-foreground px-4 py-2 text-xs">{t(param.notesKey)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SettingsSection>
    </div>
  );
}
