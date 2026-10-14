import test from "node:test";
import assert from "node:assert/strict";
import {
  buildJevQuestions,
  labelNewThread,
  matchedLabelIds,
} from "../src/worker/email/label.ts";

const labels = [
  { id: 1, name: "guest-post", condition: "A guest post pitch" },
  { id: 2, name: "sponsor", condition: "A sponsorship offer" },
];

test("buildJevQuestions creates one noul question per label", () => {
  const questions = buildJevQuestions(labels);
  assert.deepEqual(Object.keys(questions).sort(), ["label_1", "label_2"]);
  const question = questions.label_1;
  assert.equal(question.type, "noul");
  assert.match(question.instructions, /guest-post/);
  assert.equal(question.criteria.true, "A guest post pitch");
  assert.match(question.criteria.false, /does not match/);
});

test("matchedLabelIds keeps labels at or above the match threshold", () => {
  const response = {
    answers: {
      label_1: { type: "noul", noul: 0.9 },
      label_2: { type: "noul", noul: 0.2 },
    },
  };
  assert.deepEqual(matchedLabelIds(labels, response), [1]);

  assert.deepEqual(
    matchedLabelIds(labels, {
      answers: { label_1: { noul: 0.5 }, label_2: { noul: 0.97 } },
    }),
    [1, 2],
  );
});

test("matchedLabelIds reads Cloudflare's completed result envelope", () => {
  assert.deepEqual(
    matchedLabelIds(labels, {
      state: "Completed",
      result: {
        model: "jev-1.13.0",
        answers: {
          label_1: { type: "noul", noul: 0.96 },
          label_2: { type: "noul", noul: 0.2 },
        },
      },
      gatewayMetadata: { keySource: "Unified" },
    }),
    [1],
  );
});

test("invalid responses fail visibly instead of silently matching nothing", () => {
  for (const response of [
    null,
    {},
    { answers: {} },
    { state: "Completed", result: null },
    { state: "Failed", result: { answers: { label_1: { noul: 1 } } } },
    { state: "Running" },
  ]) {
    assert.throws(
      () => matchedLabelIds(labels, response),
      /Invalid JEV response/,
    );
  }
  for (const noul of ["yes", null, NaN, Infinity, -0.1, 1.1]) {
    assert.throws(
      () =>
        matchedLabelIds(labels, {
          answers: { label_1: { noul }, label_2: { noul: 0 } },
        }),
      /Invalid JEV response/,
    );
  }
});

test("valid negative answers match nothing", () => {
  assert.deepEqual(
    matchedLabelIds(labels, {
      answers: { label_1: { noul: 0 }, label_2: { noul: 0.49 } },
    }),
    [],
  );
});

test("labelNewThread persists matches from a completed model response", async () => {
  const inserted = [];
  const env = {
    DB: {
      async one(sql, values) {
        assert.match(sql, /FROM messages msg/);
        assert.deepEqual(values, [42, 7]);
        return {
          subject: "Guest post",
          from_address: "sender@example.com",
          from_name: null,
          text_body: "Can I write a guest post?",
          mailbox_id: 2,
        };
      },
      async query(sql, values) {
        if (sql.includes("FROM labels")) {
          assert.deepEqual(values, [2]);
          return { rows: labels };
        }
        assert.match(sql, /INSERT INTO thread_labels/);
        inserted.push(values);
      },
    },
    AI: {
      async run(model, input) {
        assert.equal(model, "typesafe/jev");
        assert.equal(input.state.body, "Can I write a guest post?");
        assert.deepEqual(Object.keys(input.questions), ["label_1", "label_2"]);
        return {
          state: "Completed",
          result: {
            answers: {
              label_1: { type: "noul", noul: 0.96 },
              label_2: { type: "noul", noul: 0.1 },
            },
          },
        };
      },
    },
  };
  await labelNewThread(env, 7, 42);
  assert.deepEqual(inserted, [[7, 1]]);

  inserted.length = 0;
  env.AI.run = async () => ({
    state: "Completed",
    result: {
      answers: {
        label_1: { noul: 0.96 },
      },
    },
  });
  await assert.rejects(labelNewThread(env, 7, 42), /Invalid JEV response/);
  assert.deepEqual(inserted, []);
});
