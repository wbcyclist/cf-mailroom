import { useI18n } from "../LanguageProvider";
import { useState } from "react";
import { Button } from "@/components/ui/button";

export function CopyField(props: { label?: string; value: string; placeholder?: boolean }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(props.value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-lg border bg-canvas py-1 pl-3 pr-1">
      {props.label && (
        <span className="shrink-0 font-mono text-[12px] text-muted-foreground">{props.label}</span>
      )}
      <code
        className={`min-w-0 flex-1 truncate font-mono text-[12.5px] ${props.placeholder ? "text-muted-foreground italic" : "text-foreground"}`}
        title={props.value}
      >
        {props.value}
      </code>
      {!props.placeholder && (
        <Button variant="ghost" size="sm" className="h-7 shrink-0 px-2 text-xs" onClick={copy}>
          {copied ? t("Copied") : t("Copy")}
        </Button>
      )}
    </div>
  );
}
