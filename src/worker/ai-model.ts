import { DEFAULT_AI_MODEL } from "../shared/ai-model.ts";

/** The workspace language model that text-generation AI features should call. */
export async function getAiModel(env: Env): Promise<string> {
  const settings = await env.DB.one<{ ai_model: string | null }>(
    "SELECT ai_model FROM global_settings WHERE id = 1",
  );
  return settings?.ai_model || DEFAULT_AI_MODEL;
}
