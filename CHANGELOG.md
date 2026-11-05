# Changelog

## 1.1.0 (unreleased)

### Added

- Claude in Excel, Word, PowerPoint and Outlook. Their activity is stored beside Claude Cowork on Work Pulse, marked with the app, from the add-in's OpenTelemetry traces. Command Centre keeps each prompt, the model and tokens, and the name and outcome of each tool call; it never keeps document content or the document's address, only the file name of a document Claude changed. Set it up under **Office agents → Monitoring** in Claude's Organization settings: see [Connect Claude](docs/connect-claude.md#claude-in-office).
- A **By product** panel on the Work Pulse overview compares Cowork with each Office app: app users, sessions, meaningful work, produced something and spend, with an All products row that adds up.
- Claude in Office spend on FinOps and Spend Review, as an estimate priced from the model rates (Office sends no cost). It is never added to Cowork's reported spend or any chargeback total.
- The FinOps and Spend Review report sections include the Office estimate, and the executive and department briefings say how work splits between Cowork and the Office apps when Office was used.
- **Show Claude in Office** under **Admin → Work Pulse** hides the Office panels on installations that do not use it.
- Sample data includes Office activity.
- Each Cowork prompt records where its session ran (on the person's computer or in Anthropic's cloud), so a redacted prompt can be told apart.

### Changed

- The dashboard's "Cowork sessions" card is now "Work sessions", covering Cowork and Claude in Office. It no longer counts Claude Code sessions, which have their own card, so it reads lower where Claude Code is used.
- The bundled, AWS and Azure collector configurations accept Claude in Office's traces, sent from the person's browser.
- When a session has ended, the next page or request takes you straight to sign-in, and back to the same page afterwards.

### Upgrading

- With Docker Compose, the usual update (`docker compose up -d --build`) rebuilds the collector with the new configuration. The database changes apply when the Hub starts.
- If you run the collector yourself, on AWS, Azure or elsewhere, redeploy it from `deploy/aws/otelcol-ecs-config.yaml` or `deploy/azure/otelcol-azure-config.yaml`, or add the `cors` rule, `traces_endpoint` and `traces` pipeline to your own configuration. Without them Claude in Office's activity does not reach the Hub. A load balancer in front of the collector must pass the browser's `OPTIONS` requests through to it.
- To start receiving Claude in Office, open **Office agents → Monitoring** in Claude's Organization settings and select **Copy settings from Cowork**.

## 1.0.0 (2026-10-26)

First public release of Frontier Command Centre.

### What it does

- Shows whether people are moving from simple prompting to handing Claude substantial work and whole processes. Work Pulse grades Claude Cowork work against three tiers you can edit; Developer Pulse measures what Claude Code produces and what it costs.
- Finds recurring processes in everyday Claude activity, tracks how they are adopted and drafts reusable skills from them. The Skills and Connectors Board shows the skills and connectors in use and who owns them.
- FinOps and Spend Review attribute spend to people, departments, cost centres and models, and suggest cheaper ways to do the same work.
- Flags personal data, secrets and risky intent in stored prompts, with alerts, a searchable audit log, a record of who read each prompt, retention and erasure.
- Briefings, reports and a weekly digest, with every number in an AI-written briefing checked against the data.

### How it runs

- Claude Code and Claude Cowork send their activity through OpenTelemetry to a collector you run. On Claude for Enterprise, Claude Chat is read from Anthropic's Compliance API.
- Docker Compose runs everything on one computer or server. The docs also describe running it on AWS or Azure.
- Sample data from a fictional company lets you explore every page before connecting Claude.

### Not yet included

- Anthropic Analytics API and Admin API integrations, which are on the roadmap.
- Dev Framework Alignment is an example of how engineering indicators could look; it has not been fully tested and is switched off by default.
