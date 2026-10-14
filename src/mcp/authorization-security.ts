import { type Database } from "../worker/database.ts";
import type { AuthRequest } from "@cloudflare/workers-oauth-provider";

export interface AuthorizationSubmissionOptions {
  expectedOrigin: string;
  maxBodyBytes: number;
}

export interface AuthorizationSubmission {
  form: URLSearchParams;
  transactionToken: string;
}

export interface AuthorizationTransactionClock {
  nowSeconds?: number;
  ttlSeconds?: number;
}

export type AuthorizationSubmissionErrorCode =
  | "invalid_content_type"
  | "body_too_large"
  | "invalid_transaction"
  | "invalid_source";

export class AuthorizationSubmissionError extends Error {
  readonly code: AuthorizationSubmissionErrorCode;
  readonly status: number;

  constructor(code: AuthorizationSubmissionErrorCode, status: number) {
    super(code);
    this.name = "AuthorizationSubmissionError";
    this.code = code;
    this.status = status;
  }
}

export const AUTHORIZATION_TRANSACTION_TTL_SECONDS = 10 * 60;

/**
 * Validates the complete browser-to-consent POST boundary.
 *
 * An exact browser Origin is required. The consent response deliberately uses
 * `Referrer-Policy: strict-origin`; using `no-referrer` would make browsers
 * serialize the form POST Origin as `null`.
 *
 * The opaque transaction token is only a lookup credential. Its one-time use,
 * owner binding, expiration, and OAuth request binding are enforced atomically
 * by `consumeAuthorizationTransaction`.
 */
export async function parseAuthorizationSubmission(
  request: Request,
  options: AuthorizationSubmissionOptions,
): Promise<AuthorizationSubmission> {
  const contentType = request.headers
    .get("Content-Type")
    ?.split(";", 1)[0]
    ?.trim();
  if (contentType !== "application/x-www-form-urlencoded") {
    throw new AuthorizationSubmissionError("invalid_content_type", 400);
  }

  const formBody = await request.text();
  if (new TextEncoder().encode(formBody).byteLength > options.maxBodyBytes) {
    throw new AuthorizationSubmissionError("body_too_large", 400);
  }

  const form = new URLSearchParams(formBody);
  const transactionToken = form.get("authorization_transaction");
  if (!transactionToken || !/^[0-9a-f]{64}$/.test(transactionToken)) {
    throw new AuthorizationSubmissionError("invalid_transaction", 400);
  }

  if (!hasTrustedSubmissionSource(request, options.expectedOrigin)) {
    throw new AuthorizationSubmissionError("invalid_source", 403);
  }

  return { form, transactionToken };
}

/**
 * Creates an opaque, short-lived consent transaction. Only the SHA-256 digest
 * of the browser-visible token is stored. The request snapshot includes every
 * parsed OAuth value used by completeAuthorization: response type, client,
 * redirect, state, scopes, PKCE, resource indicator, and issuer.
 */
export async function createAuthorizationTransaction(
  db: Database,
  ownerSub: string,
  request: AuthRequest,
  clock: AuthorizationTransactionClock = {},
): Promise<string> {
  const now = clock.nowSeconds ?? currentUnixTime();
  const ttl = clock.ttlSeconds ?? AUTHORIZATION_TRANSACTION_TTL_SECONDS;
  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const requestJson = serializeAuthorizationRequest(request);

  // Opportunistic bounded cleanup keeps abandoned and consumed rows from
  // accumulating without putting cleanup on the security-critical UPDATE.
  await db.query(
    "DELETE FROM oauth_authorization_transactions WHERE expires_at <= $1",
    [now],
  );
  await db.query(
    `INSERT INTO oauth_authorization_transactions
      (token_hash, owner_sub, auth_request_json, created_at, expires_at)
      VALUES ($1, $2, $3, $4, $5)`,
    [tokenHash, ownerSub, requestJson, now, now + ttl],
  );

  return token;
}

/**
 * Atomically consumes a consent transaction. A token is accepted only once,
 * before its expiry, by the same Access subject, and for the exact parsed OAuth
 * request that produced the consent screen.
 */
export async function consumeAuthorizationTransaction(
  db: Database,
  transactionToken: string,
  ownerSub: string,
  request: AuthRequest,
  clock: Pick<AuthorizationTransactionClock, "nowSeconds"> = {},
): Promise<boolean> {
  const now = clock.nowSeconds ?? currentUnixTime();
  const tokenHash = await sha256Hex(transactionToken);
  const requestJson = serializeAuthorizationRequest(request);
  const result = await db.query(
    `UPDATE oauth_authorization_transactions
      SET consumed_at = $1
      WHERE token_hash = $2
        AND owner_sub = $3
        AND auth_request_json = $4
        AND consumed_at IS NULL
        AND expires_at > $5`,
    [now, tokenHash, ownerSub, requestJson, now],
  );

  return result.rowCount === 1;
}

export function serializeAuthorizationRequest(request: AuthRequest): string {
  return JSON.stringify({
    responseType: request.responseType,
    clientId: request.clientId,
    redirectUri: request.redirectUri,
    state: request.state,
    scope: [...request.scope],
    codeChallenge: request.codeChallenge ?? null,
    codeChallengeMethod: request.codeChallengeMethod ?? null,
    resource: Array.isArray(request.resource)
      ? [...request.resource]
      : (request.resource ?? null),
    issuer: request.issuer ?? null,
  });
}

function hasTrustedSubmissionSource(
  request: Request,
  expectedOrigin: string,
): boolean {
  if (new URL(request.url).origin !== expectedOrigin) return false;

  const origin = parseSourceOrigin(request.headers.get("Origin"));
  if (origin === "invalid" || origin !== expectedOrigin) return false;

  const referer = parseSourceOrigin(request.headers.get("Referer"));
  if (referer === "invalid" || (referer && referer !== expectedOrigin))
    return false;

  const fetchSite = request.headers.get("Sec-Fetch-Site")?.trim().toLowerCase();
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none")
    return false;

  return true;
}

function parseSourceOrigin(value: string | null): string | null | "invalid" {
  if (!value || value.trim().toLowerCase() === "null") return null;
  try {
    return new URL(value).origin;
  } catch {
    return "invalid";
  }
}

function currentUnixTime(): number {
  return Math.floor(Date.now() / 1000);
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
