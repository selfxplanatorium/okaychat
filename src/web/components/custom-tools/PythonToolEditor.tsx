import { CUSTOM_LIMITS, PYTHON_SAMPLE } from "@shared/custom-tools";
import type { PythonConfig } from "@shared/custom-tools";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/i18n";

export function PythonToolEditor({ config, onChange, disabled }: { config: PythonConfig; onChange: (config: PythonConfig) => void; disabled?: boolean }) {
  return (
    <section aria-labelledby="custom-tool-code-heading" className="grid gap-2">
      <h3 id="custom-tool-code-heading" className="text-sm font-medium">{t("customTools.code")}</h3>
      <p className="text-muted-foreground text-xs">{t("customTools.codeHelp")}</p>
      <Textarea
        aria-label={t("customTools.code")}
        rows={14}
        className="font-mono text-xs"
        spellCheck={false}
        value={config.code}
        disabled={disabled}
        placeholder={PYTHON_SAMPLE}
        onChange={(event) => onChange({ ...config, code: event.target.value })}
      />
      {config.code.trim().length === 0 && (
        <Button type="button" size="xs" variant="outline" className="w-fit" onClick={() => onChange({ ...config, code: PYTHON_SAMPLE })}>
          {t("customTools.runTest")}
        </Button>
      )}
      <label className="w-48 text-xs">
        <span className="text-muted-foreground">{t("customTools.timeout")}</span>
        <Input type="number" min={CUSTOM_LIMITS.pythonTimeoutMin} max={CUSTOM_LIMITS.pythonTimeoutMax} step={1000} className="mt-1" value={config.timeoutMs} onChange={(event) => onChange({ ...config, timeoutMs: Number(event.target.value) })} disabled={disabled} />
      </label>
    </section>
  );
}
