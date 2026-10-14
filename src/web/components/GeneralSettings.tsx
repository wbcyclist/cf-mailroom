import type { Translator } from "../i18n";
import { useMemo } from "react";
import { getTimeZones } from "../time-zone";
import { isLanguagePreference } from "../i18n";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useI18n } from "../LanguageProvider";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { AiSettings } from "./AiSettings";
import {
  disableBrowserNotifications,
  enableBrowserNotifications,
  fetchGeneralSettings,
} from "../api";
import {
  BrowserPushError,
  createBrowserPushSubscription,
  getBrowserPushState,
  unsubscribeCurrentBrowser,
} from "../push-notifications";
import { BellIcon } from "./Icons";
import { McpSettings } from "./McpSettings";
import {
  SettingsBlock,
  SettingsHeader,
  SettingsPage,
  SettingsPanel,
} from "./SettingsNavigation";

export function GeneralSettings(props: {
  onBack: () => void;
  onOpenInboxes: () => void;
}) {
  const { t, locale, preference, setPreference, errorMessage, systemTimeZone, timeZonePreference, setTimeZonePreference } = useI18n();
  const timeZones = useMemo(() => getTimeZones(systemTimeZone, timeZonePreference), [systemTimeZone, timeZonePreference]);
  const queryClient = useQueryClient();
  const settings = useQuery({
    queryKey: ["settings", "general"],
    queryFn: fetchGeneralSettings,
  });
  const browser = useQuery({
    queryKey: ["browser-push-state"],
    queryFn: getBrowserPushState,
    staleTime: 0,
    refetchOnWindowFocus: true,
  });

  const refreshState = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["settings", "general"] }),
      queryClient.invalidateQueries({ queryKey: ["browser-push-state"] }),
    ]);
  };

  const enable = useMutation({
    mutationFn: async () => {
      const publicKey = settings.data?.vapid_public_key;
      if (!publicKey) throw new Error("Browser notifications are not configured.");
      const subscription = await createBrowserPushSubscription(publicKey, locale);
      await enableBrowserNotifications(subscription);
    },
    onSettled: refreshState,
  });

  const disable = useMutation({
    mutationFn: async () => {
      await disableBrowserNotifications();
      await unsubscribeCurrentBrowser();
    },
    onSettled: refreshState,
  });

  const globalEnabled = Boolean(settings.data?.browser_notifications_enabled);
  const configured = Boolean(settings.data?.browser_notifications_configured);
  const supported = browser.data?.supported ?? true;
  const blocked = browser.data?.permission === "denied";
  const subscribed = Boolean(browser.data?.subscribed);
  const busy = enable.isPending || disable.isPending;
  const switchDisabled =
    settings.isLoading ||
    browser.isLoading ||
    busy ||
    !configured ||
    (!globalEnabled && (!supported || blocked));
  const error = enable.error ?? disable.error;

  return (
    <div className="flex h-full min-w-0 flex-col bg-canvas">
      <SettingsHeader
        active="general"
        onBack={props.onBack}
        onOpenGeneral={() => undefined}
        onOpenInboxes={props.onOpenInboxes}
      />

      <SettingsPage>
        <SettingsBlock id="language-settings-heading" title={t("Language")}>
          <SettingsPanel>
            <div className="space-y-2 px-4 py-4 sm:px-5">
              <label htmlFor="display-language" className="text-[13.5px] font-medium">{t("Display language")}</label>
              <Select value={preference} onValueChange={(value) => {
                if (isLanguagePreference(value)) setPreference(value);
              }}>
                <SelectTrigger id="display-language" className="w-full max-w-xs" aria-describedby="language-description">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="system">{t("Follow browser")}</SelectItem>
                  <SelectItem value="en"><span lang="en">English</span></SelectItem>
                  <SelectItem value="zh-CN"><span lang="zh-CN">简体中文</span></SelectItem>
                </SelectContent>
              </Select>
              <p id="language-description" className="text-[13px] leading-5 text-muted-foreground">
                {t("Saved in this browser. Email content and inbox instructions stay unchanged.")}
              </p>
            </div>
          </SettingsPanel>
        </SettingsBlock>
        <SettingsBlock id="time-zone-settings-heading" title={t("Time zone")}>
          <SettingsPanel>
            <div className="space-y-2 px-4 py-4 sm:px-5">
              <label htmlFor="display-time-zone" className="text-[13.5px] font-medium">{t("Display time zone")}</label>
              <Select value={timeZonePreference} onValueChange={setTimeZonePreference}>
                <SelectTrigger id="display-time-zone" className="w-full max-w-xs" aria-describedby="time-zone-description">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="system">{t("Follow browser ({timeZone})", { timeZone: systemTimeZone })}</SelectItem>
                  {timeZones.map((zone) => <SelectItem key={zone} value={zone}>{zone}</SelectItem>)}
                </SelectContent>
              </Select>
              <p id="time-zone-description" className="text-[13px] leading-5 text-muted-foreground">
                {t("Saved in this browser. Applies to message dates and times.")}
              </p>
            </div>
          </SettingsPanel>
        </SettingsBlock>
        <SettingsBlock id="notification-settings-heading" title={t("Notifications")}>
          <SettingsPanel>
            <div className="flex items-start gap-4 px-4 py-4 sm:px-5">
              <div className="min-w-0 flex-1">
                <label
                  htmlFor="browser-notifications"
                  className="flex items-center gap-2 text-[13.5px] font-medium text-foreground"
                >
                  <BellIcon className="h-4 w-4 text-muted-foreground" />
                  {t("New email notifications")}
                </label>
                <p className="mt-1 max-w-xl text-[13px] leading-5 text-muted-foreground">
                  {notificationDescription(t, {
                    configured,
                    supported,
                    blocked,
                    globalEnabled,
                    subscribed,
                  })}
                </p>

                {globalEnabled && !subscribed && supported && !blocked && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-3"
                    onClick={() => enable.mutate()}
                    disabled={busy || !configured}
                  >
                    {enable.isPending ? t("Enabling…") : t("Enable on this browser")}
                  </Button>
                )}

                {error && (
                  <p className="mt-2 text-xs leading-5 text-destructive" role="alert">
                    {errorMessage(notificationErrorMessage(t, error))}
                  </p>
                )}
              </div>
              <Switch
                id="browser-notifications"
                checked={globalEnabled}
                onCheckedChange={(checked) =>
                  checked ? enable.mutate() : disable.mutate()
                }
                disabled={switchDisabled}
                aria-describedby="browser-notifications-description"
                className="mt-0.5"
              />
              <span id="browser-notifications-description" className="sr-only">
                {t("Applies to new email received by every inbox in this workspace.")}
              </span>
            </div>
          </SettingsPanel>
        </SettingsBlock>

        <AiSettings saved={settings.data} />

        <McpSettings />
      </SettingsPage>
    </div>
  );
}

function notificationDescription(t: Translator, state: {
  configured: boolean;
  supported: boolean;
  blocked: boolean;
  globalEnabled: boolean;
  subscribed: boolean;
}): string {
  if (!state.configured) return t("Push delivery has not been configured on this server.");
  if (!state.supported) return t("This browser does not support push notifications.");
  if (state.blocked) return t("Notifications are blocked in this browser's site settings.");
  if (state.globalEnabled && state.subscribed) {
    return t("This browser will notify you when any inbox receives a new email.");
  }
  if (state.globalEnabled) return t("Notifications are on, but this browser is not subscribed yet.");
  return t("Get notified when any inbox receives a new email.");
}

function notificationErrorMessage(t: Translator, error: Error): string {
  if (error instanceof BrowserPushError && error.code === "permission-denied") {
    return t("Notifications were not allowed. Change this site's notification permission in your browser to try again.");
  }
  return error.message || t("Couldn’t update browser notifications. Try again.");
}
