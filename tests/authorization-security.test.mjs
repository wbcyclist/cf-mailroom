import { databaseFixture } from "./helpers/postgres.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import {
  AuthorizationSubmissionError,
  consumeAuthorizationTransaction,
  createAuthorizationTransaction,
  parseAuthorizationSubmission,
  serializeAuthorizationRequest,
} from "../src/mcp/authorization-security.ts";

const ORIGIN = "https://mcp.example.com";
const TRANSACTION = "0123456789abcdef".repeat(4);
const AUTH_REQUEST = {
  responseType: "code",
  clientId: "slim-client",
  redirectUri: "https://slim.tools/api/oauth/callback",
  scope: ["inbox.read", "inbox.send"],
  state: "client-state",
  codeChallenge: "pkce-challenge",
  codeChallengeMethod: "S256",
  resource: ["https://mcp.example.com/mcp"],
  issuer: "https://mcp.example.com",
};

function submission(
  headers = {},
  { transaction = TRANSACTION, url = `${ORIGIN}/authorize` } = {},
) {
  return new Request(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...headers,
    },
    body: new URLSearchParams({
      authorization_transaction: transaction,
      decision: "approve",
    }),
  });
}

function parse(request) {
  return parseAuthorizationSubmission(request, {
    expectedOrigin: ORIGIN,
    maxBodyBytes: 4096,
  });
}

async function rejectsWith(request, code) {
  await assert.rejects(parse(request), (error) => {
    assert.ok(error instanceof AuthorizationSubmissionError);
    assert.equal(error.code, code);
    return true;
  });
}

test("accepts an exact same-origin form POST without a cookie", async (t) => {
  const parsed = await parse(
    submission({ Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" }),
  );
  assert.equal(parsed.form.get("decision"), "approve");
  assert.equal(parsed.transactionToken, TRANSACTION);
});

test("accepts a normalized same-origin Origin", async (t) => {
  await parse(submission({ Origin: `${ORIGIN}/` }));
});

test("rejects explicit cross-origin browser signals", async (t) => {
  await rejectsWith(submission(), "invalid_source");
  await rejectsWith(submission({ Origin: "null" }), "invalid_source");
  await rejectsWith(
    submission({ Origin: "https://attacker.example" }),
    "invalid_source",
  );
  await rejectsWith(
    submission({ Origin: ORIGIN, Referer: "https://attacker.example/form" }),
    "invalid_source",
  );
  await rejectsWith(
    submission({ Origin: ORIGIN, "Sec-Fetch-Site": "cross-site" }),
    "invalid_source",
  );
  await rejectsWith(
    submission(
      { Origin: ORIGIN },
      { url: "https://attacker.example/authorize" },
    ),
    "invalid_source",
  );
});

test("rejects missing and malformed transaction tokens", async (t) => {
  await rejectsWith(
    submission({ Origin: ORIGIN }, { transaction: "wrong" }),
    "invalid_transaction",
  );

  const missing = new Request(`${ORIGIN}/authorize`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: ORIGIN,
    },
    body: new URLSearchParams({ decision: "approve" }),
  });
  await rejectsWith(missing, "invalid_transaction");
});

test("rejects unsupported content types and oversized forms", async (t) => {
  const wrongType = submission();
  wrongType.headers.set("Content-Type", "application/json");
  await rejectsWith(wrongType, "invalid_content_type");

  const oversized = submission();
  await assert.rejects(
    parseAuthorizationSubmission(oversized, {
      expectedOrigin: ORIGIN,
      maxBodyBytes: 8,
    }),
    (error) =>
      error instanceof AuthorizationSubmissionError &&
      error.code === "body_too_large",
  );
});

test("request snapshots bind all values used to complete authorization", () => {
  assert.deepEqual(JSON.parse(serializeAuthorizationRequest(AUTH_REQUEST)), {
    responseType: "code",
    clientId: "slim-client",
    redirectUri: "https://slim.tools/api/oauth/callback",
    state: "client-state",
    scope: ["inbox.read", "inbox.send"],
    codeChallenge: "pkce-challenge",
    codeChallengeMethod: "S256",
    resource: ["https://mcp.example.com/mcp"],
    issuer: "https://mcp.example.com",
  });
});

test("a matching authorization transaction can be consumed exactly once", async (t) => {
  const db = await databaseFixture(t);
  const token = await createAuthorizationTransaction(
    db,
    "access-sub",
    AUTH_REQUEST,
    {
      nowSeconds: 1_000,
    },
  );

  assert.equal(
    await consumeAuthorizationTransaction(
      db,
      token,
      "access-sub",
      AUTH_REQUEST,
      {
        nowSeconds: 1_001,
      },
    ),
    true,
  );
  assert.equal(
    await consumeAuthorizationTransaction(
      db,
      token,
      "access-sub",
      AUTH_REQUEST,
      {
        nowSeconds: 1_002,
      },
    ),
    false,
  );
});

test("authorization transactions reject a different owner or OAuth request", async (t) => {
  const db = await databaseFixture(t);
  const ownerToken = await createAuthorizationTransaction(
    db,
    "access-sub",
    AUTH_REQUEST,
    {
      nowSeconds: 2_000,
    },
  );
  assert.equal(
    await consumeAuthorizationTransaction(
      db,
      ownerToken,
      "other-sub",
      AUTH_REQUEST,
      {
        nowSeconds: 2_001,
      },
    ),
    false,
  );

  const requestToken = await createAuthorizationTransaction(
    db,
    "access-sub",
    AUTH_REQUEST,
    {
      nowSeconds: 2_000,
    },
  );
  assert.equal(
    await consumeAuthorizationTransaction(
      db,
      requestToken,
      "access-sub",
      { ...AUTH_REQUEST, state: "different-state" },
      { nowSeconds: 2_001 },
    ),
    false,
  );
});

test("authorization transactions expire after ten minutes", async (t) => {
  const db = await databaseFixture(t);
  const token = await createAuthorizationTransaction(
    db,
    "access-sub",
    AUTH_REQUEST,
    {
      nowSeconds: 3_000,
    },
  );
  assert.equal(
    await consumeAuthorizationTransaction(
      db,
      token,
      "access-sub",
      AUTH_REQUEST,
      {
        nowSeconds: 3_600,
      },
    ),
    false,
  );
});
