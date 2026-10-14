# Verification

- `npm run check` (tsc) and `npm test` (node --test, strip-types only: avoid TS parameter properties/enums in modules imported by tests).
- Local UI: `npx vite --port <free port>` (5173 may be taken by another project). `wrangler.dev.jsonc` has no `AI` binding. AI is disabled by default; external AI works locally with `AI_API_KEY` in `.dev.vars` and provider settings in the UI. Mock provider requests in tests to avoid paid calls.

# Release process

Shipping happens by pushing to the GitHub `main` branch, which triggers the automatic build and deploy.

- When the user asks to ship or deploy, finish the necessary checks, commit the changes, run `git push`, then check the automatic deployment result.
- Do not run `npm run deploy`, `wrangler deploy`, or publish through the Cloudflare API unless the user explicitly asks for a manual deploy.
- When the user asks to ship and push, the push is the release step. Do not deploy manually before pushing.
