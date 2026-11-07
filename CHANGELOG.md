# Changelog

## 1.2.0 (2026-11-06)

### Added

- Claude in Google Sheets, Docs and Slides. The Claude add-on for Google Workspace reports through the same **Office agents → Monitoring** setting as Claude in Office, and Command Centre now shows its work as its own products. The Work Pulse **By product** panel groups the apps under Cowork, Claude in Office (Excel, Word, PowerPoint, Outlook) and Claude in Google (Sheets, Docs, Slides). The FinOps and Spend Review estimate panels, the Audit Log app filter and labels, the FinOps and Spend Review report sections and the executive and department briefings all name the Google apps. Google spend is an estimate priced from the model rates, like Office spend, and is never added to any total. Google sends no document name, so Google work lists no file names.
- Sample data includes Google Sheets, Docs and Slides activity.

### Fixed

- Google Workspace work was filed under Microsoft Office: Google Sheets showed as Excel, Google Slides as PowerPoint and Google Docs as Word. Command Centre now reads which vendor sent each event. On upgrade, stored sessions that used Google Apps Script move to the Google apps; a Google Docs session with no Apps Script call cannot be told apart after the fact and stays under Word.

### Changed

- **Show Claude in Office** under **Admin → Work Pulse** is now **Show Claude in Office and Google**, and hides both groups.

## 1.1.1 (2026-11-06)

### Fixed

- The Audit Log's Surface column shows a Claude in Office prompt's app on its own (Excel, Word, PowerPoint or Outlook), not "Cowork" beside it.

## 1.1.0 (2026-11-05)

### Added

- Claude in Excel, Word, PowerPoint and Outlook. Their activity is stored beside Claude Cowork on Work Pulse, marked with the app, from the add-in's OpenTelemetry traces. Command Centre keeps each prompt, the model and tokens, and the name and outcome of each tool call; it never keeps document content or the document's address, only the file name of a document Claude changed. Set it up under **Office agents → Monitoring** in Claude's Organization settings: see [Connect Claude](docs/connect-claude.md#claude-in-office).
- A **By product** panel on the Work Pulse overview compares Cowork with each Office app: app users, sessions, meaningful work, produced something and spend, with an All products row that adds up. An app's meaningful work share shows once it has five judged prompts, and its produced something share once it has five sessions.
- Claude in Office spend on FinOps and Spend Review, as an estimate priced from the model rates (Office sends no cost). It is never added to Cowork's reported spend or any chargeback total.
- The FinOps and Spend Review report sections include the Office estimate, and the executive and department briefings say how work splits between Cowork and the Office apps when Office was used.
- The Audit Log labels each Claude in Office prompt with its app, and a new app filter shows Cowork alone, all of Claude in Office, or one Office app.
- **Show Claude in Office** under **Admin → Work Pulse** hides the Office panels on installations that do not use it.
- Sample data includes Office activity.
- Every published Claude model has a built-in price, including Opus 5.5, Sonnet 5.5 and Haiku 5.5, Mythos 5.1 and 5, Sonnet 4.5, and older models still served on Bedrock or Google Cloud. Prices saved on **Admin → Developer Pulse** still win. Spend on these models, left out as not priced before, now counts; Haiku 5.5 is priced at its rate for prompts up to 100,000 tokens.
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
