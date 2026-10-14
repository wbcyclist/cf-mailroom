import {
  DEFAULT_AI_MODEL,
  parseAiSettings,
  type AiSettings,
} from "../shared/ai-model.ts";

export class AiConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiConfigurationError";
  }
}

export async function getAiSettings(env: Env): Promise<AiSettings> {
  const saved = await env.DB.one<AiSettings>(
    "SELECT ai_provider, ai_base_url, ai_model FROM global_settings WHERE id = 1",
  );
  const parsed = parseAiSettings(saved ?? { ai_provider: "disabled" });
  if ("error" in parsed)
    throw new AiConfigurationError(
      "Invalid AI settings. Check Settings > General.",
    );
  return parsed.settings;
}

export function aiConfigurationError(
  env: Env,
  settings: AiSettings,
): string | null {
  if (settings.ai_provider === "disabled")
    return "AI is disabled. Select a provider in Settings > General.";
  if (settings.ai_provider === "workers-ai") {
    return env.AI
      ? null
      : "Workers AI is not configured on this server. Add the AI binding.";
  }
  return env.AI_API_KEY?.trim()
    ? null
    : "The external AI API key is not configured on this server. Add the AI_API_KEY secret.";
}

export async function requireAiSettings(
  env: Env,
): Promise<AiSettings & { ai_model: string }> {
  const settings = await getAiSettings(env);
  const error = aiConfigurationError(env, settings);
  if (error) throw new AiConfigurationError(error);
  return { ...settings, ai_model: settings.ai_model ?? DEFAULT_AI_MODEL };
}
