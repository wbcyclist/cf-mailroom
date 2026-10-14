import assert from "node:assert/strict";
import test from "node:test";
import { isReplyAttribution, splitQuotedTail } from "../src/shared/quote.ts";

test("recognizes long reply headers containing sender names and addresses", () => {
  const header = 'On Mon, 14 Sep 2026 22:05:32 +0000, "mcpservers.org — Server Submission Review Team" <contact@mcpservers.org> wrote:';
  assert.deepEqual(splitQuotedTail(`Please retain the existing listing.\n\n${header}\nOriginal email`), {
    main: "Please retain the existing listing.",
    quoted: `${header}\nOriginal email`,
  });
});

test("recognizes attribution text split across HTML whitespace", () => {
  assert.equal(isReplyAttribution("On Mon, 14 Sep 2026\n  Sender <sender@example.com> wrote:"), true);
  assert.equal(isReplyAttribution("On this topic we wrote: a new proposal."), false);
});

test("leaves quote-only messages and inline replies readable", () => {
  for (const body of ["> Only quoted text", "On Monday, someone wrote:\n> Original", "A reply\n> A question\nAn inline answer"]) {
    assert.deepEqual(splitQuotedTail(body), { main: body, quoted: null });
  }
});

test("still splits a trailing run of quoted lines", () => {
  assert.deepEqual(splitQuotedTail("New reply\n\n> Old message\n> More history"), {
    main: "New reply",
    quoted: "> Old message\n> More history",
  });
});

test("inline replies scan each line a bounded number of times", t => {
  const lines = 500;
  const body = '> quoted\n'.repeat(lines) + 'Keep this inline answer';
  const trim = String.prototype.trim;
  let scans = 0;
  t.mock.method(String.prototype, 'trim', function () {
    if (++scans > lines * 8) throw new Error('Quote scan exceeded linear work');
    return trim.call(this);
  });
  assert.deepEqual(splitQuotedTail(body), { main: body, quoted: null });
});
