import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_AI_MODEL, parseAiModel } from "../src/shared/ai-model.ts";

test("the default AI model is a catalog slug", () => {
  assert.deepEqual(parseAiModel(DEFAULT_AI_MODEL), { model: "openai/gpt-6-luna" });
});

test("accepts Workers AI ids and third-party catalog slugs, trimmed", () => {
  assert.deepEqual(parseAiModel("  @cf/meta/llama-3.1-8b-instruct "), {
    model: "@cf/meta/llama-3.1-8b-instruct",
  });
  assert.deepEqual(parseAiModel("xai/grok-4.6"), { model: "xai/grok-4.6" });
  assert.deepEqual(parseAiModel("openrouter/anthropic/claude-x"), {
    model: "openrouter/anthropic/claude-x",
  });
});

test("empty values reset to the default", () => {
  for (const value of [null, undefined, "", "   "]) {
    assert.deepEqual(parseAiModel(value), { model: null });
  }
});

test("rejects values that are not model ids", () => {
  for (const value of ["openai/", "open ai/gpt", "openai/gpt?x=1", 42, "a/".repeat(150) + "b"]) {
    assert.ok("error" in parseAiModel(value), String(value));
  }
});

test("accepts external model IDs without a namespace", () => {
  assert.deepEqual(parseAiModel("test-model"), { model: "test-model" });
});
