import { useI18n } from "../LanguageProvider";
import type { Mailbox } from "../../shared/types";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ArchiveIcon, InboxIcon, SettingsIcon } from "./Icons";
import { SquarePen } from "lucide-react";

export function Sidebar(props: {
  mailboxes: Mailbox[];
  selected: number | null;
  activeView: "inbox" | "archive" | "settings";
  onSelect: (id: number | null) => void;
  onOpenArchive: () => void;
  onOpenSettings: () => void;
  onCompose: () => void;
}) {
  const { t } = useI18n();
  const totalUnread = props.mailboxes.reduce((sum, mailbox) => sum + mailbox.unread_count, 0);

  return (
    <aside className="hidden w-60 shrink-0 flex-col border-r bg-sidebar lg:flex">
      <div className="flex h-14 items-center gap-2.5 px-4">
        <img
          src="/brand/mailroom.png"
          alt=""
          width={20}
          height={20}
          className="h-5 w-5 shrink-0 object-contain"
        />
        <p className="min-w-0 truncate text-sm font-semibold tracking-[-0.01em] text-foreground">
          Mailroom
        </p>
      </div>

      <nav aria-label={t("Mail")} className="min-h-0 flex-1 overflow-y-auto px-2 pt-1 pb-4">
        <div className="space-y-px">
          <SidebarItem
            label={t("All inboxes")}
            icon={<InboxIcon className="h-4 w-4" />}
            unread={totalUnread}
            active={props.activeView === "inbox" && props.selected === null}
            onClick={() => props.onSelect(null)}
          />
          {props.mailboxes.length > 0 && (
            <div role="group" aria-label={t("Inboxes")} className="ml-[18px] space-y-px border-l pl-[7px]">
              {props.mailboxes.map((mailbox) => (
                <SidebarItem
                  key={mailbox.id}
                  label={mailbox.address}
                  unread={mailbox.unread_count}
                  active={props.activeView === "inbox" && props.selected === mailbox.id}
                  onClick={() => props.onSelect(mailbox.id)}
                />
              ))}
            </div>
          )}
          <SidebarItem
            label={t("Archive")}
            icon={<ArchiveIcon className="h-4 w-4" />}
            unread={0}
            active={props.activeView === "archive"}
            onClick={props.onOpenArchive}
          />
        </div>
      </nav>

      <div className="shrink-0 p-3">
        <Button
          type="button"
          variant="outline"
          onClick={props.onCompose}
          className="h-9 w-full justify-start gap-2.5 rounded-md px-2.5 text-[13px]"
        >
          <SquarePen className="h-4 w-4" aria-hidden="true" />
          {t("Compose")}
        </Button>
      </div>

      <div className="shrink-0 border-t px-3 py-2">
        <SidebarItem
          label={t("Settings")}
          icon={<SettingsIcon className="h-4 w-4" />}
          unread={0}
          active={props.activeView === "settings"}
          onClick={props.onOpenSettings}
        />
      </div>
    </aside>
  );
}

function SidebarItem(props: {
  label: string;
  icon?: React.ReactNode;
  unread: number;
  active: boolean;
  onClick: () => void;
}) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      onClick={props.onClick}
      title={props.label}
      aria-current={props.active ? "page" : undefined}
      className={cn(
        "group flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-[13px] outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50",
        props.active
          ? "bg-sidebar-accent font-medium text-foreground"
          : "text-foreground/80 hover:bg-sidebar-accent/60 hover:text-foreground",
      )}
    >
      {props.icon && (
        <span
          className={cn(
            "flex shrink-0 items-center justify-center",
            props.active ? "text-foreground" : "text-muted-foreground group-hover:text-foreground",
          )}
        >
          {props.icon}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate">{props.label}</span>
      {props.unread > 0 && (
        <span
          className={cn(
            "shrink-0 text-xs tabular-nums",
            props.active ? "font-semibold text-foreground" : "font-medium text-muted-foreground",
          )}
        >
          <span className="sr-only">{t(", unread: ")}</span>
          {props.unread > 99 ? "99+" : props.unread}
        </span>
      )}
    </button>
  );
}
