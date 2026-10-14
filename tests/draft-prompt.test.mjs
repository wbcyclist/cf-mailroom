import test from "node:test";
import assert from "node:assert/strict";
import { buildDraftPrompt, parseDraftOutput } from "../src/worker/agent/draft.ts";

const context = {
  subject: "Refund request",
  address: "support@example.com",
  agent_instructions: "Be warm.",
};
const inputs = {
  transcript: "From: customer@example.com\nI want a refund.",
  playbooks: [],
  attachments: [],
};

test("initial drafts carry no reviewer guidance", () => {
  const { system, prompt } = buildDraftPrompt(context, inputs);
  assert.doesNotMatch(system, /REVIEWER GUIDANCE/);
  assert.doesNotMatch(prompt, /CURRENT REPLY DRAFT/);
  assert.match(prompt, /^Subject: Refund request/);
});

test("revisions pass the instruction as trusted guidance and the composer text as the base", () => {
  const { system, prompt } = buildDraftPrompt(context, inputs, {
    instruction: "更简短，明确说不能退款",
    currentText: "Hi, thanks for reaching out about your refund.",
  });
  assert.match(system, /REVIEWER GUIDANCE[\s\S]*更简短，明确说不能退款/);
  assert.match(system, /Revise it according to the guidance/);
  assert.match(
    prompt,
    /I want a refund\.\n\n=== REVIEWER'S CURRENT REPLY DRAFT ===\nHi, thanks for reaching out about your refund\.\n=== END/,
  );
});

test("a revision without composer text drafts fresh from the instruction", () => {
  const { system, prompt } = buildDraftPrompt(context, inputs, {
    instruction: "Decline politely",
    currentText: "   ",
  });
  assert.match(system, /Decline politely/);
  assert.doesNotMatch(system, /Revise it according to the guidance/);
  assert.doesNotMatch(prompt, /CURRENT REPLY DRAFT/);
});

test("an empty revision still asks for a fresh version", () => {
  const { system } = buildDraftPrompt(context, inputs, {
    instruction: "",
    currentText: "Old reply",
  });
  assert.match(system, /No specific instruction; write a fresh, better version/);
});

test("a conversation that ends with our reply asks for a follow-up", () => {
  const { system } = buildDraftPrompt(context, { ...inputs, followUp: true }, {
    instruction: "Nudge them",
    currentText: "",
  });
  assert.match(system, /ends with our own reply\. Write a follow-up/);
  assert.doesNotMatch(system, /Write a reply to the latest message/);
});

test("parses the playbook header out of model output", () => {
  const playbook = { id: 3, name: "Refunds", when_to_use: "", instructions: "", example_reply: null };
  assert.deepEqual(parseDraftOutput("PLAYBOOK: 3\nREPLY:\nHello", [playbook]), {
    body: "Hello",
    playbook,
  });
});

test("large instructions and history leave room within the provider input limit", () => {
  const large = "x".repeat(100_000);
  const prompt = buildDraftPrompt({ ...context, subject: large, agent_instructions: large }, {
    transcript: large + "LATEST CUSTOMER MESSAGE",
    playbooks: Array.from({ length: 20 }, (_, id) => ({ id, name: large, when_to_use: large, instructions: large, example_reply: large })),
    attachments: Array.from({ length: 100 }, () => ({ filename: large, content_type: large, size: 1024 })),
  }, { instruction: large, currentText: large });
  assert.ok(prompt.system.length + prompt.prompt.length < 128_000);
  assert.match(prompt.prompt, /LATEST CUSTOMER MESSAGE/);
});
