import test from "node:test";
import assert from "node:assert/strict";
import { parseAiSettings } from "../src/shared/ai-model.ts";
import { generateAiText } from "../src/worker/ai.ts";

const settings = {
  ai_provider: "openai-compatible",
  ai_base_url: "https://gateway.example/api/v1",
  ai_model: "test-model",
};
const prompt = {
  system: "Write a reply",
  prompt: "Hello",
  maxOutputTokens: 512,
};
const chat = (text = "Reply") => ({
  choices: [
    { finish_reason: "stop", message: { role: "assistant", content: text } },
  ],
});
const responses = (text = "Reply") => ({
  status: "completed",
  output: [
    { type: "reasoning", summary: [] },
    {
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text }],
    },
  ],
});
function env(config = settings) {
  return {
    DB: {
      async one() {
        return config;
      },
    },
    AI_API_KEY: "secret-test-key",
  };
}

test("AI configuration supports all providers and external model IDs", () => {
  assert.deepEqual(parseAiSettings(settings), { settings });
  assert.deepEqual(parseAiSettings({ ai_provider: "disabled" }), {
    settings: { ai_provider: "disabled", ai_base_url: null, ai_model: null },
  });
  assert.deepEqual(
    parseAiSettings({
      ai_provider: "workers-ai",
      ai_model: " @cf/meta/model ",
    }),
    {
      settings: {
        ai_provider: "workers-ai",
        ai_base_url: null,
        ai_model: "@cf/meta/model",
      },
    },
  );
  assert.ok(
    "settings" in
      parseAiSettings({ ...settings, ai_provider: "openai-responses" }),
  );
  for (const config of [
    null,
    [],
    {},
    { ...settings, ai_provider: "unknown" },
    { ...settings, ai_model: "" },
  ]) {
    assert.ok("error" in parseAiSettings(config));
  }
});

test("API roots require public HTTPS hostnames without credentials or endpoint suffixes", () => {
  for (const ai_base_url of [
    "http://api.example/v1",
    "https://user:key@api.example/v1",
    "https://api.example/v1?key=secret",
    "https://api.example/v1#fragment",
    "https://localhost/v1",
    "https://127.0.0.1/v1",
    "https://[::1]/v1",
    "https://host.local/v1",
    "https://api.example/v1/responses",
    "https://api.example/v1/chat/completions",
  ])
    assert.ok(
      "error" in parseAiSettings({ ...settings, ai_base_url }),
      ai_base_url,
    );
  assert.equal(
    parseAiSettings({ ...settings, ai_base_url: settings.ai_base_url + "///" })
      .settings.ai_base_url,
    settings.ai_base_url,
  );
});

test("Chat Completions preserves the API root and sends one bounded request", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls++;
    assert.equal(url, settings.ai_base_url + "/chat/completions");
    assert.equal(options.headers.Authorization, "Bearer secret-test-key");
    assert.equal(options.redirect, "error");
    assert.ok(options.signal instanceof AbortSignal);
    assert.deepEqual(JSON.parse(options.body), {
      model: "test-model",
      messages: [
        { role: "system", content: "Write a reply" },
        { role: "user", content: "Hello" },
      ],
      max_tokens: 512,
      stream: false,
      store: false,
    });
    return Response.json(chat());
  });
  assert.deepEqual(await generateAiText(env(), prompt), {
    text: "Reply",
    model: "test-model",
  });
  assert.equal(calls, 1);
});

test("Responses uses stateless instructions/input and reads typed output items", async (t) => {
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, settings.ai_base_url + "/responses");
    assert.deepEqual(JSON.parse(options.body), {
      model: "test-model",
      instructions: "Write a reply",
      input: "Hello",
      max_output_tokens: 512,
      stream: false,
      store: false,
    });
    return Response.json(responses());
  });
  assert.equal(
    (
      await generateAiText(
        env({ ...settings, ai_provider: "openai-responses" }),
        prompt,
      )
    ).text,
    "Reply",
  );
});

test("disabled or missing credentials fail before dispatch, without provider fallback", async (t) => {
  t.mock.method(globalThis, "fetch", () => assert.fail("Unexpected paid call"));
  for (const e of [
    env({ ai_provider: "disabled" }),
    { ...env(), AI_API_KEY: undefined },
    env({ ai_provider: "workers-ai" }),
  ]) {
    await assert.rejects(
      generateAiText(e, prompt),
      (error) => error.name === "AiConfigurationError",
    );
  }
});

test("provider errors are sanitized and never retried by the transport", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response("secret-test-key and private mail", { status: 429 });
  });
  await assert.rejects(generateAiText(env(), prompt), {
    message: "AI request failed (HTTP 429)",
  });
  assert.equal(calls, 1);
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("secret-test-key");
  });
  await assert.rejects(generateAiText(env(), prompt), {
    message: "AI request failed or timed out",
  });
});

test("Workers AI uses the binding with a token cap and no SDK retry", async () => {
  let calls = 0;
  const e = env({ ai_provider: "workers-ai", ai_model: "@cf/meta/test" });
  e.AI = {
    async run(model, input, options) {
      calls++;
      assert.equal(model, "@cf/meta/test");
      assert.equal(input.max_tokens, 512);
      assert.ok(options.signal instanceof AbortSignal);
      return { response: "Reply" };
    },
  };
  assert.equal((await generateAiText(e, prompt)).text, "Reply");
  assert.equal(calls, 1);
  calls = 0;
  e.AI.run = async () => {
    calls++;
    throw new Error("sensitive provider details");
  };
  await assert.rejects(generateAiText(e, prompt), {
    message: "AI request failed or timed out",
  });
  assert.equal(calls, 1);
});

test("oversized input is rejected before dispatch and timeout errors are sanitized", async (t) => {
  t.mock.method(globalThis, "fetch", () => assert.fail("Unexpected paid call"));
  await assert.rejects(
    generateAiText(env(), { ...prompt, prompt: "x".repeat(128_001) }),
    /input exceeds/,
  );
  t.mock.method(AbortSignal, "timeout", (ms) => {
    assert.equal(ms, 60_000);
    return AbortSignal.abort();
  });
  t.mock.method(globalThis, "fetch", async (url, options) => {
    options.signal.throwIfAborted();
  });
  await assert.rejects(generateAiText(env(), prompt), {
    message: "AI request failed or timed out",
  });
});

test("incomplete, refused, malformed, empty, and oversized outputs are rejected", async (t) => {
  for (const [provider, result] of [
    [
      "openai-compatible",
      {
        choices: [{ finish_reason: "length", message: { content: "Partial" } }],
      },
    ],
    [
      "openai-compatible",
      {
        choices: [
          {
            finish_reason: "stop",
            message: { content: "Text", refusal: "No" },
          },
        ],
      },
    ],
    ["openai-compatible", chat("")],
    ["openai-compatible", chat("x".repeat(300_000))],
    ["openai-responses", { ...responses(), status: "incomplete" }],
    [
      "openai-responses",
      {
        ...responses(),
        output: [
          { type: "message", content: [{ type: "refusal", refusal: "No" }] },
        ],
      },
    ],
    [
      "openai-responses",
      { output_text: "Do not use the SDK convenience field" },
    ],
  ]) {
    t.mock.method(globalThis, "fetch", async () => Response.json(result));
    await assert.rejects(
      generateAiText(env({ ...settings, ai_provider: provider }), prompt),
      /AI response/,
    );
  }
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response("<html>invalid</html>"),
  );
  await assert.rejects(generateAiText(env(), prompt), /AI response/);
});
