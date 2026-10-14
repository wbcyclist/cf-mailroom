/** Default text model when Workers AI is selected. */
export const DEFAULT_AI_MODEL = "openai/gpt-6-luna";
export const AI_MODEL_CATALOG_URL =
  "https://developers.cloudflare.com/ai/models/";
export const DEFAULT_AI_BASE_URL = "https://api.openai.com/v1";
export const AI_PROVIDERS = [
  "disabled",
  "workers-ai",
  "openai-compatible",
  "openai-responses",
] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];
export interface AiSettings {
  ai_provider: AiProvider;
  ai_base_url: string | null;
  ai_model: string | null;
}

const MAX_MODEL_ID_CHARS = 200;
const MODEL_ID_PATTERN = /^@?[A-Za-z0-9][\w.:-]*(\/[\w.:-]+)*$/;

/** Returns the normalized model id, null to use the default, or an error message. */
export function parseAiModel(
  value: unknown,
): { model: string | null } | { error: string } {
  if (value === null || value === undefined) return { model: null };
  if (typeof value !== "string") return { error: "The model must be text" };
  const model = value.trim();
  if (!model) return { model: null };
  if (model.length > MAX_MODEL_ID_CHARS || !MODEL_ID_PATTERN.test(model)) {
    return {
      error:
        "Enter a model ID with at most 200 letters, digits, dots, slashes, colons, underscores, or hyphens",
    };
  }
  return { model };
}

export function parseAiSettings(
  value: unknown,
): { settings: AiSettings } | { error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: "Invalid AI settings" };
  }
  const body = value as Record<string, unknown>;
  if (!AI_PROVIDERS.includes(body.ai_provider as AiProvider)) {
    return { error: "Select a supported AI provider" };
  }
  const provider = body.ai_provider as AiProvider;
  if (provider === "disabled") {
    return {
      settings: { ai_provider: provider, ai_base_url: null, ai_model: null },
    };
  }
  const parsed = parseAiModel(body.ai_model);
  if ("error" in parsed) return parsed;
  if (provider === "workers-ai") {
    return {
      settings: {
        ai_provider: provider,
        ai_base_url: null,
        ai_model: parsed.model,
      },
    };
  }
  if (!parsed.model) return { error: "Enter the external provider's model ID" };
  try {
    if (typeof body.ai_base_url !== "string" || body.ai_base_url.length > 2048)
      throw new Error();
    const url = new URL(body.ai_base_url.trim());
    const host = url.hostname.replace(/\.$/, "");
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !host.includes(".") ||
      /^[\d.]+$/.test(host) ||
      host.includes(":") ||
      /\.(localhost|local|internal)$/.test(host)
    )
      throw new Error();
    url.pathname = url.pathname.replace(/\/+$/, "");
    if (/\/(responses|chat\/completions)$/.test(url.pathname)) {
      return {
        error:
          "Enter the API root, such as https://api.openai.com/v1, without the endpoint path",
      };
    }
    return {
      settings: {
        ai_provider: provider,
        ai_model: parsed.model,
        ai_base_url: url.toString().replace(/\/+$/, ""),
      },
    };
  } catch {
    return {
      error:
        "Use an HTTPS API root with a public hostname and no credentials, query, or fragment",
    };
  }
}
