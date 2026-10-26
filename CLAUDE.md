# CLAUDE.md

Guidance for Claude, or any AI assistant, helping someone contribute to Frontier Command Centre. Read it before changing code. [CONTRIBUTING.md](CONTRIBUTING.md) is the human version.

## What Command Centre is

A single Next.js 15 (App Router) application, backed by PostgreSQL through Drizzle, styled with Tailwind, and run in Docker. Command Centre receives OpenTelemetry from Claude Code and Claude Cowork, and pulls Claude Chat from Anthropic's Compliance API; pulls from the Analytics and Admin APIs are on the roadmap. Command Centre measures whether the work people hand to Claude is becoming deeper and more valuable, and governs what it stores.

Command Centre is a downstream observer. Telemetry arrives after a prompt has reached Claude, so the product can flag, alert on and restrict access to what it stores, but can never block, alter or delay a prompt.

## Where things are

- `app/` holds pages, and `app/api/` the API routes.
- `components/` holds React components. The design kit is `components/precision/ui.tsx`.
- `lib/` holds business logic. Telemetry receivers are in `lib/otel/`, and the database schema is `lib/db/schema.pg.ts`.
- `lib/db/migrations-pg/` holds migrations, each registered in `meta/_journal.json`.
- `test/` holds Vitest tests, which all run on PostgreSQL. Use `createTestDatabase()` from `test/helpers/db.ts`.
- `docs/` holds the product, security and AI data flow documentation, with running it on AWS or Azure in `docs/running-in-azure-or-aws.md` and the cloud build files in `deploy/`.
- `@/` maps to the repository root, for example `@/lib/db/client`.

## Commands

```bash
npm ci
npm run dev        # dev server on port 3000; needs DATABASE_URL
npm run lint
npx tsc --noEmit
npm run build
CCC_TEST_PG_URL=postgresql://ccc:ccc-local-dev@127.0.0.1:5432/postgres npx vitest run test/<file>.test.ts
```

Name test files explicitly. Without `CCC_TEST_PG_URL`, every test file starts its own PostgreSQL container.

## Setting Command Centre up for someone

When someone asks you to install or set up Command Centre, follow the Quick start in [README.md](README.md) exactly, in order, and nothing else.

- Use the README's commands for their system: PowerShell on Windows, Terminal on macOS and Linux.
- Create `.env` only with the setup command. Never edit or overwrite an existing `.env`.
- Run `docker compose up -d --build` as a background task. Tell them it has started and takes about four minutes the first time, check on it about every 30 seconds and say what it is doing, and tell them as soon as it finishes, without waiting to be asked.
- Then wait until http://localhost:3001 answers, find the one-time setup token in the Hub's log, as the README shows, and give it to them.
- Load sample data only after they say their admin account exists, and only if they want it.
- Run the sample data load as a background task, so the person is never left waiting on a silent command. Tell them it has started and takes about two minutes, check on it about every 30 seconds and say what it is doing, and report the result as soon as it finishes, without waiting to be asked.
- When you finish, tell them the folder you installed into, and that Admin → Ingestion in Command Centre shows the collector address and bearer token, with the Claude settings ready to copy.
- If a step fails, stop and report the error exactly. Do not work around it, change ports or edit files to make it pass.

## Rules you must follow

These protect the product's credibility. A change that breaks one will be rejected.

1. **Keep measured and judged apart.** Figures from telemetry are measured, shown in dark blue. Figures from a model or an assumption are judged or estimated, shown in sky blue. Never add them together.
2. **Not measured is null, never zero.** Return `null` and show "not measured". An unpriced model has no cost, not $0.
3. **A model never writes a number that is stored or shown.** Compute figures in code and pass them in. Model-written text is checked against them.
4. **No person-level data in the metrics connector** (`lib/connector/`, `/api/export/`, `/api/mcp`). Organisation-wide figures only.
5. **Never store Claude's replies.** Prompts are stored; assistant text is not.
6. **Every API route makes an explicit role decision.** A session is not authorisation. Prompt text goes through `gateContentRead` in `lib/auth/content-access.ts`. `test/api-route-authz-coverage.test.ts` enforces this.
7. **New API routes** export `dynamic = 'force-dynamic'`, return JSON, and report errors with `errorResponse` from `lib/api/errors.ts`. Never return an exception's message to the caller.
8. **Configuration keys** the interface saves go in `allowedKeys` in `app/api/config/route.ts`. Secrets are registered in `lib/config-secrets.ts`.
9. **Anthropic clients** are created with `createAnthropicClient()` from `lib/anthropic/client.ts`.
10. **Interface text** is British English, plain and short, with no em dashes.

## Before you finish

- Run the type check, lint, the build, and the tests for every file you touched.
- Keep the change small and focused on one thing.
- Tell the person the CLA check will ask them to sign the Contributor Licence Agreement once, on their first pull request, and to note in the pull request that an assistant helped.
- Do not invent behaviour, figures or file paths. Read the code first, and say so when you are unsure.
