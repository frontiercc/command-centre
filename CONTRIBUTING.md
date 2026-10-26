# Contributing to Frontier Command Centre

Thank you for helping. Frontier Command Centre was created by Lee James and is licensed under the Apache License 2.0. It is maintained by Lee James (@frontiercommandcentre). Before your first pull request is merged, you sign the [Contributor Licence Agreement](CLA.md).

For anything larger than a small fix, open an issue first so we can agree the approach before you write the code.

## Get it running

You need Node.js 22 or later, Docker and Git.

```bash
git clone https://github.com/frontiercc/command-centre.git
cd command-centre
npm ci
node scripts/setup.cjs
```

The last command creates `.env` with a random `CCC_ENCRYPTION_KEY`, `OTEL_ENDPOINT_SECRET`, `CCC_COLLECTOR_TOKEN` and database password (`CCC_PG_PASSWORD`), and never changes an existing `.env`. Docker Compose will not start without the two tokens, and the Hub will not start in Docker without its own encryption key. If you are working on anything that calls Claude, add your Claude API key under Admin → Access & Keys once you have signed in.

**To run the whole product as users see it**, use Docker Compose. Docker Compose starts PostgreSQL, the collector and the Hub, with the Hub on http://localhost:3001:

```bash
docker compose up -d --build
```

**To work on the code with live reloading**, run PostgreSQL in a container and the Hub on your machine:

```bash
docker run -d --name ccc-dev-pg -e POSTGRES_USER=ccc -e POSTGRES_PASSWORD=ccc-local-dev -e POSTGRES_DB=ccc -p 5432:5432 postgres:16
```

In `.env`, set `DATABASE_URL=postgresql://ccc:ccc-local-dev@127.0.0.1:5432/ccc`, then run `npm run dev` and open http://localhost:3000. The schema is created on first start.

## Make a change

Work on a branch, keep the change focused, and follow the conventions below. [CLAUDE.md](CLAUDE.md) sets out the same conventions in more detail, written for AI assistants.

- **Schema changes** go in `lib/db/migrations-pg/` and are registered in `meta/_journal.json`.
- **Every API route makes an explicit role decision.** A session alone is not authorisation, and `test/api-route-authz-coverage.test.ts` fails on a route without one.
- **A new configuration key** that the interface saves must be added to `allowedKeys` in `app/api/config/route.ts`. A new secret must be registered in `lib/config-secrets.ts`.
- **Anthropic clients** are created with `createAnthropicClient()` from `lib/anthropic/client.ts`, never directly.
- **Errors returned to a caller** carry fixed text. Use `lib/api/errors.ts`, and never return an exception's message.
- **Interface text** uses British English and plain wording, with no em dashes.

## Test it

Tests run against PostgreSQL. With Docker running, each test file starts its own database container. To reuse a running server instead, which is much faster, point `CCC_TEST_PG_URL` at it; each test file then gets its own throwaway database:

```bash
CCC_TEST_PG_URL=postgresql://ccc:ccc-local-dev@127.0.0.1:5432/postgres npx vitest run test/<file>.test.ts
```

In PowerShell:

```powershell
$env:CCC_TEST_PG_URL="postgresql://ccc:ccc-local-dev@127.0.0.1:5432/postgres"; npx vitest run test/<file>.test.ts
```

New features and bug fixes come with automated tests that would fail without the change.

Before you open a pull request, run the tests for what you changed, then:

```bash
npx tsc --noEmit
npm run lint
npm run build
```

If you add, remove or update a dependency, also run `npm run notices` and commit the updated `THIRD-PARTY-NOTICES.md`.

CI runs lint, the full test suite and the build (which includes the type check) on every pull request, and checks that `THIRD-PARTY-NOTICES.md` matches the dependencies.

## The rules that keep the numbers honest

Command Centre is only useful if people can trust its figures. Four rules protect that, and a pull request that breaks one will not be merged.

1. **Measured and judged are never mixed.** A figure read from telemetry is measured. A figure produced by a model, or by an assumption such as minutes saved per task, is judged or estimated. They are labelled differently in the interface (dark blue for measured, sky blue for AI-judged or estimated, as the colour key at the top of pages that show both says) and are never added together.
2. **Not measured is never zero.** When a value cannot be measured, return `null` and show "not measured". An unpriced model has no cost, not a cost of $0.
3. **A model never writes a number that is stored or shown.** Figures are computed in code and passed to the model. Model-written text is checked against those figures: a sentence with a number of its own is removed, and a briefing that cannot be repaired is withheld.
4. **No person-level data leaves through the Metrics Connector.** The export API and the MCP server carry organisation-wide figures only.

## Sign the Contributor Licence Agreement

Before your first pull request can be merged, you sign the [Contributor Licence Agreement](CLA.md). You keep the copyright in your work; the agreement lets Lee James distribute it under the Apache License 2.0 and any other licence he chooses. A check on every pull request asks you to sign by replying with one comment, once. Later pull requests are covered automatically.

## Using AI to contribute

You are welcome to use Claude or another assistant. Point it at [CLAUDE.md](CLAUDE.md), which tells it how this codebase works and what it must not do. Five rules apply to every contribution, however it was written:

1. You answer for every line, and you can explain any of it in review.
2. The tests pass, including the ones that protect the four rules above.
3. The pull request is small and does one thing.
4. If an assistant wrote a substantial part of the change, say so in the pull request description.
5. Maintainers may close low-effort or bulk pull requests without a full review.

## Pull requests

Fill in the pull request template: what the change does, why, and how you tested it. Add a screenshot for any change to the interface. Keep unrelated changes for separate pull requests.

## How we review

Command Centre is maintained by Lee James, on a best-effort basis with no service level. Ask questions and share ideas in [Discussions](https://github.com/frontiercc/command-centre/discussions); report bugs and request features in Issues. Issues stay open until they are fixed, answered or declined with a reason. Requests we are unlikely to build soon are labelled "help wanted", so anyone can pick them up.

To report a security issue, follow [SECURITY.md](SECURITY.md). Do not open a public issue.
