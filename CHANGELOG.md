# Changelog

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
