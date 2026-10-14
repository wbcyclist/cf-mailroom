# Deploy your own Mailroom

This version uses a fresh PostgreSQL database. The runtime path is
**Cloudflare Worker → Hyperdrive → VPS PostgreSQL**. All former D1 business
records, raw MIME, and attachments use PostgreSQL; no D1 or R2 binding is needed.
OAuth clients, grants, and tokens still use `OAUTH_KV`, as required by the OAuth
provider. Queues, Email Service, and Access remain on Cloudflare. Workers AI is
optional; external AI providers can handle both drafts and labels.

## Before you start

- A GitHub account, a Cloudflare account, and a domain using Cloudflare DNS.
- Workers Paid for outbound Email Sending and access to Hyperdrive.
- PostgreSQL 17 or 18 with persistent storage, verified TLS, and backups.
- Network access from Hyperdrive to PostgreSQL. Use the
  [Hyperdrive networking guide](https://developers.cloudflare.com/hyperdrive/configuration/firewall-and-networking-configuration/)
  or a supported private network connection. Keep PostgreSQL authenticated;
  do not allow unauthenticated Internet access.
- A Cloudflare Zero Trust team for protecting the web app with Access.

Cloudflare compute, AI, queues, OAuth KV, and email usage still belong to your
account. Moving storage does not cap those services' usage. PostgreSQL disk,
WAL, backups, and network traffic belong to your VPS setup.

## 1. Configure storage and the first build

### Create a fresh database

Connect to PostgreSQL as an administrator. Replace the sample passwords:

```sql
CREATE ROLE mailroom_migrator LOGIN PASSWORD 'REPLACE_WITH_MIGRATION_PASSWORD';
CREATE ROLE mailroom_app LOGIN PASSWORD 'REPLACE_WITH_RUNTIME_PASSWORD';
CREATE DATABASE mailroom OWNER mailroom_migrator;
ALTER ROLE mailroom_app SET statement_timeout = '30s';
ALTER ROLE mailroom_app SET lock_timeout = '10s';
ALTER ROLE mailroom_app SET idle_in_transaction_session_timeout = '30s';
```

Put the direct migration connection URL in a local ignored `.env` file, using
[`.env.example`](../.env.example) as a template. URL-encode special characters in
passwords. The migration role owns schema objects; the Worker uses the separate
runtime role. Use a trusted certificate and `sslmode=verify-full`.

```sh
npm ci
npm run db:migrate
```

Migrations run only from `migrations/postgres/`. Files in the parent `migrations/`
directory are the historical SQLite schema and are never applied to PostgreSQL.
The migration runner uses a PostgreSQL advisory lock and a transaction. It records
checksums, skips applied files, and stops if an applied file was edited.

Then connect to the `mailroom` database as its owner or an administrator:

```sql
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO mailroom_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO mailroom_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO mailroom_app;
REVOKE ALL ON schema_migrations FROM mailroom_app;
ALTER DEFAULT PRIVILEGES FOR ROLE mailroom_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO mailroom_app;
ALTER DEFAULT PRIVILEGES FOR ROLE mailroom_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO mailroom_app;
```

### Create Hyperdrive with query caching disabled

Set `HYPERDRIVE_DATABASE_URL` in your shell to the connection URL for
`mailroom_app`, then create the binding:

```sh
npx wrangler login
npx wrangler hyperdrive create mailroom-postgres \
  --connection-string "$HYPERDRIVE_DATABASE_URL" \
  --sslmode verify-full \
  --caching-disabled \
  --origin-connection-limit 10
```

Copy the returned ID into `wrangler.jsonc` → `hyperdrive[0].id`, replacing the
all-zero placeholder. The origin connection limit is a soft limit; size it for
your VPS and reserve connections for migrations and administration. Set an
appropriate PostgreSQL connection limit as well.

**Keep query caching disabled.** Inbox reads, send attempts, and authorization
transactions need fresh data. Hyperdrive writes do not invalidate cached query
results. See [query caching](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/).

The Worker creates a request-scoped `pg` pool with at most three clients and
closes it after its background work. Hyperdrive owns the shared origin pool.
Binary file contents are selected only for downloads, not conversation lists.
Inbound raw messages are limited to 25 MiB. Outbound attachments keep the existing
3 MiB total limit. Full-text search indexes the subject and first 20,000 body
characters with PostgreSQL's `simple` dictionary; search syntax uses
`websearch_to_tsquery` rather than SQLite FTS5 operators.

### Connect GitHub to Workers Builds

Create the two queues if the import flow has not created them:

```sh
npx wrangler queues create mailroom-drafts
npx wrangler queues create mailroom-drafts-dlq
```

Connect the repository in **Workers & Pages → Create → Import a repository**.
Use `main` as the production branch, leave the build command empty, and set the
deploy command to `npm run deploy`.

Add `DATABASE_URL` as a **build secret**, with the migration role's direct URL.
The build runner must be able to reach PostgreSQL and trust its TLS certificate.
This variable is for the Node migration script; do not add it to `vars`, prefix
it with `VITE_`, or expose it to the frontend. Hyperdrive holds the runtime
credentials. If the database is private, run migrations from a trusted network
before release and configure the build deploy command as
`node scripts/check-database-config.mjs && npm run build && node scripts/deploy.mjs`.

Review the bindings: `HYPERDRIVE`, `EMAIL`, `DRAFT_QUEUE`, `DRAFT_DLQ`, and
`OAUTH_KV`. The queue consumer and dead-letter names must match their producers.
The ID-less OAuth KV binding is provisioned by Wrangler. Outbound sending also
requires domain onboarding; a binding alone does not authorize a sender. The
`AI` binding is optional and absent from the default configuration.

Push the completed configuration to trigger the first build. The default deploy
command builds the app, applies pending PostgreSQL migrations, then uploads the
Worker and assets. It also provisions missing VAPID keys. Continue below before
routing real mail to the Worker.

## 2. Protect the web app before adding email

The web app uses Cloudflare Access for login and verifies its JWT on every API
request. Until that is configured, opening
`https://<worker>.<account>.workers.dev` shows a setup screen instead of the
inbox; the API denies every request. Do this step before registering an Inbox
or routing mail.

1. In [**Workers & Pages**](https://dash.cloudflare.com/?to=/:account/workers-and-pages)
   **→ your Worker → Access**, select **Enable access** under **Worker
   policies**. Choose **All traffic** and the **Cloudflare account** policy
   so only members of your account can sign in. Zero Trust must be enabled on
   the account (the free plan is enough). This protects every hostname of the
   Worker: `workers.dev`, custom domains, and previews.
2. Reload the app and sign in. The setup screen now shows the exact
   `WEB_ACCESS_TEAM_DOMAIN` and `WEB_ACCESS_AUD` values taken from your sign-in.
   Add both as **Text** variables in the Worker's **Settings → Variables and
   Secrets**.

   These values are not secrets. `keep_vars: true` preserves dashboard variables
   during Git-triggered deployments. Alternatively, define them in your instance's
   `wrangler.jsonc` `vars` object. Missing or invalid configuration fails closed.
3. Select **Check again**. The inbox opens once the Worker verifies your sign-in
   against those values.

`wrangler.jsonc` keeps `preview_urls` off; Worker-level Access would cover them,
but there is no reason to publish extra hostnames. A custom domain is optional;
list it in `routes` so it survives the next deploy. If you protect individual
hostnames with Self-hosted applications instead of the Worker-level toggle, put
every hostname in the **same** application so they share one AUD.

See [Cloudflare Access for Workers](https://developers.cloudflare.com/workers/configuration/cloudflare-access/).
Access protects HTTP requests; it does not require inbound email or queue
events to sign in.

`npm run dev` selects `src/worker/dev.ts`, which skips JWT verification against
local test data; same-origin write checks still apply. Production selects
`src/worker/index.ts` and has no environment-variable or request-header bypass.
Do not deploy `wrangler.dev.jsonc` or expose the local dev server publicly.

## 3. Connect your email domain

1. Enable **Email Routing** for the receiving domain and install the DNS records
   Cloudflare requests. Check existing mail hosting before changing MX records.
   Do not point a routing rule at the Worker yet.
2. Enable **Email Sending** in Email Service and onboard the sender domain,
   completing the DNS verification shown by Cloudflare. The `EMAIL` Worker
   binding alone does not verify a domain or grant sending access.
3. In Mailroom **Settings**, add an Inbox such as `support@example.com`. For a
   new domain, the dialog asks you to confirm Email Routing is enabled and Email
   Sending is active before it saves the Inbox. Leave **Draft replies to new
   messages** off until delivery looks right. Turning it on writes a draft for
   your approval; nothing is sent automatically.
4. Then point that address (or a catch-all rule) at your deployed Worker using
   **Send to Worker**. Unknown recipient addresses are rejected, so a rule that
   exists before the Inbox bounces mail. A catch-all does not create Inboxes.
5. Send a message from an external mailbox, confirm it appears in the app, then
   reply and verify delivery back to that mailbox.

Repeat for additional addresses or domains; they can share the same Worker.

## Optional: configure AI

AI is disabled by default. In **Settings → General → AI**, select a provider,
enter its settings, and save. This global setting controls drafts, revisions,
and automatic labels. Inbox drafting switches still control automatic drafts.
Manual reading, writing, attachments, and MCP tools do not need an AI provider.

| Provider | Settings | Runtime requirement |
| --- | --- | --- |
| Disabled | None | No AI calls or new draft jobs |
| Cloudflare Workers AI | Optional draft model; empty uses `openai/gpt-6-luna` | `AI` binding |
| OpenAI-compatible · Chat Completions | HTTPS API root and model ID | `AI_API_KEY` Worker secret |
| OpenAI Responses API | HTTPS API root and model ID | `AI_API_KEY` Worker secret |

### External API

1. Add `AI_API_KEY` under **Worker → Settings → Variables and Secrets**, with type
   **Secret**. This is a runtime secret, not a build variable. It is used as a
   Bearer token. Do not put it in PostgreSQL, `wrangler.jsonc`, a URL, or `VITE_*`.
2. Select the API type. For OpenAI, use `https://api.openai.com/v1` as the Base URL.
   For another provider, use its API root, including any required version prefix.
   Do not include `/chat/completions` or `/responses`; Mailroom appends that path.
3. Enter an exact model ID supported by that endpoint. The same model generates
   drafts and classifies labels. There is no automatic fallback to Workers AI.
4. Save, then enable drafting for the required Inboxes. Creating label rules
   enables classification of new conversations, even if inbox drafting is off.

The Base URL must use a public HTTPS hostname. URL credentials, query strings,
fragments, IP literals, and redirects are rejected. The Worker also uses
`global_fetch_strictly_public` to block private network destinations. Changing
providers does not change the secret; replace it when the new provider requires
a different key. Only key availability is returned to the settings page.

Chat Completions sends `messages` and `max_tokens`. Use a model that accepts those
fields; models that require Responses should use the Responses option instead.
Responses sends `instructions`, `input`, and `max_output_tokens`, and reads typed
`output` items. Both requests use `store: false`; the provider must honor it.
See the [OpenAI API migration guide](https://developers.openai.com/api/docs/guides/migrate-to-responses).

For local development, set `AI_API_KEY` in the ignored `.dev.vars` file and restart
Vite. The local configuration does not require a Workers AI binding.

### Workers AI

Add the following top-level property to `wrangler.jsonc`, then release through
the normal Git build. Select **Cloudflare Workers AI** after deployment:

```json
"ai": { "binding": "AI" }
```

Workers AI uses the selected text model for drafts and `typesafe/jev` for labels.
Missing bindings or secrets produce a setup message and prevent AI calls.

### Request limits and failures

- Text calls have a 60-second timeout, at most 128,000 input characters, and at
  most 4,096 output tokens for drafts or 2,048 for external label classification.
  External response bodies are limited to 256,000 bytes. Truncated, refused, or
  malformed output is not saved as a draft or as labels.
- Each new conversation evaluates at most 20 label rules and 8,000 body characters.
  Label failures do not block receipt of mail and are not retried automatically.
- Model calls have no automatic retries. Failed draft jobs require the **Retry**
  action; repeating a queue delivery does not call the model again. Fix a missing
  key, unavailable model, or provider error before retrying.
- Setting the provider to **Disabled** stops new AI work, including queued drafts
  that have not called a model yet. A request already in progress may still finish
  and be billed. Existing labels and drafts remain available.

These are per-request limits, not a daily or monthly spending cap. Each new
conversation can trigger a label call and each eligible inbound message can
trigger a draft call. External AI usage is billed by that provider; Worker and
Queue usage still belongs to Cloudflare.

## Optional: connect an AI agent over MCP

The MCP server is built into the same Worker at `/mcp` and is deployed with
every push. Its OAuth state lives in the `OAUTH_KV` namespace that deployment
creates for you. The remaining step is to let MCP clients reach the OAuth
endpoints, which Access blocks because it protects the whole Worker.

1. Open **Settings → General** in Mailroom. The **AI agents (MCP)** card shows
   the server URL and checks whether the OAuth endpoints are publicly
   reachable.
2. If it says Access blocks them, go to
   [**Zero Trust → Access → Applications**](https://dash.cloudflare.com/?to=/:account/one/access-controls/apps)
   and add a **Self-hosted** application with these public hostname
   destinations (use your own hostname, not a Worker destination), with a
   single **Bypass** policy for **Everyone**:

   - `<worker>.<account>.workers.dev/mcp` (also covers the token and
     registration endpoints under `/mcp/oauth/`)
   - `<worker>.<account>.workers.dev/.well-known` (OAuth discovery; its
     location is fixed by the OAuth specifications)

   A path application takes precedence over Worker-level Access. Everything
   else, including the `/authorize` consent page, stays protected. Leave
   **Managed OAuth off**. Add the same two paths for each custom domain you use.
3. Select **Check again** in the card, then add the server URL
   (`https://<worker>.<account>.workers.dev/mcp`) to your MCP client and
   approve it.

On every consent request the Worker verifies the `Cf-Access-Jwt-Assertion`
against the same team, AUD, and signing keys as the web app before issuing a
grant, so anyone allowed into the web app can approve MCP clients. `/mcp` itself
only accepts OAuth access tokens. Each hostname is its own OAuth issuer, so
clients connected via `workers.dev` and a custom domain are authorized
separately.

`MCP_SEND_ENABLED=false` (a Worker variable) removes the send tools from every
client immediately. `MCP_DAILY_SEND_LIMIT` (default 100) caps MCP sends per
Access identity per UTC day.

## Optional: browser notifications

In **Settings → General**, enable browser notifications and grant permission in
each browser. No CLI or manual secret configuration is needed with the deployment
button's default build token.

The deploy script checks for `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_JWK`. If both
are absent, it generates a P-256 key pair and uploads it as Worker Secrets with
the code using `wrangler deploy --secrets-file`. Keys exist only in a restricted
temporary file during deployment, which is removed afterward; they are never
committed to Git or printed by the script. Existing keys are preserved across
deploys so browser subscriptions continue to work. A failed lookup or an
incomplete key pair stops deployment instead of replacing existing keys.

An existing `VAPID_SUBJECT` Secret or Wrangler variable is also preserved.
Otherwise, the script uses the deploying Cloudflare user's email as the Web Push
contact (`mailto:…`). This contact is sent to browser push providers, not email
recipients. Workers Builds' default token includes the required User Details
read permission. For a custom token without access to a user email, or to choose
a different contact, set `VAPID_SUBJECT` in the **build environment** to a
`mailto:` address or HTTPS contact URL before the first deployment. The script
copies it to a runtime Secret. To change an existing contact, update the runtime
`VAPID_SUBJECT` in the Worker's Settings → Variables and Secrets.

Run deployments for a given instance sequentially, especially its first deploy,
so two initial builds cannot generate different key pairs simultaneously.
`npm run vapid:generate` remains available for manual setup or local development.

## Updates

Commit changes to the connected repository's production branch (normally `main`)
and push. Workers Builds runs `npm run deploy`, including pending database
migrations, for each production deployment. Keep your instance's resource IDs,
names, domains, and Access settings when bringing in upstream changes.

Do not point preview branches or a second instance at the production database
and queues. Schema migrations change stored data; a Worker rollback does not
undo a database migration.

### Pull upstream changes

The button created your own repository, so upstream fixes do not arrive
automatically. To update:

```sh
git remote add upstream https://github.com/wong2/cf-mailroom.git
git fetch upstream
git merge upstream/main
git push
```

Keep your own values when conflicts touch instance-specific files:
`wrangler.jsonc` holds your Worker and resource names.

## Troubleshooting

- **Button cannot import the repository:** the upstream repository must be public.
- **A push did not trigger a deployment:** check that the repository is still
  connected under the Worker's **Settings → Build** and that the deploy command
  is `npm run deploy`. Builds only run on the production branch (normally
  `main`).
- **Database migration fails:** verify the build secret `DATABASE_URL`, network
  access, certificate trust, database ownership, and PostgreSQL logs. Stop the
  release if migration fails; do not run the Worker against an incomplete schema.
- **Hyperdrive connection fails:** replace the all-zero ID, verify origin
  credentials and TLS, and confirm query caching is disabled. Local development
  uses the direct local URL instead of the production Hyperdrive config.
- **AI does not run:** select a provider in Settings → General, check its model
  and Base URL, and add the required `AI` binding or `AI_API_KEY` secret. A failed
  draft needs an explicit retry after the configuration is fixed.
- **Missing queue / dead-letter queue:** check both queues exist and the
  consumer names match the producer bindings, especially after renaming them.
- **App loads but replies fail:** check Email Sending access, the paid plan,
  sender-domain verification, and the Inbox's sending address.
- **Inbound mail does not appear:** check Email Routing targets this Worker and
  the recipient has already been added as an Inbox.
- **The setup screen keeps showing after adding variables:** saving variables
  redeploys the Worker; wait a few seconds and select **Check again**. If it
  says the values do not match, copy the values it shows now.
- **MCP OAuth redirects to Access before discovery:** add the Bypass
  application for `/mcp` and `/.well-known` on that hostname. The
  card in **Settings → General** confirms when it works.

## Storage operations and verification

Start local PostgreSQL with `npm run db:start`, then run
`npm run db:migrate:local`, `npm run db:seed:local`, `npm run check`, and
`npm test`. The seed command refuses a non-empty local inbox database. Tests
create and remove only their own randomly named schemas. The development volume
is retained across restarts; `docker compose stop` preserves it.

Before first production use, verify receipt of a MIME message with an attachment,
byte-for-byte download, a reply and new outbound message, full-text search,
MCP reads, and inbox deletion. The local test suite exercises these database
paths with a real PostgreSQL server and mocks paid email/AI delivery. A successful
local build does not verify VPS networking or the production Hyperdrive binding.

Back up the database, including binary content, before future schema changes:

```sh
pg_dump --format=custom --file=mailroom.dump "$DATABASE_URL"
```

Keep encrypted backups away from the VPS and test a restore into a separate
database. Monitor free disk, WAL growth, backup size, and query latency. A Worker
rollback does not undo a PostgreSQL migration. No legacy D1/R2 import is provided
because this instance has never been deployed and has no data to preserve.
