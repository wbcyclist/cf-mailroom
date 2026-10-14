import { useI18n } from "../LanguageProvider";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ArrowLeftIcon } from "./Icons";

export type SettingsSection = "general" | "inboxes";

export function SettingsHeader(props: {
  active: SettingsSection;
  onBack: () => void;
  onOpenGeneral: () => void;
  onOpenInboxes: () => void;
}) {
  const { t } = useI18n();
  return (
    <header className="shrink-0 border-b bg-background px-4 md:px-8">
      <div className="flex h-14 items-center gap-2">
        <Button
          variant="ghost"
          size="icon"
          onClick={props.onBack}
          className="-ml-1.5 lg:hidden"
          aria-label={t("Back to inbox")}
        >
          <ArrowLeftIcon className="h-5 w-5" />
        </Button>
        <h1 className="text-[15px] font-semibold tracking-[-0.015em] text-foreground">{t("Settings")}</h1>
      </div>
      <nav aria-label={t("Settings sections")} className="-mb-px flex gap-5">
        <SettingsTab active={props.active === "general"} onClick={props.onOpenGeneral}>
          {t("General")}
        </SettingsTab>
        <SettingsTab active={props.active === "inboxes"} onClick={props.onOpenInboxes}>
          {t("Inboxes")}
        </SettingsTab>
      </nav>
    </header>
  );
}

function SettingsTab(props: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      aria-current={props.active ? "page" : undefined}
      className={cn(
        "relative rounded-t-sm pb-2.5 text-[13px] outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50",
        "after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:rounded-full after:transition-colors",
        props.active
          ? "font-medium text-foreground after:bg-foreground"
          : "text-muted-foreground after:bg-transparent hover:text-foreground",
      )}
    >
      {props.children}
    </button>
  );
}

export function SettingsPage(props: { children: ReactNode }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="w-full max-w-[780px] space-y-10 px-4 py-6 md:px-8 md:py-8">{props.children}</div>
    </div>
  );
}

export function SettingsBlock(props: {
  id: string;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={props.id}>
      <div className="mb-3 flex items-end justify-between gap-4">
        <div className="min-w-0">
          <h2 id={props.id} className="text-sm font-semibold text-foreground">
            {props.title}
          </h2>
          {props.description && (
            <p className="mt-1 max-w-xl text-[13px] leading-5 text-muted-foreground">
              {props.description}
            </p>
          )}
        </div>
        {props.action && <div className="shrink-0">{props.action}</div>}
      </div>
      {props.children}
    </section>
  );
}

export function SettingsPanel(props: { className?: string; children: ReactNode }) {
  return (
    <div className={cn("overflow-hidden rounded-xl border bg-background", props.className)}>
      {props.children}
    </div>
  );
}
