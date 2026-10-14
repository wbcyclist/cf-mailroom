import { useI18n } from "../LanguageProvider";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AI_MODEL_CATALOG_URL,
  DEFAULT_AI_BASE_URL,
  DEFAULT_AI_MODEL,
  type AiProvider,
  type AiSettings as Settings,
} from "../../shared/ai-model";
import type { GeneralSettings } from "../../shared/types";
import { updateAiSettings } from "../api";
import { DashLink } from "./DashLink";
import { SettingsBlock, SettingsPanel } from "./SettingsNavigation";

export function AiSettings({ saved }: { saved: GeneralSettings | undefined }) {
  const { t, errorMessage } = useI18n();
  const queryClient = useQueryClient();
  const [edit, setEdit] = useState<Settings | null>(null);
  const current: Settings = edit ?? {
    ai_provider: saved?.ai_provider ?? "disabled",
    ai_model: saved?.ai_model ?? null,
    ai_base_url: saved?.ai_base_url ?? null,
  };
  const dirty = Boolean(
    saved &&
    (current.ai_provider !== saved.ai_provider ||
      current.ai_model !== saved.ai_model ||
      current.ai_base_url !== saved.ai_base_url),
  );
  const external =
    current.ai_provider === "openai-compatible" ||
    current.ai_provider === "openai-responses";
  const workers = current.ai_provider === "workers-ai";
  const save = useMutation({
    mutationFn: () => updateAiSettings(current),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["settings", "general"],
      });
      setEdit(null);
    },
  });
  const busy = !saved || save.isPending;
  const change = (patch: Partial<Settings>) => {
    setEdit({ ...current, ...patch });
    save.reset();
  };

  return (
    <SettingsBlock id="ai-settings-heading" title="AI">
      <SettingsPanel>
        <form
          className="space-y-4 px-4 py-4 sm:px-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (dirty && !busy) save.mutate();
          }}
        >
          <div className="max-w-xl space-y-2">
            <label
              htmlFor="ai-provider"
              className="text-[13.5px] font-medium text-foreground"
            >
              {t("Provider")}
            </label>
            <Select
              value={current.ai_provider}
              disabled={busy}
              onValueChange={(value) => {
                const provider = value as AiProvider;
                const nextExternal =
                  provider === "openai-compatible" ||
                  provider === "openai-responses";
                change({
                  ai_provider: provider,
                  ai_base_url: nextExternal
                    ? (current.ai_base_url ?? DEFAULT_AI_BASE_URL)
                    : null,
                  ai_model: nextExternal === external ? current.ai_model : null,
                });
              }}
            >
              <SelectTrigger id="ai-provider" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="disabled">{t("Disabled")}</SelectItem>
                <SelectItem value="workers-ai">
                  Cloudflare Workers AI
                </SelectItem>
                <SelectItem value="openai-compatible">
                  {t("OpenAI-compatible · Chat Completions")}
                </SelectItem>
                <SelectItem value="openai-responses">
                  OpenAI Responses API
                </SelectItem>
              </SelectContent>
            </Select>
            <p className="text-[13px] leading-5 text-muted-foreground">
              {current.ai_provider === "disabled"
                ? t("AI drafting and automatic labels are off for all inboxes.")
                : t("Email text is sent to the selected provider for drafts and automatic labels. Inbox drafting rules still apply.")}
            </p>
          </div>

          {external && (
            <div className="max-w-xl space-y-2">
              <label
                htmlFor="ai-base-url"
                className="text-[13.5px] font-medium text-foreground"
              >
                {t("Base URL")}
              </label>
              <Input
                id="ai-base-url"
                type="url"
                required
                value={current.ai_base_url ?? ""}
                onChange={(event) =>
                  change({ ai_base_url: event.target.value })
                }
                disabled={busy}
                placeholder={DEFAULT_AI_BASE_URL}
                spellCheck={false}
                autoComplete="off"
                autoCapitalize="off"
                aria-describedby="ai-base-url-help"
                className="font-mono text-[13px] md:text-[13px]"
              />
              <p
                id="ai-base-url-help"
                className="text-[13px] leading-5 text-muted-foreground"
              >
                {t("HTTPS API root, including its version path. Mailroom appends {path}.", {
                  path: current.ai_provider === "openai-responses" ? "/responses" : "/chat/completions",
                })}
              </p>
            </div>
          )}

          {(workers || external) && (
            <div className="max-w-xl space-y-2">
              <label
                htmlFor="ai-model"
                className="text-[13.5px] font-medium text-foreground"
              >
                {t("Model")}
              </label>
              <Input
                id="ai-model"
                required={external}
                value={current.ai_model ?? ""}
                onChange={(event) =>
                  change({ ai_model: event.target.value || null })
                }
                disabled={busy}
                placeholder={
                  workers ? DEFAULT_AI_MODEL : t("Model ID from your provider")
                }
                spellCheck={false}
                autoComplete="off"
                autoCapitalize="off"
                maxLength={200}
                className="font-mono text-[13px] md:text-[13px]"
              />
              <p className="text-[13px] leading-5 text-muted-foreground">
                {workers ? (
                  <>
                    {t("Leave empty for the default draft model. Automatic labels use typesafe/jev.")}{" "}
                    <DashLink href={AI_MODEL_CATALOG_URL}>
                      {t("Model catalog")}
                    </DashLink>
                  </>
                ) : (
                  t("Used for both drafts and automatic labels.")
                )}
              </p>
            </div>
          )}

          {workers && !saved?.ai_workers_available && (
            <p
              role="status"
              className="text-[13px] leading-5 text-muted-foreground"
            >
              {t("Workers AI is not configured on this server. Add the AI binding before use.")}
            </p>
          )}
          {external && (
            <p
              role="status"
              className="text-[13px] leading-5 text-muted-foreground"
            >
              {saved?.ai_external_available
                ? t("The AI_API_KEY Worker secret is configured.")
                : t("The external API key is missing. Add the AI_API_KEY Worker secret before use.")}
            </p>
          )}
          <Button type="submit" variant="outline" disabled={!dirty || busy}>
            {save.isPending ? t("Saving…") : t("Save")}
          </Button>
          {save.isError && (
            <p role="alert" className="text-xs leading-5 text-destructive">
              {errorMessage(save.error.message) || t("Could not save AI settings. Try again.")}
            </p>
          )}
          {save.isSuccess && !dirty && (
            <p
              role="status"
              className="text-xs leading-5 text-muted-foreground"
            >
              {t("Saved.")}
            </p>
          )}
        </form>
      </SettingsPanel>
    </SettingsBlock>
  );
}
