import {
  OAuthProvider,
  type OAuthHelpers,
  type TokenSummary,
} from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { WorkerEntrypoint } from "cloudflare:workers";
import { authorizationHandler, type AuthorizationEnv } from "./authorization.ts";
import { MCP_READ_SCOPE, MCP_SEND_SCOPE, type OAuthGrantProps } from "./auth-types.ts";
import {
  isRejectedMcpRouteLookalike,
  MCP_ROUTE,
  MCP_TOKEN_ENDPOINT,
} from "./route.ts";
import { createMailroomServer, type McpEnv } from "./server.ts";

export interface McpWorkerEnv extends McpEnv, AuthorizationEnv {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  MCP_SEND_ENABLED?: string;
}

type WebHandler = {
  fetch(request: Request, env: McpWorkerEnv, ctx: ExecutionContext): Response | Promise<Response>;
};

class McpApiHandler extends WorkerEntrypoint<McpWorkerEnv, OAuthGrantProps> {
  async fetch(request: Request): Promise<Response> {
    const authorization = request.headers.get("Authorization");
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
    const origin = new URL(request.url).origin;
    const summary = token
      ? await this.env.OAUTH_PROVIDER.unwrapToken<OAuthGrantProps>(token)
      : null;
    if (!token || !summary) {
      return oauthError(origin, 401, "invalid_token", "Invalid access token");
    }
    if (!summary.scope.includes(MCP_READ_SCOPE)) {
      return oauthError(
        origin,
        403,
        "insufficient_scope",
        `The ${MCP_READ_SCOPE} scope is required`,
        MCP_READ_SCOPE,
      );
    }

    const props = this.ctx.props;
    if (
      props.clientId !== summary.grant.clientId ||
      props.sub !== summary.userId ||
      !sameScopes(props.scopes, summary.scope)
    ) {
      return oauthError(origin, 401, "invalid_token", "Access token context is inconsistent");
    }

    const identity = {
      email: props.email,
      sub: props.sub,
      clientId: summary.grant.clientId,
      canSend:
        summary.scope.includes(MCP_SEND_SCOPE) &&
        this.env.MCP_SEND_ENABLED !== "false",
    };
    const hostname = new URL(origin).hostname;
    const handler = createMcpHandler(
      () => createMailroomServer({ ...this.env, WEB_APP_URL: origin }, identity),
      {
        route: MCP_ROUTE,
        allowedHostnames: [hostname],
        allowedOriginHostnames: [hostname],
        legacy: "stateless",
        responseMode: "auto",
        authContext: { props },
      },
    );
    const resource = tokenResource(summary);
    return handler.fetch(request, {
      authInfo: {
        token,
        clientId: summary.grant.clientId,
        scopes: summary.scope,
        expiresAt: summary.expiresAt,
        ...(resource ? { resource } : {}),
        extra: { props },
      },
    });
  }
}

function sameScopes(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((scope) => right.includes(scope));
}

function tokenResource(summary: TokenSummary<OAuthGrantProps>): URL | undefined {
  const audience = Array.isArray(summary.audience) ? summary.audience[0] : summary.audience;
  if (!audience) return undefined;
  try {
    return new URL(audience);
  } catch {
    return undefined;
  }
}

function oauthError(
  origin: string,
  status: number,
  error: string,
  description: string,
  scope?: string,
): Response {
  const challenge = [
    'Bearer realm="Mailroom"',
    `error="${error}"`,
    `error_description="${description}"`,
    `resource_metadata="${origin}/.well-known/oauth-protected-resource${MCP_ROUTE}"`,
    ...(scope ? [`scope="${scope}"`] : []),
  ].join(", ");
  return Response.json(
    { error, error_description: description },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        "WWW-Authenticate": challenge,
      },
    },
  );
}

// The Worker can be reached on workers.dev and custom domains. Each origin is
// its own issuer and resource, so tokens stay bound to the hostname that issued them.
const oauthProviders = new Map<string, OAuthProvider<McpWorkerEnv>>();

function getOAuthProvider(origin: string, web: WebHandler): OAuthProvider<McpWorkerEnv> {
  const existing = oauthProviders.get(origin);
  if (existing) return existing;
  const oauthProvider = new OAuthProvider<McpWorkerEnv>({
  apiRoute: MCP_ROUTE,
  apiHandler: McpApiHandler,
  defaultHandler: {
    fetch(request, env, ctx) {
      return new URL(request.url).pathname === "/authorize"
        ? authorizationHandler.fetch!(request as Request<unknown, IncomingRequestCfProperties>, env, ctx)
        : web.fetch(request, env, ctx);
    },
  } satisfies ExportedHandler<McpWorkerEnv>,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: MCP_TOKEN_ENDPOINT,
  clientIdMetadataDocumentEnabled: false,
  scopesSupported: [MCP_READ_SCOPE, MCP_SEND_SCOPE],
  resourceMetadata: {
    // Production origins are always HTTPS. Local http://localhost dev derives
    // these per request because the provider only accepts HTTPS issuers.
    ...(origin.startsWith("https://")
      ? { resource: `${origin}${MCP_ROUTE}`, authorization_servers: [origin] }
      : {}),
    scopes_supported: [MCP_READ_SCOPE, MCP_SEND_SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "Mailroom",
  },
  accessTokenTTL: 15 * 60,
  refreshTokenTTL: 30 * 24 * 60 * 60,
  allowPlainPKCE: false,
  allowImplicitFlow: false,
  tokenExchangeCallback(options) {
    return {
      accessTokenProps: {
        ...options.props,
        clientId: options.clientId,
        scopes: options.requestedScope,
      } satisfies OAuthGrantProps,
    };
  },
  onError({ status, code, internal }) {
    console.warn("MCP OAuth error", {
      status,
      code,
      internalCategory: internal?.category,
      internalReason: internal?.reason,
    });
  },
  });
  oauthProviders.set(origin, oauthProvider);
  return oauthProvider;
}

/**
 * Serve MCP (`/mcp`), its OAuth endpoints, and owner consent (`/authorize`)
 * from the same Worker as the web app. Everything else goes to `web`.
 */
export function withMcp(web: WebHandler) {
  return (request: Request, env: Omit<McpWorkerEnv, "OAUTH_PROVIDER">, ctx: ExecutionContext) => {
    const url = new URL(request.url);
    if (isRejectedMcpRouteLookalike(url.pathname)) {
      return new Response("Not found", { status: 404 });
    }
    return getOAuthProvider(url.origin, web).fetch(request, env as McpWorkerEnv, ctx);
  };
}
