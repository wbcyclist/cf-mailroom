import { generateText } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { requireAiSettings } from "./ai-model.ts";
import { claimAiBudget } from "./usage-budget.ts";

const TIMEOUT_MS = 60_000;
const MAX_INPUT_CHARS = 128_000;
const MAX_RESPONSE_BYTES = 256_000;

export class AiRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiRequestError";
  }
}

interface TextPrompt {
  system: string;
  prompt: string;
  maxOutputTokens: number;
}

/** One paid request. The caller must explicitly request another attempt. */
export async function generateAiText(
  env: Env,
  prompt: TextPrompt,
): Promise<{ text: string; model: string }> {
  const settings = await requireAiSettings(env);
  if (prompt.system.length + prompt.prompt.length > MAX_INPUT_CHARS) {
    throw new AiRequestError("AI input exceeds the 128,000 character limit");
  }
  if (
    !Number.isInteger(prompt.maxOutputTokens) ||
    prompt.maxOutputTokens < 1 ||
    prompt.maxOutputTokens > 4096
  ) {
    throw new AiRequestError("Invalid AI output limit");
  }
  await claimAiBudget(env);
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  const model = settings.ai_model;
  try {
    if (settings.ai_provider === "workers-ai") {
      const result = await generateText({
        model: createWorkersAI({ binding: env.AI! })(model),
        ...prompt,
        maxRetries: 0,
        abortSignal: signal,
      });
      if (
        result.finishReason === "length" ||
        result.finishReason === "content-filter"
      ) {
        throw new AiRequestError("AI response was incomplete or refused");
      }
      return { text: requireText(result.text), model };
    }

    const responses = settings.ai_provider === "openai-responses";
    // Native non-streaming requests keep provider-specific SDK defaults and
    // retries out of this transport. Both endpoints have a small text contract.
    const response = await fetch(
      `${settings.ai_base_url}/${responses ? "responses" : "chat/completions"}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.AI_API_KEY!.trim()}`,
        },
        // Workers does not support "error". Reject 3xx below without forwarding the key.
        redirect: "manual",
        signal,
        body: JSON.stringify({
          model,
          ...(responses
            ? {
                instructions: prompt.system,
                input: prompt.prompt,
                max_output_tokens: prompt.maxOutputTokens,
              }
            : {
                messages: [
                  { role: "system", content: prompt.system },
                  { role: "user", content: prompt.prompt },
                ],
                max_tokens: prompt.maxOutputTokens,
              }),
          stream: false,
          store: false,
        }),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new AiRequestError(`AI request failed (HTTP ${response.status})`);
    }
    const body = await readResponse(response);
    return { text: responses ? responsesText(body) : chatText(body), model };
  } catch (error) {
    // Provider errors can contain the full request, key, or response body.
    if (error instanceof AiRequestError) throw error;
    throw new AiRequestError("AI request failed or timed out");
  }
}

async function readResponse(response: Response): Promise<unknown> {
  if (!response.body) throw new AiRequestError("AI response was empty");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES)
        throw new AiRequestError("AI response exceeds the size limit");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new AiRequestError("AI response was not valid JSON");
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function chatText(body: unknown): string {
  const choices = record(body).choices;
  const choice = record(Array.isArray(choices) ? choices[0] : null);
  const message = record(choice.message);
  if (choice.finish_reason !== "stop" || message.refusal) {
    throw new AiRequestError("AI response was incomplete or refused");
  }
  return requireText(message.content);
}

function responsesText(body: unknown): string {
  const response = record(body);
  if (response.status !== "completed" || !Array.isArray(response.output)) {
    throw new AiRequestError("AI response did not complete");
  }
  const parts: string[] = [];
  for (const item of response.output) {
    const message = record(item);
    if (message.type !== "message") continue;
    if (
      message.role !== "assistant" ||
      message.status !== "completed" ||
      !Array.isArray(message.content)
    ) {
      throw new AiRequestError("AI response contains an incomplete message");
    }
    for (const value of message.content) {
      const part = record(value);
      if (part.type !== "output_text")
        throw new AiRequestError(
          "AI response was refused or contains unsupported content",
        );
      parts.push(requireText(part.text));
    }
  }
  return requireText(parts.join("\n"));
}

function requireText(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 64_000) {
    throw new AiRequestError("AI response contains no usable text");
  }
  return value.trim();
}
